"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cachedFetch } from "@/lib/fetch-cache";
import {developingReplayBar} from "@/lib/replay-developing";
import courseCoverage from "@/app/data/ict-replay-course-coverage.json";
import {rangeLiquidity} from "@/lib/range-liquidity";
import {nearestPdArrays} from "@/lib/nearest-pd-array";
import {replayFibonacci} from "@/lib/replay-fibonacci";
import {liquiditySweeps} from "@/lib/liquidity-sweeps";
import {timeInfluence} from "@/lib/time-influence";
import {ipdaLookback} from "@/lib/ipda-lookback";
import {createReplayCrosshair} from "@/lib/replay-crosshair";
import {paperResult,type PaperTrade} from "@/lib/paper-trading";
import {nextPlaygroundBar,revealedPlaygroundBars} from "@/lib/playground-clock";
import type { TopDownTrade } from "@/lib/top-down-navigation";
import { completedWeeklyBars, deriveIctOverlays, type ReplayData } from "@/lib/weekly-replay";
import { completedMonthlyBars, topDownStructure } from "@/lib/top-down";
import { dailyContext, defaultContextReferences, type ReferencePoint } from "@/lib/daily-context";
import type { Frame } from "@/lib/daily-bias";
import WeeklyReplayChart from "./weekly-replay-chart";
import PremiumDiscountArrays from "./premium-discount-arrays";
const sourceFrames: Frame[]=["1d","1h","30m","15m","5m"];
const noop=()=>{};
const replayLayoutOrder=["5m","30m","1d","1w","15m","1h","1mo"];
/** Bar-by-bar replay of one trade from its entry time.
 *  Backtest: levels from /api/backtest/order-chart, archive candles (backtest=1).
 *  Realtime: levels from /api/realtime-analytics/order-chart, live candle tables through the latest completed bar (live=1). */
export default function BacktestPlayground({trade,levelsEndpoint="/api/backtest/order-chart",levelsParam="order_id",live=false}:{trade:TopDownTrade;levelsEndpoint?:string;levelsParam?:string;live?:boolean}) {
  const crosshair=useMemo(()=>createReplayCrosshair(),[]);
  const [priceRanges,setPriceRanges]=useState<Record<string,{from:number;to:number}|null>>({});
  const changePriceRange=useCallback((frame:string,range:{from:number;to:number}|null)=>setPriceRanges(current=>({...current,[frame]:range})),[]);
  const entryAt=trade.entryTs ? Date.parse(trade.entryTs) : NaN;
  const [clock,setClock]=useState(Number.isFinite(entryAt)?entryAt:0);
  const [playing,setPlaying]=useState(false),[speed,setSpeed]=useState(800);
  const [data,setData]=useState<Partial<Record<Frame,ReplayData>>>({});
  const [error,setError]=useState("");
  const [orderLevels,setOrderLevels]=useState<{entry_price:number|null;filled_price:number|null;stoploss:number|null;tp1:number|null;tp2:number|null;tp3:number|null}|null>(null);
  useEffect(()=>{
    const abort=new AbortController();
    cachedFetch(`${levelsEndpoint}?${levelsParam}=${encodeURIComponent(trade.orderId)}&target_no=${trade.targetNo??"1"}`,{signal:abort.signal})
      .then(async r=>{if(!r.ok)throw new Error("Trade levels unavailable");return r.json();})
      .then(p=>setOrderLevels(p.order??null)).catch(()=>{if(!abort.signal.aborted)setOrderLevels(null);});
    return ()=>abort.abort();
  },[trade.orderId,trade.targetNo,levelsEndpoint,levelsParam]);
  const tradeLevels=useMemo(()=>[
    {label:"ENTRY",price:orderLevels?.filled_price??orderLevels?.entry_price??trade.entry,color:"#b7791f"},
    {label:"SL",price:orderLevels?.stoploss??trade.stop,color:"#dc2626"},
    ...([1,2,3] as const).map(n=>({label:`TP${n}`,price:orderLevels?.[`tp${n}`]??(n===Number(trade.targetNo??1)?trade.target:null),color:"#15803d"}))
  ].flatMap(l=>l.price!==null && Number.isFinite(l.price)?[{...l,price:l.price,knownAt:entryAt}]:[]),[orderLevels,trade.entry,trade.stop,trade.target,trade.targetNo,entryAt]);
  const [loaded,setLoaded]=useState(false);
  const [focus,setFocus]=useState("all"),[selected,setSelected]=useState("");
  const [arrays,setArrays]=useState(false),[stoppedAt,setStoppedAt]=useState<number|null>(null);
  useEffect(()=>{
    if(!Number.isFinite(entryAt))return;
    const abort=new AbortController();
    const from=new Date(entryAt-120*86400000).toISOString().slice(0,10);
    Promise.all(sourceFrames.map(async frame=>{
      const r=await cachedFetch(`/api/daily-bias/replay?symbol=${encodeURIComponent(trade.symbol)}&tf=${frame}&from=${from}${live?"&live=1":"&backtest=1"}`,{signal:abort.signal});
      const p=await r.json();if(!r.ok)throw new Error(p.error??"Unable to load playground candles");return [frame,p] as const;
    })).then(rows=>setData(Object.fromEntries(rows))).catch(e=>{if(e.name!=="AbortError")setError(e.message);}).finally(()=>{if(!abort.signal.aborted)setLoaded(true);});
    return ()=>abort.abort();
  },[trade.symbol,entryAt,live]);
  const timeline=useMemo(()=>data["5m"]?.bars??[],[data]);
  const [paperTrades,setPaperTrades]=useState<Record<string,PaperTrade[]>>({});
  const onPaperTradesChange=useCallback((frame:string,trades:PaperTrade[])=>setPaperTrades(current=>({...current,[frame]:trades})),[]);
  const paperBars=useMemo(()=>timeline.filter(b=>b.knownAt<=clock),[timeline,clock]);
  const openPaper=useMemo(()=>Object.values(paperTrades).flat().filter(t=>t.placedAt<=clock && paperResult(t,paperBars).status==="Open"),[paperTrades,paperBars,clock]);
  const index=timeline.findLastIndex(b=>b.knownAt<=clock);
  const next=nextPlaygroundBar(timeline,clock);
  const running=playing && !!next && stoppedAt===null;
  useEffect(()=>{
    if(!running)return;
    const timer=setInterval(()=>{
      const bar=nextPlaygroundBar(timeline,clock);if(!bar)return;
      setClock(bar.knownAt);
      if(openPaper.length){
        const revealed=timeline.filter(b=>b.knownAt<=bar.knownAt);
        if(openPaper.every(t=>paperResult(t,revealed).status!=="Open"))setPlaying(false);
      }else{
        const stop=orderLevels?.stoploss??trade.stop;
        const target=orderLevels?.[`tp${Number(trade.targetNo??1) as 1|2|3}`]??trade.target;
        if(bar.knownAt>entryAt && (trade.direction==="BUY" ? (stop!==null && bar.l<=stop)||(target!==null && bar.h>=target) : trade.direction==="SELL" ? (stop!==null && bar.h>=stop)||(target!==null && bar.l<=target) : false))setPlaying(false);
      }
    },speed);
    return ()=>clearInterval(timer);
  },[running,speed,timeline,clock,openPaper,orderLevels,trade.stop,trade.target,trade.targetNo,trade.direction,entryAt]);
  const daily=data["1d"];
  const day=daily ? new Date(clock).toLocaleDateString("en-CA",{timeZone:daily.instrument.zone}):"";
  const prefix=useMemo(()=>data["1d"]?.daily.filter(b=>b.knownAt<=clock)??[],[data,clock]);
  const precision=daily?.instrument.market==="forex" ? /JPY/.test(trade.symbol)?3:5:2;
  const number=useCallback((p:number)=>p.toFixed(precision),[precision]);
  const panels=useMemo(()=>{
    if(!daily)return [];
    const invalid=daily.invalidDailyDays;
    const monthly=completedMonthlyBars(prefix,day,invalid),weekly=completedWeeklyBars(prefix,day,invalid);
    return [{title:"Monthly",frame:"1mo" as const,bars:monthly},{title:"Weekly",frame:"1w" as const,bars:weekly},{title:"Daily",frame:"1d" as const,bars:prefix},...(["1h","30m","15m","5m"] as const).map(frame=>({title:frame==="1h"?"1 Hour":frame==="30m"?"30 Minutes":frame==="15m"?"15 Minutes":"5 Minutes",frame,bars:revealedPlaygroundBars(data[frame]?.bars??[],clock,1000)}))].map(panel=>{
      const previous=panel.bars.at(-2);
      const refs:ReferencePoint[]=previous?[{kind:`Old high · previous ${panel.title}`,low:previous.h,high:previous.h,knownAt:previous.knownAt,originDay:previous.day,timing:"Before day",response:"Completed candle"},{kind:`Old low · previous ${panel.title}`,low:previous.l,high:previous.l,knownAt:previous.knownAt,originDay:previous.day,timing:"Before day",response:"Completed candle"},{kind:`Previous ${panel.title} equilibrium`,low:(previous.h+previous.l)/2,high:(previous.h+previous.l)/2,knownAt:previous.knownAt,originDay:previous.day,timing:"Before day",response:"50% of completed range"}]:[];
      if(["1d","1h","30m","15m","5m"].includes(panel.frame))for(const [title,bars] of [["Monthly",monthly],["Weekly",weekly]] as const){const last=bars.at(-1);if(last)for(const [suffix,price] of [["high",last.h],["low",last.l],["equilibrium",(last.h+last.l)/2]] as const)refs.push({kind:`${title} ${suffix}`,low:price,high:price,knownAt:last.knownAt,originDay:last.day,timing:"Before day",response:"Completed higher timeframe range"});}
      if(panel.frame==="1d" && prefix.length){const context=dailyContext(daily,prefix.at(-1)!.day);if(context)refs.push(...defaultContextReferences(context).filter(r=>r.knownAt<=clock));}
      return {...panel,developing:developingReplayBar(panel.frame,data["5m"]?.bars??[],prefix,panel.bars,clock,daily.instrument.market==="us"?570:daily.instrument.market==="india"?555:0),refs,previous,zones:deriveIctOverlays(panel.bars,panel.frame,daily.instrument.market,prefix),structure:topDownStructure(panel.bars,panel.frame,invalid)};
    });
  },[daily,data,prefix,day,clock]);
  const price=timeline[index] && timeline[index].knownAt>=entryAt ? timeline[index].c : trade.entry ?? undefined;
  const mark=stoppedAt===null ? price : timeline.findLast(b=>b.knownAt<=stoppedAt)?.c;
  const pnl=trade.entry!==null && mark!==undefined && ["BUY","SELL"].includes(trade.direction??"") ? (mark-trade.entry)*(trade.direction==="BUY"?1:-1):null;
  function exportSnapshot(){
    const snapshot={schemaVersion:"ict-replay-decision-v1",orderId:trade.orderId,symbol:trade.symbol,strategyId:trade.strategyId,replayClock:clock,replayClockIso:new Date(clock).toISOString(),executionFrame:"5m",assumptions:{candles:"Completed OHLC only",sameCandleExit:"Stop first when stop and target are both touched",costs:"Not included",certification:"Mechanical candidates, not validated signals",visualControls:"Visibility does not determine feature availability"},
      courseCoverage,
      sources:Object.fromEntries(Object.entries(data).map(([frame,payload])=>[frame,{provenance:payload?.provenance,audit:payload?.audit}])),
      frames:panels.map(panel=>{const recent=panel.bars.slice(-80),high=recent.length?Math.max(...recent.map(b=>b.h)):null,low=recent.length?Math.min(...recent.map(b=>b.l)):null;return {frame:panel.frame,lastCompletedAt:panel.bars.at(-1)?.knownAt??null,availableCompletedCount:panel.bars.length,developingCandle:panel.developing,visiblePriceRange:priceRanges[panel.frame]??null,rolling80:{count:recent.length,high,low,equilibrium:high!==null&&low!==null?(high+low)/2:null},candles:panel.bars.filter(b=>b.knownAt<=clock).slice(-1000),pdCandidates:panel.zones.filter(z=>z.knownAt<=clock),referenceCandidates:panel.refs.filter(r=>r.knownAt<=clock),structure:panel.structure,rangeLiquidity:rangeLiquidity(panel.refs,panel.zones),
        nearestPdCandidates:panel.bars.length?nearestPdArrays(panel.zones,panel.bars.at(-1)!.c,clock):[],
        fibonacci:replayFibonacci(panel.bars,panel.frame,daily?.invalidDailyDays??[]),
        liquiditySweeps:liquiditySweeps(panel.bars,panel.frame,daily?.invalidDailyDays??[]).sweeps.filter(s=>s.knownAt<=clock),
        timeWindows:["1h","30m","15m","5m"].includes(panel.frame)?timeInfluence(panel.bars,prefix):[]};}),
      ipda:prefix.length?ipdaLookback(prefix,prefix.at(-1)!.day,deriveIctOverlays(prefix,"1d",daily?.instrument.market??"us",prefix)):null,
      originalTradeLevels:tradeLevels.filter(l=>l.knownAt<=clock),paperPositions:Object.values(paperTrades).flat().filter(t=>t.placedAt<=clock).map(position=>({position:{...position,closedAt:position.closedAt!==undefined&&position.closedAt<=clock?position.closedAt:undefined,closePrice:position.closedAt!==undefined&&position.closedAt<=clock?position.closePrice:undefined},result:paperResult(position,paperBars)})),
      unavailable:["Certified mitigation / propulsion / rejection blocks","Certified liquidity voids","IPDA four-state classifier","Weekly profile classifier","PO3 / market maker model classifier","Aligned SMT comparison","Macroeconomic / COT / open interest data"]};
    const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"}));const anchor=document.createElement("a");anchor.href=url;anchor.download=`ict-replay-${trade.symbol}-${new Date(clock).toISOString().replace(/[:.]/g,"-")}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function step(offset:number){setPlaying(false);const bar=offset>0?next:timeline[index-1];if(bar)setClock(bar.knownAt);}
  return <section className="space-y-4 rounded-xl border border-amber-300/20 p-4" data-backtest-playground><h2 className="text-xl font-semibold">Trade playground · 5-minute replay</h2><p className="text-sm">{trade.symbol} · {trade.strategyId} · {trade.direction} · {trade.orderId}</p><details className="text-xs text-slate-400"><summary className="cursor-pointer">Replay guide</summary><p>Start at the selected trade timestamp; all seven charts share the 5-minute clock. Higher timeframes display a developing candle from revealed 5-minute bars; confirmed indicators use closed candles only. Playback follows the latest 80 candles with an automatic price range from their lowest low −2% to highest high +2% until you select that chart’s own price zone. Each selected range stays fixed independently while time continues to advance. Open paper positions take priority: replay pauses when all open paper positions hit their own stop or target. With no open paper position, replay pauses at the original trade stop or selected target. You can also pause or stop manually. Session gaps are skipped. Original Backtest records remain unchanged. Intraday annotations use the latest 1,000 revealed candles per chart; daily history supplies the 20/40/60 lookback ranges.</p></details>
    {!Number.isFinite(entryAt)?<p role="alert">Trade timestamp unavailable; replay cannot start.</p>:error?<p role="alert">{error}</p>:!loaded?<p role="status">Loading trade playground…</p>:<>
      <div className="flex flex-wrap items-center gap-3 text-sm"><button onClick={()=>step(-1)} disabled={index<=0 || stoppedAt!==null} className="rounded border px-3 py-2">← 5m</button><button aria-label={running?"Pause playground":"Play playground"} onClick={()=>setPlaying(!running)} disabled={!next || stoppedAt!==null} className="rounded bg-amber-300 px-4 py-2 text-slate-950">{running?"Pause":"Play"}</button><button onClick={()=>step(1)} disabled={!next || stoppedAt!==null} className="rounded border px-3 py-2">5m →</button><button onClick={()=>{setPlaying(false);setClock(entryAt);setStoppedAt(null);}} className="rounded border px-3 py-2">Reset to trade</button><button disabled={price===undefined || stoppedAt!==null || clock<entryAt} onClick={()=>{setPlaying(false);setStoppedAt(clock);}} className="rounded border border-rose-300/40 px-3 py-2">Stop simulated trade here</button><label>Speed <select aria-label="Playground speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))} className="rounded bg-slate-900 p-2"><option value={1500}>Slow</option><option value={800}>Normal</option><option value={250}>Fast</option></select></label><button onClick={exportSnapshot} className="rounded border border-blue-300/30 px-3 py-2">Export decision snapshot · JSON</button><label>Chart view <select aria-label="Playground chart view" value={focus} onChange={e=>setFocus(e.target.value)} className="rounded bg-slate-900 p-2"><option value="all">All seven charts</option>{panels.map(p=><option key={p.frame} value={p.frame}>{p.title}</option>)}</select></label></div>
      <p className="text-xs text-slate-400">Each chart has its own price-zone selection. Click ▭ in any timeframe, then drag a rectangle over the candles to zoom both time and price. Replay keeps the selected candle count as time advances. Clear price zone returns only that chart to the automatic 80-candle range.</p>
      <p role="status" className="text-sm">Replay clock: {daily?new Date(clock).toLocaleString("en-US",{timeZone:daily.instrument.zone}):"unavailable"} · {running?"Playing":stoppedAt!==null?"Simulated hold stopped":next?"Paused":"End of stored 5-minute candles"} · {timeline.length?`5-minute source starts ${timeline[0].day}`:"No 5-minute candles available"}</p>
      <p className="text-xs text-slate-400">Entry {trade.entry??"unavailable"} · Original SL {trade.stop??"unavailable"} · Original target {trade.target??"unavailable"} · {mark===undefined?"No revealed 5-minute price":`Revealed close ${number(mark)}`} · {pnl===null?"P&L unavailable":`Manual-hold price P&L per unit ${number(pnl)}${trade.entry!==null && trade.stop!==null && trade.entry!==trade.stop ? ` · ${(pnl/Math.abs(trade.entry-trade.stop)).toFixed(2)}R` : ""}`} · Before fees. Paper exits use completed 5-minute candles from every chart; stop first when both levels are hit in one candle.</p>
      <div className={focus==="all"?"grid gap-2 md:grid-cols-6":"grid gap-4"}>{[...panels].sort((a,b)=>replayLayoutOrder.indexOf(a.frame)-replayLayoutOrder.indexOf(b.frame)).map(p=><article key={p.frame} className={`${focus!=="all" && focus!==p.frame?"hidden ":""}${focus==="all" ? (["15m","1h","1mo"].includes(p.frame)?"md:col-span-2 ":"md:col-span-3 ") : ""}min-w-0 rounded border border-white/10 p-2`}>{!p.bars.length?<p role="status">No completed {p.title} candles at this replay time.</p>:null}<WeeklyReplayChart developingBar={p.developing} expanded={focus===p.frame} onToggleExpand={()=>setFocus(focus===p.frame?"all":p.frame)} fixedPriceRange={priceRanges[p.frame]??null} onPriceRangeChange={changePriceRange} crosshairSync={crosshair} followReplay paperBars={paperBars} onPaperTradesChange={onPaperTradesChange} tradeLevels={tradeLevels} replayCutoff={clock} ictStyle chartHeight={focus==="all"?320:620} title={p.title} frame={p.frame} bars={p.bars} completedDaily={prefix} invalidDays={daily?.invalidDailyDays??[]} market={daily?.instrument.market} viewKey={`${trade.symbol}:${trade.orderId}`} zones={p.zones} referencePoints={p.refs} range={null} target={null} showSwings showEquilibrium={false} selected={selected} onSelect={setSelected} onDaySelect={noop} plan={trade.entry!==null && trade.stop!==null && trade.target!==null?{entry:trade.entry,stop:trade.stop,target:trade.target,knownAt:entryAt}:null} contextExplanation={<p className="mt-2 text-sm">{p.structure.text}</p>} /></article>)}</div>
      <label className="block text-sm"><input type="checkbox" checked={arrays} onChange={e=>setArrays(e.target.checked)} /> Ordered Premium / Discount Arrays · Monthly → Weekly → Daily</label>{arrays?<div className="grid gap-3 xl:grid-cols-3">{panels.slice(0,3).map(p=><PremiumDiscountArrays key={p.frame} frame={p.frame as "1mo"|"1w"|"1d"} title={p.title} bars={p.bars} range={p.previous} cutoff={clock} zones={p.zones} references={p.refs} invalidDays={daily?.invalidDailyDays??[]} number={number} onSelect={setSelected} />)}</div>:null}
    </>}
  </section>;
}
