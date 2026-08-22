import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import {
  demoDisabledResponse,
  isDemoEnabled,
} from "../_shared/demo-access";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// SECTION 1: Types shared by the chat API
// -----------------------------------------------------------------------------

type Provider = "openai" | "gemini";
type MessageRole = "user" | "assistant";

type ChatMessage = {
  role: MessageRole;
  content: string;
};

type ChatRequest = {
  provider: Provider;
  messages: ChatMessage[];
};

// These events are streamed from this API route to the browser.
type ChatStreamEvent =
  | {
      type: "meta";
      provider: Provider;
      model: string;
      requestId: string;
    }
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "done";
      latencyMs: number;
    }
  | {
      type: "error";
      message: string;
    };

type SendStreamEvent = (event: ChatStreamEvent) => void;

class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
}

// -----------------------------------------------------------------------------
// SECTION 2: Model configuration
// -----------------------------------------------------------------------------

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const LLM_DEBUG = process.env.NODE_ENV === "development";

// These limits are enforced on the server. Browser attributes such as the
// textarea's maxLength improve the UI, but a direct HTTP client can ignore them.
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_TOTAL_CHARACTERS = 24_000;

const SYSTEM_INSTRUCTIONS = `
You are a concise and helpful learning coach.

Your job is to:
- Answer the user's question clearly.
- Prefer short explanations.
- Use examples when they improve understanding.
- Ask a follow-up question only when it is genuinely useful.
`.trim();

// -----------------------------------------------------------------------------
// SECTION 3: Read and validate the request coming from the browser
// -----------------------------------------------------------------------------

async function readLimitedJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";

  if (!contentType.startsWith("application/json")) {
    throw new ChatRequestError(
      "Content-Type must be application/json.",
      415,
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new ChatRequestError(
      `Request body exceeds the ${MAX_REQUEST_BYTES}-byte limit.`,
      413,
    );
  }

  if (!request.body) {
    throw new ChatRequestError("A JSON request body is required.", 400);
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let jsonText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        break;
      }

      receivedBytes += value.byteLength;

      if (receivedBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ChatRequestError(
          `Request body exceeds the ${MAX_REQUEST_BYTES}-byte limit.`,
          413,
        );
      }

      jsonText += decoder.decode(value, { stream: true });
    }

    jsonText += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    throw new ChatRequestError("Request body contains invalid JSON.", 400);
  }
}

function validateChatRequest(value: unknown): ChatRequest {
  if (!value || typeof value !== "object") {
    throw new ChatRequestError("Expected a JSON object.", 400);
  }

  const request = value as Partial<ChatRequest>;

  if (request.provider !== "openai" && request.provider !== "gemini") {
    throw new ChatRequestError(
      'Provider must be either "openai" or "gemini".',
      400,
    );
  }

  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new ChatRequestError(
      "At least one conversation message is required.",
      400,
    );
  }

  if (request.messages.length > MAX_MESSAGES) {
    throw new ChatRequestError(
      `Conversation exceeds the ${MAX_MESSAGES}-message limit.`,
      400,
    );
  }

  let totalCharacters = 0;

  for (const [index, message] of request.messages.entries()) {
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.trim().length === 0
    ) {
      throw new ChatRequestError(
        `Message ${index + 1} must have a valid role and non-empty content.`,
        400,
      );
    }

    if (message.content.length > MAX_MESSAGE_CHARACTERS) {
      throw new ChatRequestError(
        `Message ${index + 1} exceeds the ${MAX_MESSAGE_CHARACTERS}-character limit.`,
        400,
      );
    }

    totalCharacters += message.content.length;
  }

  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    throw new ChatRequestError(
      `Conversation exceeds the ${MAX_TOTAL_CHARACTERS}-character limit.`,
      400,
    );
  }

  if (request.messages.at(-1)?.role !== "user") {
    throw new ChatRequestError(
      "The final conversation message must come from the user.",
      400,
    );
  }

  return request as ChatRequest;
}

function readApiKey(name: "OPENAI_API_KEY" | "GEMINI_API_KEY"): string {
  const value = process.env[name];

  if (!value || value.startsWith("replace-with-")) {
    throw new Error(`${name} is not configured in .env.local`);
  }

  return value;
}

// -----------------------------------------------------------------------------
// SECTION 4: Convert our events into Server-Sent Events
// -----------------------------------------------------------------------------

const encoder = new TextEncoder();

function encodeSseEvent(event: ChatStreamEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

function debugLog(requestId: string, message: string, details: object) {
  if (LLM_DEBUG) {
    console.info(`[chat:${requestId}] ${message}`, details);
  }
}

// -----------------------------------------------------------------------------
// SECTION 5: OpenAI streaming integration
// -----------------------------------------------------------------------------

async function streamOpenAi(
  messages: ChatMessage[],
  send: SendStreamEvent,
  requestId: string,
  signal: AbortSignal,
): Promise<void> {
  const client = new OpenAI({
    apiKey: readApiKey("OPENAI_API_KEY"),
  });

  const stream = await client.responses.create(
    {
      model: OPENAI_MODEL,

      instructions: SYSTEM_INSTRUCTIONS,

      input: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),

      max_output_tokens: 800,

      // GPT-5 output tokens include internal reasoning tokens. Minimal effort is
      // appropriate for this low-latency learning chat and leaves more of the
      // output budget available for visible text.
      reasoning: {
        effort: "minimal",
      },

      // This changes the OpenAI response from one complete object
      // into a stream of events.
      stream: true,
    },
    { signal },
  );

  let deltaCount = 0;
  let textCharacters = 0;
  const eventCounts: Record<string, number> = {};

  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

    // OpenAI emits several event types.
    // We only need the generated text pieces.
    if (event.type === "response.output_text.delta") {
      deltaCount += 1;
      textCharacters += event.delta.length;

      send({
        type: "delta",
        text: event.delta,
      });
    }

    // Normally the text arrives through delta events. This documented final
    // event is a safe fallback if an intermediary delivers only final text.
    if (
      event.type === "response.output_text.done" &&
      textCharacters === 0 &&
      event.text
    ) {
      textCharacters = event.text.length;

      debugLog(requestId, "openai.final-text-fallback", {
        textCharacters,
      });

      send({
        type: "delta",
        text: event.text,
      });
    }

    if (event.type === "response.completed") {
      const usage = event.response.usage;

      debugLog(requestId, "openai.completed", {
        status: event.response.status,
        deltaCount,
        textCharacters,
        inputTokens: usage?.input_tokens,
        cachedInputTokens: usage?.input_tokens_details.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details.reasoning_tokens,
        eventCounts,
      });
    }

    if (event.type === "response.incomplete") {
      const reason = event.response.incomplete_details?.reason || "unknown";
      const usage = event.response.usage;

      debugLog(requestId, "openai.incomplete", {
        reason,
        deltaCount,
        textCharacters,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details.reasoning_tokens,
        eventCounts,
      });

      if (textCharacters === 0) {
        throw new Error(
          `OpenAI returned no visible text because the response was incomplete (${reason}).`,
        );
      }
    }

    if (event.type === "response.failed") {
      throw new Error(
        event.response.error?.message || "OpenAI response generation failed.",
      );
    }
  }

  if (textCharacters === 0) {
    debugLog(requestId, "openai.no-text", {
      eventCounts,
    });

    throw new Error(
      "OpenAI completed without a text event. Check the matching server request log.",
    );
  }
}

// -----------------------------------------------------------------------------
// SECTION 6: Gemini streaming integration
// -----------------------------------------------------------------------------

async function streamGemini(
  messages: ChatMessage[],
  send: SendStreamEvent,
  signal: AbortSignal,
): Promise<void> {
  const client = new GoogleGenAI({
    apiKey: readApiKey("GEMINI_API_KEY"),
  });

  const stream = await client.models.generateContentStream({
    model: GEMINI_MODEL,

    contents: messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: message.content,
        },
      ],
    })),

    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
      maxOutputTokens: 300,
      abortSignal: signal,
    },
  });

  for await (const chunk of stream) {
    const text = chunk.text;

    if (text) {
      send({
        type: "delta",
        text,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// SECTION 7: Create one normalized browser stream
// -----------------------------------------------------------------------------

function createChatStream(
  provider: Provider,
  messages: ChatMessage[],
  requestSignal: AbortSignal,
): Response {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID().slice(0, 8);
  const model = provider === "openai" ? OPENAI_MODEL : GEMINI_MODEL;

  debugLog(requestId, "request.started", {
    provider,
    model,
    messageCount: messages.length,
    inputCharacters: messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
  });

  const providerAbortController = new AbortController();
  const abortProvider = () => providerAbortController.abort();
  requestSignal.addEventListener("abort", abortProvider, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send: SendStreamEvent = (event) => {
        if (!providerAbortController.signal.aborted) {
          controller.enqueue(encodeSseEvent(event));
        }
      };

      send({
        type: "meta",
        provider,
        model,
        requestId,
      });

      try {
        if (provider === "openai") {
          await streamOpenAi(
            messages,
            send,
            requestId,
            providerAbortController.signal,
          );
        } else {
          await streamGemini(
            messages,
            send,
            providerAbortController.signal,
          );
        }

        const latencyMs = Date.now() - startedAt;

        debugLog(requestId, "request.completed", {
          provider,
          model,
          latencyMs,
        });

        send({
          type: "done",
          latencyMs,
        });
      } catch (error) {
        if (providerAbortController.signal.aborted) {
          debugLog(requestId, "request.aborted", { provider, model });
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "The selected LLM request failed.";

        console.error(`[chat:${requestId}] request.failed`, {
          provider,
          model,
          message,
        });

        send({
          type: "error",
          message,
        });
      } finally {
        requestSignal.removeEventListener("abort", abortProvider);

        try {
          controller.close();
        } catch {
          // The browser may already have cancelled its response reader.
        }
      }
    },

    cancel() {
      providerAbortController.abort();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

// -----------------------------------------------------------------------------
// SECTION 8: POST /api/chat
// -----------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!isDemoEnabled()) {
    return demoDisabledResponse();
  }

  try {
    const body = await readLimitedJsonBody(request);
    const chatRequest = validateChatRequest(body);

    return createChatStream(
      chatRequest.provider,
      chatRequest.messages,
      request.signal,
    );
  } catch (error) {
    if (error instanceof ChatRequestError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "INVALID_CHAT_REQUEST",
        },
        {
          status: error.status,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    console.error("Chat API error:", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The chat request could not be processed.",
      },
      {
        status: 500,
      },
    );
  }
}
