import { NextResponse } from "next/server";

// -----------------------------------------------------------------------------
// CENTRAL DEMO KILL SWITCH
// -----------------------------------------------------------------------------
// Production fails closed: the paid routes work only when DEMO_ENABLED=true.
// Local development remains convenient when the variable has not been added
// yet, while DEMO_ENABLED=false can still be used to test the disabled state.

export function isDemoEnabled(): boolean {
  const configuredValue = process.env.DEMO_ENABLED?.trim().toLowerCase();

  if (configuredValue !== undefined) {
    return configuredValue === "true";
  }

  return process.env.NODE_ENV === "development";
}

export function demoDisabledResponse() {
  return NextResponse.json(
    {
      error: "This demo is currently disabled by its owner.",
      code: "DEMO_DISABLED",
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "3600",
      },
    },
  );
}
