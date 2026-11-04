import type { OrderChartResponse, OverlayZone, OverlayLevel } from "@/app/components/order-chart";
import type { BacktestTrade } from "./scalping-backtest-results";
import type { ReplayBar, IctOverlay } from "./weekly-replay";
import { scalpingEvidence, type ScalpingProof, type EvidenceLine } from "./scalping-chart-evidence";

const seconds=(ms:number)=>ms/1000;
const bucketKeys:Record<string,string>={"5m":"timeframe_5m","15m":"timeframe_15m","30m":"timeframe_30m","1h":"timeframe_1h","1d":"timeframe_daily","1w":"timeframe_weekly"};
/** Adapt archived JSON to the existing Backtest renderer, preserving prices and native timeframes. */
export function scalpingOrderSnapshot({trade,proof,bars,frame,cutoff,outcome,extraLines=[],allTargets=false}:{
 trade:BacktestTrade;proof:ScalpingProof|null;bars:ReplayBar[];frame:"TF1"|"TF2";cutoff:number;outcome:boolean;extraLines?:EvidenceLine[];allTargets?:boolean;
}):OrderChartResponse{
 const own=proof ? frame==="TF1"?proof.context:proof.array : null;
 const tf=own?.tf??(frame==="TF1"?"1h":"5m");
 const visible=bars.filter(b=>b.knownAt<=cutoff);
 const end=seconds(visible.at(-1)?.knownAt??cutoff);
 const order_blocks:OverlayZone[]=[],fvgs:OverlayZone[]=[],structure:OverlayZone[]=[],liquidity:OverlayLevel[]=[],swings:OverlayLevel[]=[];
 const addZone=(z:IctOverlay,label:string,projected=false)=>{
  if(z.knownAt>cutoff)return;
  const zone:OverlayZone={kind:z.kind.toLowerCase(),top:z.high,bottom:z.low,time:seconds(z.kind==="IFVG"?z.knownAt:z.origin),end_time:end,direction:z.direction,broken:false,mitigated:false,filled:false,label,primary:true,polarity:z.direction==="BUY"?"bullish":"bearish",...(z.kind==="IFVG"?{zone_role:"ifvg" as const}:{})};
  if(projected)structure.push(zone);
  else if(z.kind==="OB")order_blocks.push(zone);
  else if(["FVG","IFVG"].includes(z.kind))fvgs.push(zone);
  else structure.push(zone);
  if(z.lineage&&z.kind==="IFVG"){
   const sign=z.lineage.split(":").at(-1);
   if(sign==="1"||sign==="-1")fvgs.push({...zone,time:seconds(z.origin),kind:"fvg",zone_role:"source_fvg",direction:sign==="1"?"BUY":"SELL",polarity:sign==="1"?"bullish":"bearish",end_time:seconds(z.knownAt),label:`${z.tf.toUpperCase()} SOURCE FVG → IFVG`});
  }
 };
 if(own)addZone(own,`${tf.toUpperCase()} ${own.kind} · ${frame} SELECTED`);
 if(proof&&frame==="TF2")addZone(proof.context,`${proof.context.tf.toUpperCase()} ${proof.context.kind} · TF1 CONTEXT`,true);
 const mapped=proof?scalpingEvidence(proof,frame,allTargets):{lines:[]};
 // Native boxes carry lineage boundaries; the shared IPDA layer carries the
 // saved high/low/EQ. Avoid duplicate callouts for the same evidence.
 const lines=[...mapped.lines.filter(l=>!l.label.includes("dealing range")&&!l.label.startsWith("Source ")),...extraLines];
 if(own?.kind==="OB"){
  const origin=visible.find(b=>b.t===own.origin);
  if(origin)lines.push({label:`${tf.toUpperCase()} OB MEAN THRESHOLD · BODY 50%`,price:(origin.o+origin.c)/2,knownAt:own.knownAt,originAt:own.origin,color:"#9333ea",sourceId:own.id});
 }
 for(const line of lines){
  if(line.knownAt>cutoff||!Number.isFinite(line.price))continue;
  liquidity.push({kind:"saved_level",level:line.price,time:seconds(line.originAt??line.knownAt),end_time:end,side:null,direction:trade.side,label:line.label});
 }
 const point=(label:string,price:number,time:number,endTime=time)=>structure.push({kind:"mss",top:price,bottom:price,time:seconds(time),end_time:seconds(endTime),direction:trade.side,broken:false,mitigated:false,filled:false,label});
 if(proof&&frame==="TF2"){
  if(proof.confirmation.knownAt<=cutoff)point(`${proof.confirmation.label} · BROKEN SWING → CONFIRMING CLOSE`,proof.confirmation.level,proof.confirmation.origin,proof.confirmation.at);
  if(proof.touch.knownAt<=cutoff)point("TF1 ARRAY TOUCH",proof.touch.c,proof.touch.t);
  const stopCandle=visible.find(b=>b.t===proof.plan.stopAt);
  if(stopCandle)point("STRUCTURAL STOP EXTREME",trade.side==="BUY"?stopCandle.l:stopCandle.h,stopCandle.t);
 }
 if(proof&&frame==="TF1"&&proof.touch.knownAt<=cutoff)point("TF1 ARRAY TOUCH",proof.touch.c,proof.touch.t);
 const closed=outcome&&trade.exitAt!=null&&trade.exitAt<=cutoff&&["WIN","LOSS"].includes(trade.result);
 const exitPrice=closed?(trade.result==="WIN"?trade.target:trade.stop)??null:null;
 if(closed&&exitPrice!=null&&frame==="TF2")point(`${trade.result} · ${trade.result==="WIN"?"TARGET HIT":"SL HIT"}`,exitPrice,trade.exitAt!);
 const range=proof?.validFvg?.[`VALID_FVG_${frame}`]?.range;
 const ipda=range&&range.knownAt<=cutoff?{low:range.low,q25:range.low+(range.high-range.low)*.25,eq50:range.equilibrium,q75:range.low+(range.high-range.low)*.75,high:range.high,start_time:seconds(Math.min(range.lowOrigin,range.highOrigin)),end_time:seconds(trade.entryAt),sessions:0,selected_level:proof?.validFvg?.[`VALID_FVG_${frame}`]?.reason??null,anchored:true,title:`${tf.toUpperCase()} saved dealing range`}:null;
 const overlays={order_blocks,fvgs,structure,liquidity,swings,ipda,bias:null,strategy_timeframe:tf,timeframe_5m:{},timeframe_15m:{},timeframe_30m:{},timeframe_1h:{},timeframe_daily:{},timeframe_weekly:{}};
 const key=bucketKeys[tf];if(key)Object.assign(overlays,{[key]:{order_blocks,fvgs,structure,liquidity,swings}});
 return {success:true,saved_evidence:true,timeframe:tf,candles:visible.map(b=>({time:seconds(b.t),open:b.o,high:b.h,low:b.l,close:b.c})),order:{order_id:trade.id,symbol:trade.symbol,market:trade.market,direction:trade.side,entry_price:trade.entry??null,filled_price:trade.entry??null,stoploss:trade.stop??null,tp1:trade.target??null,tp2:null,tp3:null,filled_at:new Date(trade.entryAt).toISOString(),close_ts:closed?new Date(trade.exitAt!).toISOString():null,close_price:exitPrice,close_reason:closed?trade.result:null,realized_r:outcome?trade.r:null,outcome:outcome?trade.result:null},markers:{entry:{time:seconds(trade.entryAt),price:trade.entry??null},exit:{time:closed?seconds(trade.exitAt!):0,price:exitPrice,outcome:closed?trade.result:"OPEN"}},overlays};
}
