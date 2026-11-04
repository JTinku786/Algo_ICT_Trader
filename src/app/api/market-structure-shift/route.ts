import { investigate } from "@/lib/mss-investigation-handler";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){return investigate(request);}
