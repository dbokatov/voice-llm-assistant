import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse } from "next/server";
import {
  demoDisabledResponse,
  isDemoEnabled,
} from "../../_shared/demo-access";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// ELEVENLABS TTS SECURITY BOUNDARY
// -----------------------------------------------------------------------------
// The permanent ElevenLabs key stays on the server. The browser receives one
// short-lived, single-use token plus the voice and model selected by the server.

const DEFAULT_VOICE_ID = "OYTbf65OHHFELVut7v2H";
const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

function readElevenLabsApiKey(): string {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!apiKey || apiKey.startsWith("replace-with-")) {
    throw new Error("ELEVENLABS_API_KEY is not configured in .env");
  }

  return apiKey;
}

export async function POST() {
  if (!isDemoEnabled()) {
    return demoDisabledResponse();
  }

  try {
    const client = new ElevenLabsClient({
      apiKey: readElevenLabsApiKey(),
    });

    const response = await client.tokens.singleUse.create("tts_websocket");
    const voiceId =
      process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
    const modelId =
      process.env.ELEVENLABS_TTS_MODEL?.trim() || DEFAULT_TTS_MODEL;

    console.info("[tts-token] issued", {
      tokenType: "tts_websocket",
      voiceId,
      modelId,
    });

    return NextResponse.json({
      token: response.token,
      voiceId,
      modelId,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The ElevenLabs TTS token could not be created.";

    console.error("[tts-token] failed", { message });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
