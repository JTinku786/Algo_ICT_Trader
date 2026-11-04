import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Realtime Account Management.
 *
 * Calls Angel One, Dhan and Groww directly by running
 * scripts/broker_sync/live_snapshot.py as a child process and reading its JSON
 * on stdout. No Flask bridge, no PowerShell, no tunnel — the credentials are
 * already on this machine, so the shortest path is simply to run the Python.
 *
 * That does mean this route only works where the Python and the broker
 * credentials live, i.e. locally. On a hosted deployment set BROKER_LIVE_MODE
 * to "bridge" and point CANDLES_REST_API_URL at a reachable REST bridge.
 *
 * Broker sessions are cached on disk by the Python side, so the first call of
 * the day pays for the logins and later refreshes are quick.
 */

const SNAPSHOT_TIMEOUT_MS = Number(process.env.BROKER_LIVE_TIMEOUT_MS || 90_000);
// Repeat mounts of the tab share one snapshot; the Refresh button sets force=1.
const CACHE_TTL_MS = Number(process.env.BROKER_LIVE_ROUTE_CACHE_MS || 5_000);

type Payload = Record<string, unknown>;

let cached: { key: string; at: number; payload: Payload } | null = null;
let inFlight: { key: string; promise: Promise<Payload> } | null = null;

function pythonExecutable() {
  if (process.env.BROKER_SYNC_PYTHON) return process.env.BROKER_SYNC_PYTHON;
  // The trading stack's interpreter on this machine. Anything with SmartApi,
  // growwapi, pyotp and psycopg2 installed works.
  if (process.platform === "win32") return "C:\\Users\\saite\\anaconda3\\python.exe";
  return "python3";
}

function scriptPath() {
  return (
    process.env.BROKER_SYNC_SCRIPT ||
    path.join(process.cwd(), "scripts", "broker_sync", "live_snapshot.py")
  );
}

/**
 * Pull the snapshot object out of the child's stdout.
 *
 * Broker SDKs greet on stdout — the Groww client prints "Ready to Groww!" the
 * moment it is imported — so the stream is a banner followed by the payload,
 * and parsing the whole of it fails. Try the full text first, then each line
 * that starts a JSON object, so a banner above or below the payload is ignored
 * without guessing at the SDK's wording.
 */
function parseSnapshotPayload(stdout: string): Payload | null {
  const text = stdout.trim();
  if (!text) return null;

  const starts = [0];
  for (const match of text.matchAll(/^[ \t]*[{]/gm)) {
    if (match.index !== undefined && match.index > 0) starts.push(match.index);
  }

  for (const start of starts) {
    try {
      const value: unknown = JSON.parse(text.slice(start));
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Payload;
    } catch {
      /* not the payload — try the next candidate */
    }
  }
  return null;
}

function runSnapshot(args: string[]): Promise<Payload> {
  return new Promise((resolve, reject) => {
    const executable = pythonExecutable();
    const script = scriptPath();
    const child = spawn(executable, [script, ...args], {
      cwd: path.dirname(script),
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(
        new Error(
          `The broker snapshot did not finish within ${Math.round(SNAPSHOT_TIMEOUT_MS / 1000)}s. ` +
            `The first call after a session expires includes a TOTP login for each broker; try Refresh again.`,
        ),
      );
    }, SNAPSHOT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? ` Could not run "${executable}". Set BROKER_SYNC_PYTHON in .env.local to the interpreter that has SmartApi, growwapi and pyotp installed.`
          : "";
      reject(new Error(`${error.message}.${hint}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // The script always prints JSON, including on failure, so parse before
      // trusting the exit code — its message is far more useful than "exit 1".
      const payload = parseSnapshotPayload(stdout);
      if (payload) {
        resolve(payload);
        return;
      }
      const detail =
        stderr.trim().split("\n").slice(-6).join("\n") ||
        (stdout.trim() ? `stdout: ${stdout.trim().slice(0, 300)}` : `exit code ${code}`);
      reject(new Error(`Broker snapshot produced no usable JSON.\n${detail}`));
    });
  });
}

async function viaBridge(request: NextRequest): Promise<Payload> {
  const restApiUrl = process.env.CANDLES_REST_API_URL;
  if (!restApiUrl) throw new Error("BROKER_LIVE_MODE=bridge but CANDLES_REST_API_URL is not set.");
  const url = new URL("/api/broker-live/snapshot", restApiUrl);
  for (const key of ["broker", "account", "force"]) {
    const value = request.nextUrl.searchParams.get(key);
    if (value && value.toLowerCase() !== "all") url.searchParams.append(key, value);
  }
  const response = await fetch(url, {
    headers: process.env.CANDLES_REST_API_TOKEN ? { "x-api-key": process.env.CANDLES_REST_API_TOKEN } : undefined,
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || `REST bridge error (${response.status})`);
  }
  return payload as Payload;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const broker = params.get("broker");
  const account = params.get("account");
  const force = params.get("force") === "1";
  const persist = params.get("persist") !== "0";

  const args: string[] = [];
  if (broker && broker.toLowerCase() !== "all") args.push("--brokers", broker);
  if (account && account.toUpperCase() !== "ALL") args.push("--accounts", account);
  if (!persist) args.push("--no-persist");
  if (force) args.push("--force");

  const key = args.join(" ");

  try {
    if (!force && cached && cached.key === key && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json({ ...cached.payload, view: "live", cached: true });
    }

    // Two tabs refreshing at once must not spawn two logins.
    if (inFlight && inFlight.key === key) {
      const payload = await inFlight.promise;
      return NextResponse.json({ ...payload, view: "live" });
    }

    const promise =
      process.env.BROKER_LIVE_MODE === "bridge" ? viaBridge(request) : runSnapshot(args);
    inFlight = { key, promise };

    let payload: Payload;
    try {
      payload = await promise;
    } finally {
      if (inFlight?.promise === promise) inFlight = null;
    }

    if (payload.success === false) {
      return NextResponse.json({ ...payload, view: "live" }, { status: 502 });
    }

    cached = { key, at: Date.now(), payload };
    return NextResponse.json({ ...payload, view: "live", cached: false });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        view: "live",
        error: error instanceof Error ? error.message : "Live broker snapshot failed",
      },
      { status: 502 },
    );
  }
}
