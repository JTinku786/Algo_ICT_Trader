import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { REPORTS_DIR } from "@/lib/reports-dir";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  ".json": "application/json", ".ndjson": "application/x-ndjson", ".jsonl": "application/x-ndjson",
  ".csv": "text/csv", ".md": "text/markdown", ".html": "text/html", ".txt": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".gz": "application/gzip", ".mp4": "video/mp4", ".webm": "video/webm",
};

// Serves /reports/* from REPORTS_DIR (replaces the old public/reports static folder).
export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  const file = path.resolve(REPORTS_DIR, ...parts.map(decodeURIComponent));
  if (file !== REPORTS_DIR && !file.startsWith(REPORTS_DIR + path.sep)) return new Response("Forbidden", { status: 403 });
  try {
    const s = await stat(file);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(s.size), "Cache-Control": "no-cache",
    } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
