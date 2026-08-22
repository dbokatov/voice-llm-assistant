import { NextResponse } from "next/server";
import { isDemoEnabled } from "../_shared/demo-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      enabled: isDemoEnabled(),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
