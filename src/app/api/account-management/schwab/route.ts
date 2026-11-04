import { NextResponse } from "next/server";
import { schwabSetupStatus } from "@/lib/schwab-registration";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // Explicit allowlisted status: never return env, credentials, or tokens.
  return NextResponse.json(schwabSetupStatus(process.env), {
    headers: { "Cache-Control": "no-store" },
  });
}
