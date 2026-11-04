"use client";

import { DailyForwardChart, type EvLabel, type EvNote, type TfKeyAll } from "./daily-forward-chart";

type Row={close_price?:number|null;close_ts?:string|null;realized_r?:number|null;state?:string|null;ticker?:string|null;market?:string|null;direction?:string|null;entry_datetime?:string|null;entry_price?:number|null;stoploss?:number|null;tp1?:number|null;strategy_json?:unknown;order_id?:string|null};
type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
export default function ReversalK1TradeChart({row,onClose}:{row:Row;onClose:()=>void}) {
 const proof=object(row.strategy_json),signal=object(proof.signal),trade=object(proof.trade);
 const tf=(['1d','1h','30m'].includes(String(proof.timeframe))?proof.timeframe:'1d') as TfKeyAll;
 const symbol=String(row.ticker??'').replace(/^\^/,'');
 const candles=(Array.isArray(proof.chart_candles)?proof.chart_candles:[]).map(object);
 const usDaily=(ms:number)=>{
  if(tf!=='1d'||row.market!=='us'||!ms)return ms;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return ms+(570-Number(p.hour)*60-Number(p.minute))*60000;
 };
 const at=(v:unknown)=>usDaily(Number(candles.find(b=>b.d===v)?.ts)||0);
 const entryTs=new Date(usDaily(Date.parse(String(row.entry_datetime)))).toISOString();
 const sweep=at(signal.sweep_date),mss=at(signal.mss_date);
 const labels:EvLabel[]=([
  {tf,kind:'pool',price:Number(signal.swept_level),timeMs:sweep,label:`${signal.lookback}-bar ${signal.kind==='2B'?'FAILED BREAK + RECLAIM':'LIQUIDITY SWEEP'}`},
  {tf,kind:'sweep',price:Number(row.stoploss),timeMs:sweep,label:'SWEEP EXTREME = STOP'},
  {tf,kind:'also',price:Number(signal.internal_level),timeMs:mss,label:'k1_reclaim3 MSS · INTERNAL SWING'},
  {tf,kind:'target',price:Number(row.tp1),timeMs:Date.parse(String(row.entry_datetime)),label:'2R TARGET'},
 ] satisfies EvLabel[]).filter(l=>Number.isFinite(l.price)&&l.timeMs>0);
 const notes:EvNote[]=[{tf,text:`k1_reclaim3 · ${tf} · ${row.direction} · OTE 62% limit · 2R · 5m close SL / wick TP · sweep ${signal.sweep_date} → MSS ${signal.mss_date}. HTF: ${trade.htf??'none'}.`}];
 if(row.close_ts)notes.push({tf,text:`Exit ${row.state??''} · ${row.close_ts} · price ${row.close_price??'unavailable'} · realized ${row.realized_r??'unavailable'}R. SL uses actual 5m close loss; target touch wins before candle close.`});
 const entryValidation=object(proof.entry_validation);
 notes.push({tf,text:`Entry execution validation: ${String(entryValidation.verdict??entryValidation.status??"Not audited")} · ${String(entryValidation.reason??"See exported entry_validation evidence")}. Exit replay coverage does not certify an ICT setup.`});
 const exitEvidence=object(proof.exit_evidence);
 const exitBar=object(exitEvidence.bar ?? exitEvidence);
 const etTime=(v:unknown)=>{const stamp=typeof v==='number'?v:Date.parse(String(v));return Number.isFinite(stamp)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(stamp)):'Unproven';};
 const entryDay=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(String(row.entry_datetime)));
 const tf1=tf==='1d'?'1w':'1d';
 const query=new URLSearchParams({tab:'market-structure-shift',symbol:String(row.ticker),tf1,tf2:tf,start:String(signal.sweep_date??entryDay).slice(0,10),end:entryDay,entry:entryTs,dir:String(row.direction),conf:'LOCAL',pivot:'1',carry:'true',scope:'EXISTING',retest:'FIRST',candleSource:'REVERSAL_K1'});
 return <section className="overflow-hidden rounded-md border border-white/10 bg-[#101620]">
  <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3 text-xs"><strong>HTF ICT · Daily / 1H / 30m / 15m · ±20 / 40 / 60 bars</strong><span>{symbol} · {row.direction} · k1_reclaim3</span><button className="ml-auto rounded border border-white/20 px-3 py-1" onClick={onClose}>Close chart</button></div>
  <div className="p-4"><div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-amber-300/25 p-3 text-xs"><span>MSS investigation · {tf1} → {tf} · entry {entryDay}</span><a className="rounded bg-amber-300 px-3 py-2 font-semibold text-black" href={`/?${query}`}>Open in MSS tab</a><a className="rounded border border-white/20 px-3 py-2" href={`/?${query}`} target="_blank" rel="noopener noreferrer">New window</a></div>
   {row.close_ts ? <aside data-testid="reversal-exit-evidence" className="mb-3 rounded border border-red-300/25 bg-red-400/5 p-3 text-xs"><strong>Trade ended · {row.state} · {etTime(row.close_ts)} New York · actual exit {row.close_price} · {row.realized_r}R</strong><p className="mt-2">Completed raw 5m exit candle: open {String(exitBar.o ?? 'unproven')} · high {String(exitBar.h ?? 'unproven')} · low {String(exitBar.l ?? 'unproven')} · close {String(exitBar.c ?? 'unproven')}. SL level {row.stoploss} · target {row.tp1}.</p><p className="mt-1">{row.state==='CLOSED_SL'?'Stop triggered by the 5m close beyond SL. The displayed higher timeframe candle can later close back inside; subsequent target touches occur after this trade ended.':'Target touched before the closing stop check.'} Shaded candles after EXIT are context only.</p></aside> : null}
   <DailyForwardChart key={row.order_id} endpoint="/api/reversal/daily-forward" initialTf={tf} plotEvidence={false} anchorTs={sweep?new Date(sweep).toISOString():null} evidence={{labels,notes}} trade={{exitTs:row.close_ts??null,exitPrice:row.close_price??null,exitLabel:row.state??null,symbol,direction:row.direction??null,entryTs,fill:row.entry_price??null,stop:row.stoploss??null,target:row.tp1??null}}/>
  </div>
 </section>;
}
