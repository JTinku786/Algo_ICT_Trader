import { investigate } from "@/lib/mss-investigation-handler";
import { validateScalpingSettings } from "@/lib/scalping-labs";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 try{const body=await request.clone().json();const error=validateScalpingSettings(body.scalping);if(error)return Response.json({error},{status:400});}
 catch{return Response.json({error:"Invalid investigation request."},{status:400});}
 return investigate(request,"SCALPING_LABS");
}
