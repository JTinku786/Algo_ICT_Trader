import path from "node:path";

// Report/backtest output lives outside the repo (see REPORTS_DIR in .env.local).
export const REPORTS_DIR = path.resolve(process.env.REPORTS_DIR || path.join(process.cwd(), "public", "reports"));
