import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { NextResponse } from "next/server";
import {
  demoDisabledResponse,
  isDemoEnabled,
} from "../../_shared/demo-access";
import { getProviderApiKey } from "../../_shared/provider-secrets";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// ELEVENLABS SECURITY BOUNDARY
// -----------------------------------------------------------------------------
// The browser must never receive ELEVENLABS_API_KEY. It asks this server route
// for a short-lived, single-use Realtime Scribe token instead.

export async function POST() {
  if (!isDemoEnabled()) {
    return demoDisabledResponse();
  }

  try {
    const client = new ElevenLabsClient({
      apiKey: await getProviderApiKey("ELEVENLABS_API_KEY"),
    });

    const response = await client.tokens.singleUse.create("realtime_scribe");

    console.info("[asr-token] issued", {
      tokenType: "realtime_scribe",
    });

    return NextResponse.json({
      token: response.token,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Realtime Scribe token could not be created.";

    console.error("[asr-token] failed", {
      message,
    });

    return NextResponse.json(
      {
        error: "The Realtime Scribe token could not be created.",
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
