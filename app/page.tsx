"use client";

import { CommitStrategy, useScribe } from "@elevenlabs/react";
import { FormEvent, useEffect, useRef, useState } from "react";

/* ========================================================================== */
/* SECTION 1: SHARED CHAT DATA                                                 */
/* ========================================================================== */
/*
 * These small types describe what the browser sends to and receives from our
 * backend. They live here for now so the complete text-chat flow can be read
 * from top to bottom without jumping through several files.
 */

type Provider = "openai" | "gemini";
type MessageRole = "user" | "assistant";
type TtsStatus = "idle" | "generating" | "playing";

type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  timestamp?: string;
  provider?: Provider;
  model?: string;
  latencyMs?: number;
  interrupted?: boolean;
  inputMode?: "text" | "voice";
};

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

type TtsSocketMessage = {
  audio?: string | null;
  context_id?: string;
  contextId?: string;
  is_final?: boolean;
  isFinal?: boolean;
  message?: string;
};

type StreamingSpeechController = {
  addText: (text: string) => void;
  finish: () => void;
};

const PROVIDERS: Array<{
  id: Provider;
  name: string;
  model: string;
  note: string;
}> = [
  {
    id: "openai",
    name: "OpenAI",
    model: "GPT-5 nano",
    note: "Paid API; optimized for low-cost text generation.",
  },
  {
    id: "gemini",
    name: "Google",
    model: "Gemini 3.5 Flash-Lite",
    note: "Free-tier option. Do not submit sensitive information.",
  },
];

const INITIAL_MESSAGE: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hello! Type a message or start a voice session. Once voice is active, ask follow-up questions naturally without pressing the button again.",
};

function formatMessageTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// CloudFront signs requests to the private Lambda Function URL. For POST
// requests, Lambda requires this SHA-256 payload header so CloudFront can sign
// the exact body it forwards. The same helper also works during local testing.
async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type HashedPostOptions = Omit<RequestInit, "method" | "body" | "headers"> & {
  body?: string;
  headers?: HeadersInit;
};

async function postWithPayloadHash(
  url: string,
  options: HashedPostOptions = {},
): Promise<Response> {
  const { body = "", headers: initialHeaders, ...requestOptions } = options;
  const headers = new Headers(initialHeaders);

  headers.set("x-amz-content-sha256", await sha256Hex(body));

  return fetch(url, {
    ...requestOptions,
    method: "POST",
    headers,
    body: body || undefined,
  });
}

/* ========================================================================== */
/* SECTION 2: TEXT CHAT PAGE                                                   */
/* ========================================================================== */

export default function HomePage() {
  const [provider, setProvider] = useState<Provider>("openai");
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asrError, setAsrError] = useState<string | null>(null);
  const [isStartingMicrophone, setIsStartingMicrophone] = useState(false);
  const [isVoiceSessionActive, setIsVoiceSessionActive] = useState(false);
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>("idle");
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [isDemoEnabled, setIsDemoEnabled] = useState<boolean | null>(null);

  // These browser objects should not trigger a React render, so refs are a
  // clearer fit than state. They also let the Stop button reach the active
  // WebSocket and audio player immediately.
  const ttsSocketRef = useRef<WebSocket | null>(null);
  const ttsContextIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const primedAudioContextRef = useRef<AudioContext | null>(null);
  const queuedAudioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const ttsOperationRef = useRef(0);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeChatTurnRef = useRef(0);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  const voiceSessionActiveRef = useRef(false);
  const voiceBargeInTriggeredRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadDemoStatus() {
      try {
        const response = await fetch("/api/demo-status", {
          cache: "no-store",
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Demo status returned HTTP ${response.status}.`);
        }

        const status = (await response.json()) as { enabled?: boolean };
        setIsDemoEnabled(status.enabled === true);
      } catch (statusError) {
        if (!controller.signal.aborted) {
          // The UI also fails closed when it cannot verify the server switch.
          setIsDemoEnabled(false);
          console.error("[demo-status] check.failed", statusError);
        }
      }
    }

    void loadDemoStatus();

    return () => controller.abort();
  }, []);

  /* ------------------------------------------------------------------------ */
  /* SECTION 3: ELEVENLABS REALTIME ASR                                       */
  /* ------------------------------------------------------------------------ */
  /*
   * Realtime Scribe owns the browser-to-ElevenLabs WebSocket. Partial text is
   * displayed while the user speaks. VAD commits the turn after one second of
   * silence, and that committed transcript is submitted directly to the LLM.
   */

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    vadSilenceThresholdSecs: 1,

    onPartialTranscript: ({ text }) => {
      const partialText = text.trim();
      const responseIsActive =
        chatAbortControllerRef.current !== null ||
        ttsSocketRef.current !== null ||
        queuedAudioSourcesRef.current.size > 0;

      if (
        !partialText ||
        !voiceSessionActiveRef.current ||
        !responseIsActive ||
        voiceBargeInTriggeredRef.current
      ) {
        return;
      }

      // A partial arrives before VAD commits the complete question. Use it to
      // stop the coach immediately, then wait for the committed transcript.
      voiceBargeInTriggeredRef.current = true;
      interruptActiveTurn("voice-partial-detected");
      console.info("[voice-turn] barge-in.detected", {
        partialCharacters: partialText.length,
      });
    },

    onCommittedTranscript: ({ text }) => {
      const committedText = text.trim();

      if (!committedText || !voiceSessionActiveRef.current) {
        return;
      }

      const responseWasAlreadyInterrupted =
        voiceBargeInTriggeredRef.current;
      voiceBargeInTriggeredRef.current = false;
      setDraft("");

      console.info("[voice-turn] vad.committed", {
        characters: committedText.length,
      });

      void submitQuestion(
        committedText,
        "voice",
        responseWasAlreadyInterrupted,
      );
    },

    onConnect: () => {
      voiceSessionActiveRef.current = true;
      setIsVoiceSessionActive(true);
      console.info("[asr] connected", {
        model: "scribe_v2_realtime",
      });
    },

    onDisconnect: () => {
      voiceSessionActiveRef.current = false;
      voiceBargeInTriggeredRef.current = false;
      setIsVoiceSessionActive(false);
      console.info("[asr] disconnected");
    },

    onError: (scribeError) => {
      const message =
        scribeError instanceof Error
          ? scribeError.message
          : "Realtime transcription failed.";

      setAsrError(message);
      console.error("[asr] failed", { message });
    },
  });

  /* ------------------------------------------------------------------------ */
  /* SECTION 4: MICROPHONE START AND STOP                                      */
  /* ------------------------------------------------------------------------ */

  async function startMicrophone() {
    if (isStartingMicrophone) {
      return;
    }

    if (scribe.isConnected) {
      endVoiceSession();
      return;
    }

    setAsrError(null);
    setIsStartingMicrophone(true);
    voiceBargeInTriggeredRef.current = false;

    // Starting voice mode is a session-level action. The microphone and ASR
    // WebSocket remain active for every follow-up until the user ends it.
    interruptActiveTurn("voice-session-started");

    try {
      // Audio is authorized during this click and reused after VAD. Without
      // this priming step, some browsers may block delayed automatic playback.
      const primedAudioContext = new AudioContext();
      await primedAudioContext.resume();
      primedAudioContextRef.current = primedAudioContext;

      // Ask our server for a temporary token. The permanent API key remains
      // on the server and is never included in this browser bundle.
      const response = await postWithPayloadHash(
        "/api/elevenlabs/scribe-token",
      );

      const data = (await response.json()) as {
        token?: string;
        error?: string;
      };

      if (!response.ok || !data.token) {
        throw new Error(data.error || "The ASR token request failed.");
      }

      // This is the exact point where the browser asks for microphone access
      // and opens its Realtime Scribe connection.
      await scribe.connect({
        token: data.token,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "The microphone could not be started.";

      setAsrError(message);
      console.error("[asr] start.failed", { message });
      stopSpeaking();
    } finally {
      setIsStartingMicrophone(false);
    }
  }

  function endVoiceSession() {
    voiceSessionActiveRef.current = false;
    voiceBargeInTriggeredRef.current = false;
    setIsVoiceSessionActive(false);
    scribe.disconnect();
    interruptActiveTurn("voice-session-ended");
    console.info("[voice-turn] session.ended");
  }

  /* ------------------------------------------------------------------------ */
  /* SECTION 5: ELEVENLABS TEXT TO SPEECH AND BROWSER AUDIO                   */
  /* ------------------------------------------------------------------------ */
  /*
   * Stage 3 deliberately waits for a complete LLM answer. Clicking Speak asks
   * our server for a one-use token, opens a browser-to-ElevenLabs WebSocket,
   * collects the returned MP3 chunks, and plays them with the Web Audio API.
   * Sentence-by-sentence streaming will be a separate learning stage.
   */

  function stopSpeaking() {
    // Invalidate every callback belonging to the previous TTS request.
    ttsOperationRef.current += 1;

    const socket = ttsSocketRef.current;
    ttsSocketRef.current = null;
    const contextId = ttsContextIdRef.current;
    ttsContextIdRef.current = null;

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      if (socket.readyState === WebSocket.OPEN && contextId) {
        // ElevenLabs cancellation is context-scoped. Closing this context
        // stops the server from generating more audio for the old response.
        socket.send(
          JSON.stringify({
            context_id: contextId,
            close_context: true,
          }),
        );
      }

      socket.close();
    }

    for (const queuedSource of queuedAudioSourcesRef.current) {
      try {
        queuedSource.stop();
      } catch {
        // A scheduled source may already have completed.
      }

      queuedSource.disconnect();
    }

    queuedAudioSourcesRef.current.clear();

    const audioContext = audioContextRef.current;

    if (
      !voiceSessionActiveRef.current &&
      audioContext &&
      audioContext.state !== "closed"
    ) {
      audioContextRef.current = null;
      void audioContext.close();
    }

    const primedAudioContext = primedAudioContextRef.current;

    if (
      !voiceSessionActiveRef.current &&
      primedAudioContext &&
      primedAudioContext.state !== "closed"
    ) {
      primedAudioContextRef.current = null;
      void primedAudioContext.close();
    }

    setTtsStatus("idle");
  }

  /* ------------------------------------------------------------------------ */
  /* SECTION 6: INTERRUPT THE ACTIVE LLM AND TTS TURN                          */
  /* ------------------------------------------------------------------------ */
  /*
   * Each turn receives a monotonically increasing ID. Cancelling increments
   * the ID, so late network callbacks from the old turn can be recognized and
   * ignored even if a provider sends one last chunk after cancellation.
   */

  function interruptActiveTurn(reason: string) {
    const interruptedAssistantId = activeAssistantMessageIdRef.current;
    const hadActiveChat = chatAbortControllerRef.current !== null;
    const hadActiveSpeech = ttsStatus !== "idle";

    activeChatTurnRef.current += 1;
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
    activeAssistantMessageIdRef.current = null;
    stopSpeaking();

    if (interruptedAssistantId) {
      setMessages((currentMessages) =>
        currentMessages.map((message) =>
          message.id === interruptedAssistantId
            ? {
                ...message,
                content:
                  message.content ||
                  "Response interrupted before text was received.",
                interrupted: true,
              }
            : message,
        ),
      );
    }

    setIsSending(false);

    if (hadActiveChat || hadActiveSpeech) {
      console.info("[turn] interrupted", {
        reason,
        hadActiveChat,
        hadActiveSpeech,
      });
    }
  }


  /* ------------------------------------------------------------------------ */
  /* SECTION 7: STREAM COMPLETED LLM SENTENCES INTO ELEVENLABS                */
  /* ------------------------------------------------------------------------ */
  /*
   * The LLM still arrives as small text deltas. We do not send those tiny
   * fragments directly to TTS because that produces unnatural speech. Instead,
   * addText() keeps a short buffer and sends only completed sentences. Incoming
   * audio chunks are decoded and scheduled one after another in the browser.
   */

  async function startSentenceStreamingSpeech(
    reusePrimedAudioContext = false,
  ): Promise<StreamingSpeechController | null> {
    if (!reusePrimedAudioContext) {
      stopSpeaking();
    }

    const operationId = ttsOperationRef.current;

    setTtsError(null);
    setTtsStatus("generating");
    const primedAudioContext = voiceSessionActiveRef.current
      ? primedAudioContextRef.current
      : reusePrimedAudioContext
        ? primedAudioContextRef.current
        : null;
    primedAudioContextRef.current = null;
    const sessionAudioContext = voiceSessionActiveRef.current
      ? audioContextRef.current
      : null;
    const audioContext =
      primedAudioContext && primedAudioContext.state !== "closed"
        ? primedAudioContext
        : sessionAudioContext && sessionAudioContext.state !== "closed"
          ? sessionAudioContext
          : new AudioContext();
    audioContextRef.current = audioContext;

    try {
      await audioContext.resume();

      const tokenResponse = await postWithPayloadHash(
        "/api/elevenlabs/tts-token",
      );
      const tokenData = (await tokenResponse.json()) as {
        token?: string;
        voiceId?: string;
        modelId?: string;
        error?: string;
      };

      if (
        !tokenResponse.ok ||
        !tokenData.token ||
        !tokenData.voiceId ||
        !tokenData.modelId
      ) {
        throw new Error(tokenData.error || "The TTS token request failed.");
      }

      if (operationId !== ttsOperationRef.current) {
        return null;
      }

      const websocketUrl = new URL(
        `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(tokenData.voiceId)}/multi-stream-input`,
      );
      websocketUrl.searchParams.set("model_id", tokenData.modelId);
      websocketUrl.searchParams.set("single_use_token", tokenData.token);
      websocketUrl.searchParams.set("output_format", "mp3_44100_128");
      websocketUrl.searchParams.set("auto_mode", "true");

      const socket = new WebSocket(websocketUrl);
      ttsSocketRef.current = socket;
      const contextId = crypto.randomUUID();
      ttsContextIdRef.current = contextId;

      let sentenceBuffer = "";
      let firstSentence = true;
      let finishWasSent = false;
      let receivedFinalMessage = false;
      let nextPlaybackTime = audioContext.currentTime;
      let audioDecodeQueue = Promise.resolve();
      let audioChunkCount = 0;
      let pendingAudioDecodes = 0;

      function finishPlaybackIfComplete() {
        if (
          operationId === ttsOperationRef.current &&
          receivedFinalMessage &&
          pendingAudioDecodes === 0 &&
          queuedAudioSourcesRef.current.size === 0
        ) {
          console.info("[tts-stream] playback.completed", {
            audioChunkCount,
          });
          stopSpeaking();
        }
      }

      function failStreamingSpeech(messageText: string) {
        if (operationId !== ttsOperationRef.current) {
          return;
        }

        setTtsError(messageText);
        console.error("[tts-stream] failed", { message: messageText });
        stopSpeaking();
      }

      function sendSentence(sentence: string) {
        const normalizedSentence = sentence.trim();

        if (!normalizedSentence || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            context_id: contextId,
            text: `${normalizedSentence} `,
            flush: true,
            ...(firstSentence
              ? {
                  voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.8,
                    speed: 1,
                  },
                }
              : {}),
          }),
        );

        firstSentence = false;
        console.info("[tts-stream] sentence.sent", {
          characters: normalizedSentence.length,
        });
      }

      function extractAndSendCompletedSentences() {
        // A boundary is punctuation followed by whitespace. Keeping incomplete
        // text in sentenceBuffer allows punctuation split across LLM deltas.
        const sentenceBoundary = /[.!?](?:["')\]]*)\s+/;
        let match = sentenceBoundary.exec(sentenceBuffer);

        while (match?.index !== undefined) {
          const sentenceEnd = match.index + match[0].length;
          sendSentence(sentenceBuffer.slice(0, sentenceEnd));
          sentenceBuffer = sentenceBuffer.slice(sentenceEnd);
          match = sentenceBoundary.exec(sentenceBuffer);
        }
      }

      function queueAudioChunk(base64Audio: string) {
        audioChunkCount += 1;
        pendingAudioDecodes += 1;

        // decodeAudioData calls are serialized so chunks cannot be scheduled in
        // a different order from the order ElevenLabs returned them.
        audioDecodeQueue = audioDecodeQueue.then(async () => {
          const binaryAudio = atob(base64Audio);
          const bytes = new Uint8Array(binaryAudio.length);

          for (let index = 0; index < binaryAudio.length; index += 1) {
            bytes[index] = binaryAudio.charCodeAt(index);
          }

          const decodedAudio = await audioContext.decodeAudioData(bytes.buffer);

          if (operationId !== ttsOperationRef.current) {
            return;
          }

          const source = audioContext.createBufferSource();
          source.buffer = decodedAudio;
          source.connect(audioContext.destination);
          queuedAudioSourcesRef.current.add(source);

          const startTime = Math.max(
            audioContext.currentTime + 0.02,
            nextPlaybackTime,
          );
          nextPlaybackTime = startTime + decodedAudio.duration;
          setTtsStatus("playing");

          source.onended = () => {
            queuedAudioSourcesRef.current.delete(source);
            source.disconnect();
            finishPlaybackIfComplete();
          };

          source.start(startTime);
          pendingAudioDecodes -= 1;
          finishPlaybackIfComplete();
        });

        audioDecodeQueue.catch((caughtError) => {
          failStreamingSpeech(
            caughtError instanceof Error
              ? caughtError.message
              : "A streamed audio chunk could not be played.",
          );
        });
      }

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => {
          console.info("[tts-stream] connected", {
            voiceId: tokenData.voiceId,
            modelId: tokenData.modelId,
          });
          resolve();
        };

        socket.onerror = () => {
          reject(new Error("The ElevenLabs TTS WebSocket failed."));
        };
      });

      socket.onmessage = (event) => {
        if (operationId !== ttsOperationRef.current) {
          return;
        }

        try {
          const response = JSON.parse(String(event.data)) as TtsSocketMessage;

          if (response.message) {
            throw new Error(response.message);
          }

          if (response.audio) {
            queueAudioChunk(response.audio);
          }

          const isFinal = response.is_final ?? response.isFinal ?? false;

          if (isFinal) {
            receivedFinalMessage = true;
            ttsContextIdRef.current = null;
            console.info("[tts-stream] context.completed", {
              audioChunkCount,
            });

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ close_socket: true }));
            }

            finishPlaybackIfComplete();
          }
        } catch (caughtError) {
          failStreamingSpeech(
            caughtError instanceof Error
              ? caughtError.message
              : "The streamed TTS response could not be processed.",
          );
        }
      };

      socket.onerror = () => {
        failStreamingSpeech("The ElevenLabs TTS WebSocket failed.");
      };

      socket.onclose = () => {
        if (
          operationId === ttsOperationRef.current &&
          !receivedFinalMessage
        ) {
          failStreamingSpeech(
            "The TTS connection closed before streamed audio was complete.",
          );
        }
      };

      return {
        addText(textDelta: string) {
          if (
            operationId !== ttsOperationRef.current ||
            finishWasSent
          ) {
            return;
          }

          sentenceBuffer += textDelta;
          extractAndSendCompletedSentences();
        },

        finish() {
          if (
            operationId !== ttsOperationRef.current ||
            finishWasSent ||
            socket.readyState !== WebSocket.OPEN
          ) {
            return;
          }

          finishWasSent = true;
          sendSentence(sentenceBuffer);
          sentenceBuffer = "";

          socket.send(
            JSON.stringify({
              context_id: contextId,
              close_context: true,
            }),
          );
          ttsContextIdRef.current = null;
        },
      };
    } catch (caughtError) {
      if (operationId !== ttsOperationRef.current) {
        return null;
      }

      const messageText =
        caughtError instanceof Error
          ? caughtError.message
          : "Streaming speech could not be started.";

      setTtsError(messageText);
      console.error("[tts-stream] start.failed", { message: messageText });
      stopSpeaking();
      return null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* SECTION 8: SEND ONE TEXT TURN TO THE LLM BACKEND                         */
  /* ------------------------------------------------------------------------ */

  async function submitQuestion(
    question: string,
    inputMode: "text" | "voice",
    alreadyInterrupted = false,
  ) {
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) {
      return;
    }

    // A new submitted question is also a barge-in action. The previous partial
    // answer remains visible but can no longer update the UI or TTS queue.
    const interruptedMessageId = activeAssistantMessageIdRef.current;

    if (!alreadyInterrupted) {
      interruptActiveTurn(`${inputMode}-question`);
    }

    const chatTurnId = activeChatTurnRef.current;

    // Keep the selected provider stable for the complete request.
    const selectedProvider = provider;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion,
      timestamp: new Date().toISOString(),
      inputMode,
    };

    // This ID lets every incoming chunk update the same assistant message.
    const assistantMessageId = crypto.randomUUID();

    // The welcome message is UI-only and should not be sent to an LLM.
    const conversationForApi = [...messagesRef.current, userMessage]
      .filter((message) => message.id !== INITIAL_MESSAGE.id)
      .filter((message) => message.id !== interruptedMessageId)
      .filter((message) => !message.interrupted)
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        provider: selectedProvider,
      },
    ]);

    setDraft("");
    setError(null);
    setIsSending(true);
    activeAssistantMessageIdRef.current = assistantMessageId;

    const chatAbortController = new AbortController();
    chatAbortControllerRef.current = chatAbortController;

    let receivedText = false;
    let receivedCharacters = 0;
    let deltaCount = 0;
    let serverRequestId = "not-received";
    let streamingSpeech: StreamingSpeechController | null = null;

    try {
      // Establish TTS before starting the LLM request so the first completed
      // sentence can be sent immediately rather than waiting for a socket.
      streamingSpeech = await startSentenceStreamingSpeech(
        inputMode === "voice" && alreadyInterrupted,
      );

      const requestBody = JSON.stringify({
        provider: selectedProvider,
        messages: conversationForApi,
      });

      const response = await postWithPayloadHash("/api/chat", {
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: requestBody,
        signal: chatAbortController.signal,
      });

      // Request-validation errors are regular JSON rather than SSE.
      if (!response.ok) {
        const failure = (await response.json()) as { error?: string };

        throw new Error(
          failure.error || `The API returned HTTP ${response.status}.`,
        );
      }

      if (!response.body) {
        throw new Error("The API returned no response stream.");
      }

      console.info("[chat] stream.connected", {
        provider: selectedProvider,
        contentType: response.headers.get("content-type"),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function processEventBlock(eventBlock: string) {
        if (chatTurnId !== activeChatTurnRef.current) {
          return;
        }

        const dataLine = eventBlock
          .split("\n")
          .find((line) => line.startsWith("data: "));

        if (!dataLine) {
          return;
        }

        const streamEvent = JSON.parse(
          dataLine.slice("data: ".length),
        ) as ChatStreamEvent;

        if (streamEvent.type === "meta") {
          serverRequestId = streamEvent.requestId;

          console.info("[chat] stream.meta", {
            requestId: serverRequestId,
            provider: streamEvent.provider,
            model: streamEvent.model,
          });

          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessageId
                ? { ...message, model: streamEvent.model }
                : message,
            ),
          );
        }

        if (streamEvent.type === "delta") {
          receivedText = true;
          deltaCount += 1;
          receivedCharacters += streamEvent.text.length;

          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: message.content + streamEvent.text,
                    // The assistant timestamp records when its first streamed
                    // text reached the browser, not when the request started.
                    timestamp: message.timestamp ?? new Date().toISOString(),
                  }
                : message,
            ),
          );

          streamingSpeech?.addText(streamEvent.text);
        }

        if (streamEvent.type === "done") {
          console.info("[chat] stream.done", {
            requestId: serverRequestId,
            provider: selectedProvider,
            deltaCount,
            receivedCharacters,
            latencyMs: streamEvent.latencyMs,
          });

          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessageId
                ? { ...message, latencyMs: streamEvent.latencyMs }
                : message,
            ),
          );

          streamingSpeech?.finish();
        }

        if (streamEvent.type === "error") {
          throw new Error(streamEvent.message);
        }
      }

      while (true) {
        const { value, done } = await reader.read();

        if (chatTurnId !== activeChatTurnRef.current) {
          await reader.cancel();
          return;
        }

        buffer += done
          ? decoder.decode()
          : decoder.decode(value, { stream: true });

        const eventBlocks = buffer.split(/\r?\n\r?\n/);
        buffer = eventBlocks.pop() || "";

        for (const eventBlock of eventBlocks) {
          processEventBlock(eventBlock);
        }

        if (done) {
          break;
        }
      }

      // Be tolerant of a server that closes without the final blank SSE line.
      if (buffer.trim()) {
        processEventBlock(buffer);
      }

      if (!receivedText) {
        throw new Error("The model completed without returning any text.");
      }

      // finish() is idempotent. This also covers a valid SSE server that ends
      // the connection without sending an explicit done event.
      streamingSpeech?.finish();
    } catch (caughtError) {
      if (chatTurnId !== activeChatTurnRef.current) {
        return;
      }

      streamingSpeech?.finish();

      // Preserve a partial answer, but remove an unused empty placeholder.
      setMessages((currentMessages) =>
        currentMessages.filter(
          (message) =>
            message.id !== assistantMessageId || message.content.length > 0,
        ),
      );

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The chat request failed.",
      );

      console.error("[chat] stream.failed", {
        requestId: serverRequestId,
        provider: selectedProvider,
        deltaCount,
        receivedCharacters,
        message:
          caughtError instanceof Error
            ? caughtError.message
            : "The chat request failed.",
      });
    } finally {
      if (chatTurnId === activeChatTurnRef.current) {
        chatAbortControllerRef.current = null;
        activeAssistantMessageIdRef.current = null;
        setIsSending(false);
      }
    }
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft, "text");
  }

  function clearConversation() {
    endVoiceSession();
    setMessages([INITIAL_MESSAGE]);
    setError(null);
    setTtsError(null);
    scribe.clearTranscripts();
  }

  const isReadyForQuestions =
    isDemoEnabled === true &&
    !isStartingMicrophone &&
    !isSending &&
    !isVoiceSessionActive &&
    ttsStatus === "idle";

  /* ------------------------------------------------------------------------ */
  /* SECTION 9: USER INTERFACE                                                 */
  /* ------------------------------------------------------------------------ */

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">Draft version · text & voice flows</p>
        <h1>LLM Voice Assistant</h1>
        <p>
          Type normally or start one continuous voice session. Voice activity
          detection submits every spoken turn, and you can interrupt naturally.
        </p>
      </header>

      <section className="provider-panel" aria-labelledby="provider-heading">
        <div>
          <p className="section-label">Model</p>
          <h2 id="provider-heading">Choose the LLM</h2>
        </div>

        <div className="provider-grid">
          {PROVIDERS.map((option) => (
            <label
              className={`provider-card ${provider === option.id ? "selected" : ""}`}
              key={option.id}
            >
              <input
                checked={provider === option.id}
                name="provider"
                onChange={() => setProvider(option.id)}
                type="radio"
                value={option.id}
              />
              <span>
                <strong>{option.name}</strong>
                <small>{option.model}</small>
                <small>{option.note}</small>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="chat-panel" aria-labelledby="chat-heading">
        <div className="chat-heading">
          <div>
            <p className="section-label">Conversation</p>
            <h2 id="chat-heading">Ask your question</h2>
          </div>
          <div className="chat-tools">
            <span
              className={`conversation-status ${isVoiceSessionActive ? "listening" : ttsStatus} ${isReadyForQuestions ? "ready" : ""}`}
            >
              {isStartingMicrophone
                ? "Connecting microphone"
                : isDemoEnabled === null
                  ? "Checking demo"
                  : !isDemoEnabled
                    ? "Demo disabled"
                    : ttsStatus === "playing"
                      ? isVoiceSessionActive
                        ? "Speaking · listening"
                        : "Speaking"
                      : ttsStatus === "generating" || isSending
                        ? isVoiceSessionActive
                          ? "Thinking · listening"
                          : "Thinking"
                        : isVoiceSessionActive
                          ? "Voice session active"
                          : "Ready"}
            </span>
            <button
              className="text-button"
              onClick={clearConversation}
              type="button"
            >
              Clear chat
            </button>
          </div>
        </div>

        <div className="messages" aria-live="polite">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-header">
                <span>
                  {message.role === "user"
                    ? message.inputMode === "voice"
                      ? "You · voice transcript"
                      : "You"
                    : "Coach"}
                </span>
                {message.timestamp && (
                  <time dateTime={message.timestamp}>
                    {formatMessageTime(message.timestamp)}
                  </time>
                )}
              </div>
              {message.content ? (
                <p>{message.content}</p>
              ) : (
                <p aria-label="Thinking">
                  Thinking
                  <span aria-hidden="true" className="thinking-dots">
                    ...
                  </span>
                </p>
              )}
              {message.model && message.latencyMs !== undefined && (
                <small>
                  {message.model} · {message.latencyMs} ms
                </small>
              )}
              {message.interrupted && (
                <small className="message-interrupted">
                  Interrupted — excluded from later conversation context
                </small>
              )}
            </article>
          ))}

          {isVoiceSessionActive && (
            <article className="listening-preview">
              <span>Voice session active · pause to send</span>
              <p>
                {scribe.partialTranscript ||
                  "Listening for your next question…"}
              </p>
            </article>
          )}
        </div>

        {error && <p className="error-message">{error}</p>}
        {asrError && <p className="error-message">{asrError}</p>}
        {ttsError && <p className="error-message">{ttsError}</p>}
        {isDemoEnabled === false && (
          <p className="demo-disabled-message">
            This demo is currently disabled. No new LLM, ASR, or TTS requests
            can be started.
          </p>
        )}

        <form className="composer" onSubmit={sendMessage}>
          <label htmlFor="question">Your question</label>
          <textarea
            disabled={isDemoEnabled !== true}
            id="question"
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="For example: Explain what an API is in simple language."
            rows={3}
            value={draft}
          />
          <div className="composer-footer">
            <small>{draft.length}/4000</small>
            <div className="conversation-actions">
              <button
                className="send-button"
                disabled={isDemoEnabled !== true || !draft.trim()}
                type="submit"
              >
                {isSending ? "Interrupt and send ⌘↵" : "Send message ⌘↵"}
              </button>
              <button
                className={`ask-button ${isVoiceSessionActive ? "listening" : ""}`}
                disabled={isDemoEnabled !== true || isStartingMicrophone}
                onClick={startMicrophone}
                type="button"
              >
                {isStartingMicrophone
                  ? "Connecting…"
                  : isVoiceSessionActive
                    ? "End voice session"
                    : "Start voice session"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
  );
}
