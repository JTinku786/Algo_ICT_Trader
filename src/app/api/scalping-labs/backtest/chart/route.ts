import { spawn } from "node:child_process";
import path from "node:path";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const id = q.get("id") ?? "";
  if (!/^[a-f0-9]{64}$/.test(id)) return Response.json({ error: "Invalid saved trade ID." }, { status: 400 });
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.MSS_PYTHON ?? "python", [path.join(process.cwd(), "scripts/scalping_trade_chart.py"), id, q.get("contextId") ?? "", q.get("arrayId") ?? "", q.get("confirmation") ?? ""], { windowsHide: true });
      let out = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("Saved chart loading timed out.")); }, 60000);
      request.signal.addEventListener("abort", () => child.kill(), { once: true });
      child.stdout.on("data", chunk => { out += chunk; });
      child.stderr.resume();
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", () => { clearTimeout(timer); resolve(out); });
    });
    const result = JSON.parse(data);
    return Response.json(result, { status: result.error ? 422 : 200 });
  } catch { return Response.json({ error: "Unable to load saved trade chart." }, { status: 500 }); }
}
