import { NextResponse, type NextRequest } from "next/server";

// On the public Vercel deployment, Account Management (broker balances, positions, fills)
// is not served at all. Set HIDE_ACCOUNT_MGMT=true in Vercel; leave unset locally.
export function proxy(request: NextRequest) {
  if (process.env.HIDE_ACCOUNT_MGMT === "true") {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/account-management/:path*"],
};
