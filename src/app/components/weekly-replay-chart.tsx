"use client";
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { CandlestickSeries, ColorType, LineSeries, LineStyle, createChart, createSeriesMarkers, type IChartApi, type ISeriesApi, type Time, type SeriesMarker, type AutoscaleInfo } from "lightweight-charts";
import { deriveIctOverlays, confirmedSwingPath, weekStart, type ReplayBar, type IctOverlay, type WeeklyRange } from "@/lib/weekly-replay";
import { anchorViewport,restoreViewport,viewportChanged,type LogicalViewport,type AnchoredViewport } from "@/lib/replay-viewport";
import {paperResult,type PaperTrade } from "@/lib/paper-trading";
import {nearestPdArrays} from "@/lib/nearest-pd-array";
import {matchingReplayCandle,type ReplayCrosshair} from "@/lib/replay-crosshair";
import { replayFollowRange } from "@/lib/replay-follow-range";
import { replayZoneAnchor } from "@/lib/replay-zone-anchor";
import PaperTrading,{type PaperDraft} from "./paper-trading";
import PaperRiskTool from "./paper-risk-tool";
import type { SwingPlan } from "@/lib/swing-risk";
import type { StrategyReplayEvent } from "@/lib/strategy-replay";
import { ipdaLookback } from "@/lib/ipda-lookback";
import { liquiditySweeps } from "@/lib/liquidity-sweeps";
import { rangeLiquidity } from "@/lib/range-liquidity";
import { timeInfluence } from "@/lib/time-influence";
import { wickRejections } from "@/lib/wick-rejections";
import { zoneMetrics } from "@/lib/zone-metrics";
import { replayFibonacci } from "@/lib/replay-fibonacci";
import type { ReferencePoint } from "@/lib/daily-context";
import type { ReplayFrame as Frame } from "@/lib/weekly-replay";
import { toChartTime } from "./reversal-chart";
import { computeChartFib } from "@/lib/chart-fib";
export type TradeLevel = {label:string;price:number;color:string;knownAt:number;originAt?:number;sourceId?:string};
export type SavedDealingRange = {low:number;high:number;equilibrium:number;lowOrigin:number;highOrigin:number;knownAt:number};
const emptyTradeLevels:TradeLevel[]=[];
const emptyStrategyEvents: StrategyReplayEvent[] = [];
export type ComparisonSegment = { id: string; from: ReplayBar; to: ReplayBar; fromPrice: number; toPrice: number; direction: "BUY" | "SELL" };
const emptySegments: ComparisonSegment[] = [];
const emptyDaily: ReplayBar[] = [];
const emptyReferences: ReferencePoint[] = [];
const timeOf = (b: ReplayBar, frame: Frame | "4h" | "1w" | "1mo"): Time => toChartTime(frame === "1d" || frame === "1w" || frame === "1mo" ? b.day : `${b.day} ${String(Math.floor(b.minute / 60)).padStart(2, "0")}:${String(b.minute % 60).padStart(2, "0")}`);
const lastLookback = (daily: ReplayBar[], bars: ReplayBar[], zones: IctOverlay[]) => { const day=[bars.at(-1)?.day,daily.at(-1)?.day].filter((d): d is string=>!!d).sort().at(-1);return day ? ipdaLookback(daily,day,zones) : null; };
const colors: Record<string, string> = { VI:"#d97706", MITIGATION:"#75a9d6",PROPULSION:"#59ad99",WICK:"#9a7730",REJECTION:"#9a7730",GAP:"#8d72b1",NYOPEN:"#8d72b1", BPR: "#b66b84", FVG: "#537da0", IFVG: "#9a7730", OB: "#b77928", BREAKER: "#a16a4b", EQH: "#8a596d", EQL: "#52758a", BSL: "#8a596d", SSL: "#52758a", BOS: "#52758a", CHOCH: "#7962a4" };
const overlayColor = (zone: IctOverlay, ictStyle: boolean) => (zone.kind === "BPR" || zone.kind === "IFVG" || ictStyle && zone.kind === "FVG") ? zone.direction==="BUY" ? "#58a99c" : "#df8494" : ictStyle && zone.kind === "OB" ? "#75a9d6" : ictStyle && zone.kind === "BREAKER" ? "#8d72b1" : colors[zone.kind];
export default function WeeklyReplayChart({ savedDealingRange, paperDraftControl, initialPaperDraft, sidePanel=false, chochWindow, onVisibleZonesChange, sourceOnlyZones=false, showTradeLevelsInitially=false, developingBar, onToggleExpand, expanded=false, fixedPriceRange, onPriceRangeChange, crosshairSync, followReplay=false, paperBars, onPaperTradesChange, tradeLevels:sourceTradeLevels=emptyTradeLevels, replayCutoff, ictStyle = false, chartHeight = 430, plan = null, bars:completedBars, title, frame, invalidDays, range: sourceRange, target: sourceTarget, zones: sourceZones, showSwings: allowSwings, showEquilibrium, selected, onSelect, onDaySelect, strategyEvents: sourceStrategyEvents = emptyStrategyEvents, market = "us", fitReferenceLevels = true, referencePoints: sourceReferences = emptyReferences, contextExplanation, viewKey, completedDaily = emptyDaily, comparisonSegments: sourceSegments = emptySegments }: {
    savedDealingRange?:SavedDealingRange;
    paperDraftControl?:{draft:PaperDraft;onChange:(draft:PaperDraft)=>void};
    initialPaperDraft?:PaperDraft;
    sidePanel?:boolean;
    chochWindow?:{label?:string;from:ReplayBar;to:ReplayBar;knownAt:number;level:number;startLabel:string;endLabel:string};
    onVisibleZonesChange?:(zones:IctOverlay[])=>void;
    sourceOnlyZones?:boolean;
    showTradeLevelsInitially?:boolean;
    fixedPriceRange?:{from:number;to:number}|null;
    onPriceRangeChange?:(frame:string,range:{from:number;to:number}|null)=>void;
    crosshairSync?:ReplayCrosshair;
    followReplay?:boolean;
    paperBars?:ReplayBar[];
    onPaperTradesChange?:(frame:string,trades:PaperTrade[])=>void;
    tradeLevels?:TradeLevel[];
    replayCutoff?:number;
    ictStyle?: boolean;
    developingBar?: ReplayBar|null;
    chartHeight?: number;
    onToggleExpand?: () => void;
    expanded?: boolean;
    plan?: SwingPlan | null;
    comparisonSegments?: ComparisonSegment[];
    completedDaily?: ReplayBar[];
    viewKey?: string;
    contextExplanation?: ReactNode;
    framework?: string;
    strategyEvents?: StrategyReplayEvent[];
    market?: string;
    fitReferenceLevels?: boolean;
    referencePoints?: ReferencePoint[];
    bars: ReplayBar[];
    title: string;
    frame: Frame | "4h" | "1w" | "1mo";
    invalidDays: string[];
    range: WeeklyRange | null;
    target: number | null;
    zones: IctOverlay[];
    showSwings: boolean;
    showEquilibrium: boolean;
    selected: string;
    onSelect: (id: string) => void;
    onDaySelect: (day: string) => void;
}) {
    const bars=useMemo(()=>developingBar ? [...completedBars,developingBar] : completedBars,[completedBars,developingBar]);
    const [chartPaperTrades,setChartPaperTrades]=useState<PaperTrade[]>([]);
    const handlePaperTrades=useCallback((f:string,trades:PaperTrade[])=>{setChartPaperTrades(trades);onPaperTradesChange?.(f,trades);},[onPaperTradesChange]);
    const [localPaperDraft,setLocalPaperDraft]=useState<PaperDraft>(initialPaperDraft??{direction:"BUY",stop:"",target:""});
    const paperDraft=paperDraftControl?.draft??localPaperDraft;
    const setPaperDraft=paperDraftControl?.onChange??setLocalPaperDraft;
    const paperClock=(paperBars??completedBars).at(-1)?.knownAt??0;
    const frozenPaper=chartPaperTrades.filter(t=>t.placedAt<=paperClock).at(-1);
    const frozenResult=frozenPaper?paperResult(frozenPaper,paperBars??completedBars):null;
    const riskAnchor=frozenPaper?completedBars.findLast(b=>b.knownAt<=frozenPaper.placedAt):undefined;
    const riskEnd=frozenResult&&frozenResult.status!=="Open"?completedBars.findLast(b=>b.knownAt<=frozenResult.at):completedBars.at(-1);
    const [layers, setLayers] = useState({ vi: false, fvg: true, bpr: true, ob: true, breaker: true, pools: true, structure: false, references: true, equilibrium: false, voids: false, swings: false, strategy: true, comparison: true, range: true, target: true, threshold: false, plan: false, htf: false, trade:showTradeLevelsInitially });
    const [toolFocus,setToolFocus]=useState<"default"|"context"|"setup"|"execution"|"all">("default");
    const [showRangeLiquidity,setShowRangeLiquidity]=useState(false);
    const [nearestPD,setNearestPD]=useState(false);
    const drawOnLiquidity=layers.pools && layers.references && layers.range;
    const tradeLevels=useMemo(()=>layers.trade?sourceTradeLevels.filter(l=>l.knownAt<=(replayCutoff??bars.at(-1)?.knownAt??0)):emptyTradeLevels,[layers.trade,sourceTradeLevels,replayCutoff,bars]);
    const layerControls = [ ["trade", "Entry / SL / targets"], ["vi", "Volume imbalance (body gaps)"], ["fvg", "BISI / SIBI · FVG / IFVG inefficiencies"], ["bpr", "Balanced Price Range (BPR)"], ["ob", "Orderblock zones"], ["breaker", "Bullish / bearish breakers"], ["pools", "Liquidity pools / equal highs & lows"], ["structure", "BOS / CHOCH lines"], ["references", "Old highs / lows & reference levels"], ["equilibrium", "Equilibrium"], ["voids", "Liquidity voids"], ["swings", "Swing dots & ticks"], ["strategy", "Strategy order markers"], ["comparison", "SMT divergence lines & markers"], ["range", "Previous range high / low"], ["target", "Target line"], ["threshold", "OB mean threshold (body midpoint)"], ["plan", "Risk / reward plan"], ["htf", "HTF array levels on this chart"] ] as const;
    const zones = useMemo(() => sourceZones.filter(z => z.kind === "VI" ? layers.vi : z.kind === "FVG" || z.kind === "IFVG" ? layers.fvg : z.kind === "BPR" ? layers.bpr : ["OB","MITIGATION","PROPULSION"].includes(z.kind) ? layers.ob : z.kind === "BREAKER" ? layers.breaker : ["BSL", "SSL", "EQH", "EQL"].includes(z.kind) ? layers.pools : layers.structure), [sourceZones, layers]);
    const meanThresholds = useMemo<ReferencePoint[]>(() => sourceZones.filter(z=>z.kind==="OB" && z.status!=="SWEPT").sort((a,b)=>b.knownAt-a.knownAt).filter((z,i)=>i<4 || z.id===selected).flatMap(z=>{const origin=bars.find(b=>b.t===z.origin);if(!origin)return [];const midpoint=(origin.o+origin.c)/2;return [{kind:`OB mean threshold ${z.direction}`,low:midpoint,high:midpoint,knownAt:z.knownAt,originDay:z.originDay,timing:"Before day" as const,response:"50% of the origin candle body"}];}),[sourceZones,bars,selected]);
    const referencePoints = useMemo(() => [...sourceReferences,...meanThresholds].filter(p => /^(Monthly|Weekly|Daily) (OB|FVG|IFVG|BREAKER)/.test(p.kind) && !layers.htf ? false : /mean threshold/i.test(p.kind) ? layers.threshold && layers.ob : /BPR/.test(p.kind) ? layers.bpr : /FVG/.test(p.kind) ? layers.fvg : /OB/.test(p.kind) ? layers.ob : /breaker/i.test(p.kind) ? layers.breaker : /equilibrium/i.test(p.kind) ? layers.equilibrium : /void/i.test(p.kind) ? layers.voids : /clean|pool/i.test(p.kind) ? layers.pools : layers.references), [sourceReferences, meanThresholds, layers]);
    const strategyEvents = layers.strategy ? sourceStrategyEvents : emptyStrategyEvents;
    const comparisonSegments = layers.comparison ? sourceSegments : emptySegments;
    const showSwings = allowSwings && layers.swings;
    const range = layers.range ? sourceRange : null;
    const target = layers.target ? sourceTarget : null;
    const precision=market==="forex" ? /JPY/.test(title) ? 3 : /XAU|XAG/.test(title) ? 2 : 5 : 2;
    const number=useCallback((p:number)=>p.toFixed(precision),[precision]);
    const [selectPriceZone,setSelectPriceZone]=useState(false);
    const labelHistory=useRef(new Map<string,string[]>());
    const [removedLabelCounts,refreshLabelHistory]=useState<Record<string,number>>({});
    const redrawLabels=useRef<(()=>void)|null>(null);
    const labelScope=`${viewKey??market}:${frame}`;
    const bindLabel=useCallback((node:HTMLElement,id:string)=>{
        node.dataset.replayLabelId=id;
        node.style.pointerEvents="auto";
        node.style.cursor="context-menu";
        node.title=`${node.title?node.title+" · ":""}Right-click to remove this chart item; Undo restores it`;
        if(labelHistory.current.get(labelScope)?.includes(id))node.style.display="none";
        node.oncontextmenu=event=>{
            event.preventDefault();event.stopPropagation();
            const history=labelHistory.current.get(labelScope)??[];
            if(history.includes(id))return;
            labelHistory.current.set(labelScope,[...history,id]);
            redrawLabels.current?.();refreshLabelHistory(v=>({...v,[labelScope]:history.length+1}));
        };
    },[labelScope]);
    const undoLabel=()=>{
        const history=labelHistory.current.get(labelScope)??[];
        labelHistory.current.set(labelScope,history.slice(0,-1));
        redrawLabels.current?.();refreshLabelHistory(v=>({...v,[labelScope]:Math.max(0,history.length-1)}));
    };
    const [priceBrush,setPriceBrush]=useState<{x:number;y:number;endX:number;endY:number}|null>(null);
    const referenceLayer = useRef<HTMLDivElement>(null);
    const host = useRef<HTMLDivElement>(null), chartRef = useRef<IChartApi | null>(null), seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const manualTimeView = useRef<{scope:string;view:AnchoredViewport}|null>(null);
    const resetTimeView = useRef(false);
    const resetLogicalView=useRef<LogicalViewport|null>(null);
    const manualPriceView = useRef<{ scope: string; range: { from: number; to: number } } | null>(null);
    const followWindow = useRef<{scope:string;count:number;clock:number;range:{from:number;to:number}}|null>(null);
    const explicitWindow = useRef(false);
    const brushStart = useRef<{x:number;y:number}|null>(null);
    const viewport = useRef<number | null>(null), [readout, setReadout] = useState<{
        t: number;
        text: string;
    }>();
    const [showLookback,setShowLookback] = useState(false);
    const dailyForLookback=completedDaily.length ? completedDaily : frame==="1d" ? completedBars : emptyDaily;
    const dailyLookbackZones=useMemo(()=>dailyForLookback.length ? deriveIctOverlays(dailyForLookback,"1d",market,dailyForLookback) : [],[dailyForLookback,market]);
    const lookback=useMemo(()=>lastLookback(dailyForLookback,bars, dailyLookbackZones),[dailyForLookback,bars,dailyLookbackZones]);
    const [showSweepBoxes,setShowSweepBoxes] = useState(false);
    const sweepEvents=useMemo(()=>liquiditySweeps(completedBars,frame,invalidDays).sweeps,[completedBars,frame,invalidDays]);
    const [showTimeInfluence,setShowTimeInfluence] = useState(false);
    const intradayFrame = !["1d","1w","1mo"].includes(frame);
    const timingWindows = useMemo(()=>intradayFrame ? timeInfluence(completedBars,completedDaily) : [],[completedBars,completedDaily,intradayFrame]);
    const [showWicks, setShowWicks] = useState(false);
    const wickZones = useMemo(() => frame === "1w" || frame === "1mo" ? wickRejections(completedBars, frame, invalidDays) : [], [completedBars, frame, invalidDays]);
    const drawnWicks = useMemo(() => [...wickZones].reverse().filter(z => z.status !== "INVALIDATED").slice(0, 4), [wickZones]);
    const [showZoneLabels, setShowZoneLabels] = useState(true);
    const [showFib, setShowFib] = useState(false), [showRetracement, setShowRetracement] = useState(true);
    const fib = useMemo(() => replayFibonacci(completedBars, frame, invalidDays), [completedBars, frame, invalidDays]);
    // Trend-based Fib extension (A-B-C) from completed candles only, same engine as the Fib Calculation page.
    const [showExtension, setShowExtension] = useState(false);
    const fibExt = useMemo(() => showExtension ? computeChartFib(completedBars).extension : null, [completedBars, showExtension]);
    const last = bars.at(-1), swings = useMemo(() => confirmedSwingPath(completedBars, frame, invalidDays), [completedBars, frame, invalidDays]);
    const activeZones = useMemo(() => {
        const counts = new Map<string, number>();
        const nearest=nearestPD && last ? new Set(nearestPdArrays(zones,last.c,replayCutoff??last.knownAt).map(z=>z.id)) : null;
        return [...zones].sort((a, b) => b.knownAt - a.knownAt).filter(z => {
            if(nearest && ["FVG","IFVG","OB","BREAKER"].includes(z.kind))return nearest.has(z.id);
            if (z.id === selected) return true;
            if(sourceOnlyZones)return true;
            if (z.status === "SWEPT") return false;
            if(z.kind==="FVG" && z.status==="ACTIVE" && z.touches===0)return true;
            const category = z.kind === "BREAKER" ? `${z.kind}:${z.direction}` : z.kind;
            const count = counts.get(category) ?? 0;
            counts.set(category, count + 1);
            return count < 2;
        });
    }, [zones, selected,nearestPD,last,replayCutoff,sourceOnlyZones]);
    useEffect(()=>{onVisibleZonesChange?.(activeZones);},[activeZones,onVisibleZonesChange]);
    const liquidity = useMemo(()=>rangeLiquidity(sourceReferences,sourceZones),[sourceReferences,sourceZones]);
    const labeledZones = useMemo(() => {
        const candidates = !sourceOnlyZones && referencePoints.some(p => p.kind.includes("FVG") || p.kind.includes("OB")) ? deriveIctOverlays(completedBars, frame, market, completedBars) : [];
        const referenced = (nearestPD ? [] : candidates).filter(z => ["FVG", "OB"].includes(z.kind) && referencePoints.some(p => p.kind.includes(z.kind) && p.knownAt === z.knownAt && p.low === z.low && p.high === z.high));
        const unique = new Map([...referenced, ...activeZones].filter(z => ["VI","FVG","IFVG","OB","BPR"].includes(z.kind)).map(z => [z.id,z]));
        const counts = new Map<string,number>();
        return [...unique.values()].sort((a,b)=>b.knownAt-a.knownAt).filter(z => {
            if (z.id === selected || sourceOnlyZones) return true;
            if(z.kind==="FVG" && z.status==="ACTIVE" && z.touches===0)return true;
            const count = counts.get(z.kind) ?? 0; counts.set(z.kind,count+1); return count < 2;
        });
    }, [completedBars, frame, market, referencePoints, activeZones, selected,nearestPD,sourceOnlyZones]);
    useEffect(() => {
        if (!host.current || !bars.length)
            return;
        const scope = `${viewKey ?? `${market}:${bars[0].t}:${bars[0].o}`}:${frame}`;
        const chart = createChart(host.current, { autoSize: true, layout: { background: { type: ColorType.Solid, color: ictStyle ? "#ffffff" : "#fafafa" }, textColor: "#4b5563", fontSize: 11 }, grid: { vertLines: { color: "#e8e8e8", visible: !ictStyle }, horzLines: { visible: false } }, rightPriceScale: { borderColor: "#d9dde2", scaleMargins: { top: followReplay ? 0 : .16, bottom: followReplay ? 0 : .16 } }, timeScale: { borderColor: "#d9dde2", timeVisible: frame !== "1d" && frame !== "1w" && frame !== "1mo", secondsVisible: false, rightOffset: followReplay ? 0 : 5, minBarSpacing: followReplay ? 1 : 5, lockVisibleTimeRangeOnResize: followReplay }, crosshair: { mode: 0 }, handleScroll: true, handleScale: true });
        chartRef.current = chart;
        const itemSeries=new Map<string,ISeriesApi<"Line">[]>();
        const trackItem=(id:string,edge:ISeriesApi<"Line">)=>itemSeries.set(id,[...(itemSeries.get(id)??[]),edge]);
        const itemHidden=(id:string)=>labelHistory.current.get(labelScope)?.includes(id)??false;
        const series = chart.addSeries(CandlestickSeries, { upColor: "#3a9e40", downColor: "#101010", borderUpColor: "#3a9e40", borderDownColor: "#101010", wickUpColor: "#9ca3af", wickDownColor: "#9ca3af", priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision, minMove: 10 ** -precision } });
        seriesRef.current = series;
        series.setData(bars.map(b => ({ time: timeOf(b, frame), open: b.o, high: b.h, low: b.l, close: b.c })));
        // Include the live reference and draw in auto-scale, even beyond current candles.
        series.applyOptions({ autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => { const info = original(); if(fixedPriceRange)return {priceRange:{minValue:fixedPriceRange.from,maxValue:fixedPriceRange.to}}; if(followReplay){const priceRange=replayFollowRange(bars,10**-precision);return priceRange ? {priceRange} : info;} if (!info?.priceRange)
                return null; const focused = activeZones.find(z => z.id === selected); const values = [...(showRangeLiquidity && liquidity?[liquidity.low,liquidity.high]:[]),...tradeLevels.map(l=>l.price),...(focused ? [focused.low, focused.high] : []), ...(range ? [range.high, range.low] : []), ...(target === null ? [] : [target]), ...(layers.plan && plan && plan.knownAt <= (last?.knownAt ?? 0) ? [plan.entry,plan.stop,plan.target] : []), ...(fitReferenceLevels ? referencePoints.flatMap(p => [p.low, p.high]) : []), ...(fib && (showFib || showRetracement) ? [fib.low, fib.high] : []), ...(showLookback && lookback ? lookback.windows.filter(w => w.complete).flatMap(w => [w.high!, w.low!]) : [])]; return { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, ...values), maxValue: Math.max(info.priceRange.maxValue, ...values) } }; } });
        if (showLookback && lookback) {
            for(const window of lookback.windows){if(!window.complete || !window.first || !last)continue;const first=bars.find(b=>b.knownAt>=window.first!.knownAt);if(!first)continue;for(const value of [window.high!,window.low!]){const edge=chart.addSeries(LineSeries,{color:window.count===20?"#778799":window.count===40?"#8d7d90":"#9b8b70",lineWidth:1,lineStyle:LineStyle.Dashed,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});const from=timeOf(first,frame),to=timeOf(last,frame);edge.setData(from===to?[{time:from,value}]:[{time:from,value},{time:to,value}]);}}
        }
        if(showRangeLiquidity && liquidity)for(const [price,label] of [[liquidity.high,"ERL · Buyside Liquidity"],[liquidity.low,"ERL · Sellside Liquidity"]] as const)series.createPriceLine({price,color:"#775166",lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:label});
        if (range) {
            for (const p of [range.high, range.low])
                series.createPriceLine({ price: p, color: "#6984a0", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "" });
            if (showEquilibrium && layers.equilibrium)
                series.createPriceLine({ price: range.midpoint, color: "#a0a0a0", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
        }
        if (target !== null)
            series.createPriceLine({ price: target, color: "#a57832", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
        if (layers.plan && plan && plan.knownAt <= (last?.knownAt ?? 0)) for(const [price,color] of [[plan.entry,"#64748b"],[plan.stop,"#bc5555"],[plan.target,"#2c8b76"]] as const) series.createPriceLine({price,color,lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:""});
        if (fib && (showFib || showRetracement)) {
            for (const level of fib.levels.filter(l => showFib && [0, .5, 1].includes(l.ratio) || showRetracement && [.62, .705, .79].includes(l.ratio))) {
                const edge = chart.addSeries(LineSeries, { title: "", color: "#8c8174", lineWidth: 1, lineStyle: level.ratio === .5 ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
                const anchor = bars.find(b => b.t === fib.origin);
                if (anchor) edge.setData([{ time: timeOf(anchor, frame), value: level.price }, { time: timeOf(bars.at(-1)!, frame), value: level.price }]);
            }
        }
        if (fibExt && bars.length) {
            const anchor = bars.find(b => b.t >= fibExt.startT) ?? bars[0];
            for (const level of fibExt.levels) {
                const edge = chart.addSeries(LineSeries, { title: level.label, color: level.color, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
                edge.setData(anchor.t === bars.at(-1)!.t ? [{ time: timeOf(anchor, frame), value: level.price }] : [{ time: timeOf(anchor, frame), value: level.price }, { time: timeOf(bars.at(-1)!, frame), value: level.price }]);
            }
            const leg = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 2, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
            const legPoints = fibExt.anchors.points.flatMap(p => { const bar = bars.find(b => b.t === p.t); return bar ? [{ time: timeOf(bar, frame), value: p.price }] : []; });
            leg.setData(legPoints.filter((p, i) => i === legPoints.length - 1 || p.time !== legPoints[i + 1].time));
        }
        for (const ref of referencePoints) {
            const eligible = bars.filter(b => b.knownAt >= ref.knownAt);
            if (!eligible.length) continue;
            const color = ref.kind.includes("OB") ? ictStyle ? "#75a9d6" : "#b77928" : ref.kind.includes("FVG") ? "#537da0" : ref.kind.includes("void") ? "#a16a4b" : ref.kind.includes("equilibrium") ? "#8b806e" : "#8a596d";
            for (const price of [...new Set([ref.low, ref.high])]) {
                const edge = chart.addSeries(LineSeries, { title: "", color, lineWidth: 1, lineStyle: /equilibrium|mean threshold/i.test(ref.kind) ? LineStyle.Dashed : LineStyle.Solid, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: eligible.length === 1, pointMarkersRadius: 3, autoscaleInfoProvider: () => null });
                const matchingZone=sourceZones.find(z=>ref.kind.includes(z.kind)&&z.knownAt===ref.knownAt&&z.low===ref.low&&z.high===ref.high);
                trackItem(matchingZone?`zone:${matchingZone.id}`:`reference:${ref.kind}:${ref.knownAt}:${ref.low}:${ref.high}`,edge);
                edge.setData(eligible.length === 1 ? [{ time: timeOf(eligible[0], frame), value: price }] : [{ time: timeOf(eligible[0], frame), value: price }, { time: timeOf(eligible.at(-1)!, frame), value: price }]);
            }
        }
        const stopMarkers: SeriesMarker<Time>[] = referencePoints.filter(p => p.response.startsWith("Stop-run")).flatMap(p => {
            const candle = bars.findLast(b => b.day === p.observedDay);
            if (!candle) return [];
            const high = p.kind.toLowerCase().includes("high");
            return [{ time: timeOf(candle, frame), position: high ? "aboveBar" : "belowBar", shape: high ? "arrowDown" : "arrowUp", color: "#a66a45", text: "", size: .7 } as SeriesMarker<Time>];
        });
        const orderMarkers: SeriesMarker<Time>[] = strategyEvents.flatMap(event => {
            // A marker is attached only to a revealed candle containing the actual recorded event.
            const candle = bars.find(b => event.at >= b.t && event.at < b.knownAt);
            if (!candle) return [];
            return [{time:timeOf(candle,frame),position:event.direction === "BUY" ? "belowBar" : "aboveBar",shape:event.direction === "BUY" ? "arrowUp" : "arrowDown",color:event.label.includes("fill") ? "#168443" : "#877523",text:event.label,size:1} as SeriesMarker<Time>];
        });
        for (const segment of comparisonSegments) {
            const line=chart.addSeries(LineSeries,{color:segment.direction==="BUY" ? "#29835c" : "#ac594a",lineWidth:selected===segment.id ? 3 : 2,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
            if(segment.from.t<segment.to.t)line.setData([{time:timeOf(segment.from,frame),value:segment.fromPrice},{time:timeOf(segment.to,frame),value:segment.toPrice}]);
        }
        const divergenceMarkers: SeriesMarker<Time>[] = comparisonSegments.map(s=>({time:timeOf(s.to,frame),position:s.direction==="BUY" ? "belowBar" : "aboveBar",shape:"circle",color:s.direction==="BUY" ? "#29835c" : "#ac594a",text:"SMT",size:.6}));
        const timingMarkers: SeriesMarker<Time>[] = showTimeInfluence ? timingWindows.filter(w=>w.closed).flatMap(w=>[{time:timeOf(w.low,frame),position:"belowBar" as const,shape:"arrowUp" as const,color:"#55866a",text:w.lowOfDay ? "NY-day low" : "Window low",size:.5},{time:timeOf(w.high,frame),position:"aboveBar" as const,shape:"arrowDown" as const,color:"#a07262",text:w.highOfDay ? "NY-day high" : "Window high",size:.5}]) : [];
        const eventMarkers = [...stopMarkers,...orderMarkers,...timingMarkers,...divergenceMarkers].sort((a,b)=>String(a.time).localeCompare(String(b.time)));
        if (!showSwings && eventMarkers.length) createSeriesMarkers(series, eventMarkers);
        if (showSwings) {
            const byOrigin = new Map(bars.map(b => [b.t, b]));
            const markers: SeriesMarker<Time>[] = swings.filter(s => byOrigin.has(s.origin)).map(s => ({ time: timeOf(byOrigin.get(s.origin)!, frame), position: s.kind === "HIGH" ? "aboveBar" : "belowBar", shape: "circle", color: "#7288a4", size: .4, text: "" }));
            createSeriesMarkers(series, [...markers, ...eventMarkers].sort((a,b) => String(a.time).localeCompare(String(b.time))));
            for (const swing of swings.slice(-40)) {
                const i = bars.findIndex(b => b.t === swing.origin);
                if (i < 1 || i + 1 >= bars.length)
                    continue;
                const tick = chart.addSeries(LineSeries, { color: "#889bb2", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: () => null });
                tick.setData([{ time: timeOf(bars[i - 1], frame), value: swing.price }, { time: timeOf(bars[i + 1], frame), value: swing.price }]);
            }
        }
        // Optional layers use explicit per-category limits; daily explanation references are independent.
        for (const z of activeZones) {
            const from = replayZoneAnchor(bars,z);
            if (!from || !last)
                continue;
            for (const p of [...new Set([z.low, z.high])]) {
                if(z.kind==="IFVG"){
                    const original=sourceZones.find(candidate=>candidate.id===z.lineage);
                    const origin=original&&replayZoneAnchor(bars,original);
                    if(origin && origin.t<from.t){
                        const prior=chart.addSeries(LineSeries,{color:z.direction==="BUY"?"#58a99c":"#df8494",lineWidth:1,lineStyle:LineStyle.Dotted,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});
                        trackItem(`zone:${z.id}`,prior);
                        prior.setData([{time:timeOf(origin,frame),value:p},{time:timeOf(from,frame),value:p}]);
                    }
                }
                const edge = chart.addSeries(LineSeries, { color: overlayColor(z,ictStyle), lineWidth: selected === z.id ? 2 : 1, lineStyle: z.kind === "FVG" || z.kind === "IFVG" ? LineStyle.Dashed : LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: "", autoscaleInfoProvider: () => null });
                if(z.kind==="IFVG")edge.applyOptions({lineStyle:LineStyle.Solid,pointMarkersVisible:true,pointMarkersRadius:2});
                trackItem(`zone:${z.id}`,edge);
                const start = timeOf(from, frame), end = timeOf(last, frame);
                edge.setData(start === end ? [{ time: start, value: p }] : [{ time: start, value: p }, { time: end, value: p }]);
            }
        }
        if (showWicks) for (const zone of drawnWicks) {
            const start = bars.find(b => b.knownAt >= zone.knownAt);
            if (!start || !last) continue;
            for (const price of [zone.low,zone.high]) {
                const edge = chart.addSeries(LineSeries,{color: "#bf835d", lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: ()=>null});
                const from = timeOf(start,frame), until = timeOf(last,frame);
                edge.setData(from === until ? [{time:from,value:price}] : [{time:from,value:price},{time:until,value:price}]);
            }
        }
        // DOM annotations use the chart's own time/price coordinates, so boxes track pan and zoom.
        const drawReferences = () => {
            for(const [id,edges] of itemSeries)for(const edge of edges){const visible=!itemHidden(id);if(edge.options().visible!==visible)edge.applyOptions({visible});}
            if(host.current){host.current.dataset.visibleLogicalRange=JSON.stringify(chart.timeScale().getVisibleLogicalRange());host.current.dataset.visiblePriceRange=JSON.stringify(chart.priceScale("right").getVisibleRange());}
            const layer = referenceLayer.current;
            if (!layer) return;
            if (host.current) {
                host.current.dataset.priceRange = JSON.stringify(chart.priceScale("right").getVisibleRange());
                host.current.dataset.logicalRange = JSON.stringify(chart.timeScale().getVisibleLogicalRange());
                host.current.dataset.priceAutoScale = String(chart.priceScale("right").options().autoScale);
            }
            layer.replaceChildren();
            // Trade rays begin at entry, never across the preceding price history.
            const plotRight=Math.max(0,(host.current?.clientWidth??0)-chart.priceScale("right").width());
            if(savedDealingRange && savedDealingRange.knownAt<=(replayCutoff??last?.knownAt??0)){
                const r=savedDealingRange;
                const start=bars.findIndex(b=>b.t>=Math.min(r.lowOrigin,r.highOrigin));
                const x=chart.timeScale().logicalToCoordinate(Math.max(0,start) as import("lightweight-charts").Logical);
                const hi=series.priceToCoordinate(r.high),eq=series.priceToCoordinate(r.equilibrium),lo=series.priceToCoordinate(r.low);
                if(x!==null&&hi!==null&&eq!==null&&lo!==null){
                    const left=Math.max(0,x),right=plotRight;
                    for(const [name,top,bottom,color] of [["Premium · above 50%",hi,eq,"rgba(220,80,100,.07)"],["Discount · below 50%",eq,lo,"rgba(50,160,130,.07)"]] as const){
                        const box=document.createElement("div");box.dataset.ictDealingRange=name;box.dataset.knownAt=String(r.knownAt);box.dataset.low=String(r.low);box.dataset.high=String(r.high);box.dataset.equilibrium=String(r.equilibrium);
                        box.style.cssText=`position:absolute;left:${left}px;top:${Math.max(0,top)}px;width:${Math.max(0,right-left)}px;height:${Math.max(0,Math.min(chartHeight-25,bottom)-Math.max(0,top))}px;background:${color};pointer-events:none;`;
                        const caption=document.createElement("span");caption.textContent=name;caption.style.cssText="position:absolute;left:8px;top:4px;font:600 10px sans-serif;color:#64748b;";box.append(caption);layer.append(box);
                    }
                }
            }
            const levelLabelRows:number[]=[];
            for(const level of [...tradeLevels].sort((a,b)=>b.price-a.price)){
                if(itemHidden(`trade:${level.knownAt}:${level.label}`))continue;
                const rayStart=level.originAt??level.knownAt;
                let anchor=bars.findIndex(b=>b.t>=rayStart);
                if(anchor<0){const tail=bars.at(-1)!;anchor=rayStart<tail.knownAt ? bars.length-1+(rayStart-tail.t)/(tail.knownAt-tail.t) : bars.length;}
                else if(anchor>0){
                    const before=bars[anchor-1];
                    // Interpolate only inside a candle, not across a session gap.
                    if(rayStart<before.knownAt)anchor=anchor-1+(rayStart-before.t)/(before.knownAt-before.t);
                }
                const x=chart.timeScale().logicalToCoordinate(anchor as import("lightweight-charts").Logical);
                const y=series.priceToCoordinate(level.price);
                if(x===null || y===null || x>=plotRight || y<0 || y>chartHeight)continue;
                const left=Math.max(0,x);
                const ray=document.createElement("div");
                ray.dataset.tradeRay=level.label;
                ray.dataset.entryAt=String(level.knownAt);
                ray.dataset.sourceId=level.sourceId??"";
                ray.dataset.originAt=String(rayStart);
                ray.style.cssText=`position:absolute;left:${left}px;top:${y}px;width:${plotRight-left}px;border-top:2px dashed ${level.color};`;
                const label=document.createElement("span");
                label.textContent=`${level.label} ${number(level.price)}`;
                let labelY=Math.max(4,y-16);
                while(levelLabelRows.some(row=>Math.abs(row-labelY)<17))labelY+=18;
                if(labelY>chartHeight-45){labelY=Math.max(4,y-16);while(levelLabelRows.some(row=>Math.abs(row-labelY)<17)&&labelY>18)labelY-=18;}
                levelLabelRows.push(labelY);
                label.title=`${level.sourceId??level.label} · origin ${new Date(rayStart).toISOString()} · known ${new Date(level.knownAt).toISOString()}`;
                label.style.cssText=`position:absolute;right:3px;top:${labelY-y}px;color:${level.color};background:rgba(255,255,255,.96);font:600 11px sans-serif;white-space:nowrap;padding:1px 3px;border-left:2px solid ${level.color};`;
                if(Math.abs(labelY-(y-16))>5){const leader=document.createElement("span");leader.style.cssText=`position:absolute;right:0;top:${Math.min(0,labelY-y)}px;height:${Math.abs(labelY-y)}px;border-left:1px dotted ${level.color};`;ray.append(leader);}
                bindLabel(label,`trade:${level.knownAt}:${level.label}`);ray.append(label);layer.append(ray);
            }
            if(showLookback && lookback){for(const [label,day] of [["Quarter boundary",lookback.quarterStart],["IPDA anchor",lookback.anchor?.day]] as const){if(!day)continue;const key=frame==="1mo" ? day.slice(0,7)+"-01" : frame==="1w" ? weekStart(day) : day;const bar=bars.find(b=>b.day===key);if(!bar)continue;const x=chart.timeScale().timeToCoordinate(timeOf(bar,frame));if(x===null || x<0 || x>(host.current?.clientWidth??0)-75)continue;const marker=document.createElement("div");marker.style.cssText=`position:absolute;left:${x}px;top:0;height:100%;border-left:1px dashed ${label==="IPDA anchor"?"#b28d52":"#8b91a0"};`;marker.title=`${label}: ${day}`;layer.append(marker);}}
            if (showTimeInfluence) for (const window of timingWindows) {
                const from=chart.timeScale().timeToCoordinate(timeOf(window.first,frame)),to=chart.timeScale().timeToCoordinate(timeOf(window.last,frame));
                if(from===null || to===null)continue;
                const x=Math.max(0,from-4),right=Math.min(host.current?.clientWidth??0,to+4);
                if(right<=x)continue;
                const shade=document.createElement("div");
                shade.style.cssText=`position:absolute;left:${x}px;top:0;width:${right-x}px;height:100%;background:${window.id.startsWith("london")?"rgba(160,145,80,.07)":"rgba(80,130,160,.07)"};`;
                layer.append(shade);
            }
            const width = host.current?.clientWidth ?? 0, height = host.current?.clientHeight ?? chartHeight;
            if(chochWindow && chochWindow.knownAt<=(replayCutoff??last?.knownAt??0)) {
                const startX=chart.timeScale().timeToCoordinate(timeOf(chochWindow.from,frame)), endX=chart.timeScale().timeToCoordinate(timeOf(chochWindow.to,frame));
                const priceY=series.priceToCoordinate(chochWindow.level);
                if(startX!==null && endX!==null && endX>=0 && startX<=width-75) {
                    const left=Math.max(0,startX),right=Math.min(width-75,endX);
                    if(priceY!==null&&priceY>=0&&priceY<height-25){
                        const line=document.createElement('div');line.style.cssText=`position:absolute;left:${left}px;top:${priceY}px;width:${Math.max(1,right-left)}px;border-top:2px solid #7c3aed;pointer-events:none;`;layer.append(line);
                        const label=document.createElement('div');label.textContent=`${chochWindow.label??"CHOCH"} · ${chochWindow.startLabel} → ${chochWindow.endLabel}`;label.title=`Confirmed at candle close: ${new Date(chochWindow.knownAt).toISOString()}`;label.style.cssText=`position:absolute;left:${left+4}px;top:${Math.max(2,priceY-20)}px;font:600 10px sans-serif;color:#6d28d9;background:rgba(255,255,255,.95);padding:2px 4px;`;layer.append(label);
                        for(const x of [startX,endX])if(x>=0&&x<=width-75){const cap=document.createElement('div');cap.style.cssText=`position:absolute;left:${x}px;top:${priceY-5}px;height:10px;border-left:2px solid #7c3aed;pointer-events:none;`;layer.append(cap);}
                    }
                }
            }

            if (layers.plan && plan && last && plan.knownAt<=last.knownAt) {
                const x0=chart.timeScale().timeToCoordinate(timeOf(last,frame));
                if(x0!==null) for(const [price,color,label] of [[plan.stop,"rgba(220,80,80,.20)","Planned risk"],[plan.target,"rgba(35,165,140,.20)","Planned reward"]] as const){
                    const entryY=series.priceToCoordinate(plan.entry),endY=series.priceToCoordinate(price);if(entryY===null || endY===null)continue;
                    const left=Math.max(0,x0),right=Math.min(width-75,x0+70),top=Math.max(0,Math.min(entryY,endY)),bottom=Math.min(height-25,Math.max(entryY,endY));if(right<left || bottom<top)continue;
                    const box=document.createElement("div");box.dataset.riskReward=label;box.title=label;box.style.cssText=`position:absolute;left:${left}px;top:${top}px;width:${right-left}px;height:${Math.max(1,bottom-top)}px;background:${color};border:1px solid rgba(100,100,100,.3);`;layer.append(box);
                }
            }
            if (showLookback && lookback && last) for (const window of [...lookback.windows].reverse()) {
                if (!window.complete || !window.first) continue;
                const start = bars.find(b => b.knownAt >= window.first!.knownAt);
                if (!start) continue;
                const x0 = chart.timeScale().timeToCoordinate(timeOf(start, frame)), x1 = chart.timeScale().timeToCoordinate(timeOf(last, frame));
                const y0 = series.priceToCoordinate(window.high!), y1 = series.priceToCoordinate(window.low!);
                if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
                const left = Math.max(0, x0), right = Math.min(width - 75, x1), top = Math.max(0, Math.min(y0, y1)), bottom = Math.min(height - 25, Math.max(y0, y1));
                if (right < left || bottom < top) continue;
                const box = document.createElement("div"); box.dataset.lookbackBox = String(window.count);
                const color = window.count === 20 ? "119,135,153" : window.count === 40 ? "141,125,144" : "155,139,112";
                box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${Math.max(5,right-left)}px;height:${Math.max(1,bottom-top)}px;border:1px dashed rgba(${color},.75);background:rgba(${color},.07);`;
                box.title = `${window.count} completed daily sessions: ${window.first.day}–${window.last?.day}; high ${number(window.high!)} / low ${number(window.low!)}`;
                layer.append(box);
            }
            if (showWicks) for (const zone of drawnWicks) {
                const start = bars.find(b => b.knownAt >= zone.knownAt);
                if (!start || !last) continue;
                const x0 = chart.timeScale().timeToCoordinate(timeOf(start,frame)), x1 = chart.timeScale().timeToCoordinate(timeOf(last,frame));
                const y0 = series.priceToCoordinate(zone.high), y1 = series.priceToCoordinate(zone.low);
                if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
                const left = Math.max(0,x0), right = Math.min(width-75,x1), top = Math.max(0,Math.min(y0,y1)), bottom = Math.min(height-25,Math.max(y0,y1));
                if (right < left || bottom < top) continue;
                const box = document.createElement("div");
                box.dataset.wickRejection = zone.id;
                box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${Math.max(5,right-left)}px;height:${Math.max(2,bottom-top)}px;background:rgba(192,139,96,.22);border:1px solid rgba(157,96,60,.45);`;
                layer.append(box);
            }
            if(showSweepBoxes)for(const sweep of sweepEvents.slice(-30)){
                if(itemHidden(`sweep:${sweep.id}`))continue;
                const from=chart.timeScale().timeToCoordinate(timeOf(sweep.start,frame)),to=chart.timeScale().timeToCoordinate(timeOf(sweep.end,frame));
                const y0=series.priceToCoordinate(sweep.high),y1=series.priceToCoordinate(sweep.low);
                if(from===null || to===null || y0===null || y1===null)continue;
                const left=Math.max(0,from-8),right=Math.min(width-75,to+12),top=Math.max(0,Math.min(y0,y1)),bottom=Math.min(height-25,Math.max(y0,y1));
                if(right<=left || bottom<top)continue;
                const box=document.createElement("div");box.style.cssText=`position:absolute;left:${left}px;top:${top}px;width:${right-left}px;height:${Math.max(3,bottom-top)}px;background:rgba(235,95,105,.28);border:1px solid rgba(210,70,85,.4);`;layer.append(box);
                if(showZoneLabels && sweepEvents.slice(-8).includes(sweep)){const label=document.createElement("span");label.dataset.ictLabel="sweep";label.textContent=sweep.direction==="BUY"?"Sellside sweep":"Buyside sweep";label.style.cssText=`position:absolute;left:${left}px;top:${Math.max(0,top-14)}px;font:10px sans-serif;color:#a34a57;background:rgba(255,255,255,.9);`;bindLabel(label,`sweep:${sweep.id}`);layer.append(label);}
            }
            for(const zone of activeZones.filter(z=>z.kind==="BREAKER")){
                if(itemHidden(`zone:${zone.id}`))continue;
                const start=replayZoneAnchor(bars,zone);if(!start || !last)continue;
                const from=chart.timeScale().timeToCoordinate(timeOf(start,frame)),to=chart.timeScale().timeToCoordinate(timeOf(last,frame)),y0=series.priceToCoordinate(zone.high),y1=series.priceToCoordinate(zone.low);
                if(from===null || to===null || y0===null || y1===null)continue;
                const left=Math.max(0,from),right=Math.min(width-75,to),top=Math.max(0,Math.min(y0,y1)),bottom=Math.min(height-25,Math.max(y0,y1));if(right<left || bottom<top)continue;
                const box=document.createElement("div");box.style.cssText=`position:absolute;left:${left}px;top:${top}px;width:${Math.max(4,right-left)}px;height:${Math.max(2,bottom-top)}px;background:${ictStyle ? "rgba(141,114,177,.09)" : zone.direction==="BUY"?"rgba(65,140,100,.12)":"rgba(180,75,65,.12)"};border:1px solid ${ictStyle ? "#8d72b1" : zone.direction==="BUY"?"#438c64":"#b44b41"};`;layer.append(box);
                if(showZoneLabels){const label=document.createElement("span");label.textContent=zone.direction==="BUY"?"+Breaker":"−Breaker";label.dataset.ictLabel="breaker";label.style.cssText=`position:absolute;left:${left+3}px;top:${top+Math.max(0,(bottom-top)/2-7)}px;font:600 11px sans-serif;background:rgba(255,255,255,.8);color:#67534a;`;bindLabel(label,`zone:${zone.id}`);layer.append(label);}
            }
            const captionRows: number[] = [];
            for (const zone of labeledZones) {
                if(itemHidden(`zone:${zone.id}`))continue;
                const fromBar = replayZoneAnchor(bars,zone);
                if (!fromBar || !last) continue;
                const x0 = chart.timeScale().timeToCoordinate(timeOf(fromBar, frame)), x1 = chart.timeScale().timeToCoordinate(timeOf(last, frame));
                const y0 = series.priceToCoordinate(zone.high), y1 = series.priceToCoordinate(zone.low);
                if (x0 === null || x1 === null || y0 === null || y1 === null) continue;
                const paneHeight=chart.panes()[0].getHeight();
                const left = Math.max(0, x0), right = Math.min(plotRight, x1), top = Math.max(0, Math.min(y0,y1)), bottom = Math.min(paneHeight,Math.max(y0,y1));
                if (right < left || bottom < top || top > paneHeight) continue;
                const box = document.createElement("div");
                const fvg = zone.kind === "FVG" || zone.kind === "IFVG" || zone.kind === "BPR";
                box.dataset.ictZone=zone.kind;box.dataset.origin=String(zone.origin);box.dataset.knownAt=String(zone.knownAt);
                box.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${Math.max(4,right-left)}px;height:${Math.max(1,bottom-top)}px;background:${fvg ? ictStyle ? zone.direction==="BUY" ? "rgba(88,169,156,.30)" : "rgba(232,133,151,.30)" : "rgba(60,130,200,.12)" : ictStyle ? "rgba(135,190,235,.24)" : "rgba(200,140,45,.14)"};border:1px ${zone.kind==="FVG" ? "dashed" : "solid"} ${overlayColor(zone,ictStyle)};`;
                layer.append(box);
                if (!showZoneLabels) continue;
                if(zone.kind==="IFVG"){
                    const original=sourceZones.find(candidate=>candidate.id===zone.lineage);
                    const origin=original&&replayZoneAnchor(bars,original);
                    for(const [point,kind] of [[origin,"FVG origin"],[fromBar,"IFVG confirmed"]] as const){
                        if(!point)continue;
                        const x=chart.timeScale().timeToCoordinate(timeOf(point,frame));
                        if(x===null||x<0||x>plotRight)continue;
                        for(const price of [zone.low,zone.high]){
                            const y=series.priceToCoordinate(price);if(y===null||y<0||y>paneHeight)continue;
                            const dot=document.createElement("span");dot.dataset.ifvgPoint=kind;dot.title=`${kind}: ${new Date(kind==="IFVG confirmed"?zone.knownAt:point.t).toISOString()}`;
                            dot.style.cssText=`position:absolute;left:${x-3}px;top:${y-3}px;width:6px;height:6px;border-radius:50%;background:${overlayColor(zone,ictStyle)};`;
                            layer.append(dot);
                        }
                    }
                }
                const metrics = zoneMetrics(zone, bars);
                const label = document.createElement("span");
                label.textContent = ictStyle ? `${zone.direction==="BUY"?"+":"−"}${zone.kind === "FVG" ? zone.direction === "BUY" ? "BISI / FVG" : "SIBI / FVG" : zone.kind}${zone.status==="SWEPT"?" · invalidated":""}` : `${zone.status === "SWEPT" ? "Invalidated " : ""}${zone.kind} ${zone.direction === "BUY" ? "↑" : "↓"} · ${metrics.completeHistory ? `${metrics.freshness.toFixed(0)}% fresh · ${metrics.filled.toFixed(0)}% filled · ${metrics.touches} touches` : "coverage incomplete"}`;
                label.title = `${zone.kind === "BPR" ? "Overlap of opposing FVGs; direction of later gap, activated after both source gaps are known" : zone.kind === "VI" ? zone.description : zone.kind === "FVG" ? "Three-candle fair value gap: BISI bullish / SIBI bearish" : "Last opposite candle before qualifying displacement / structure break"}; ${metrics.state}; ${metrics.touchBars} intersecting candles; candle-range coverage after confirmation.`;
                let y = ictStyle ? Math.max(0,top+(bottom-top)/2-7) : Math.max(0,top-15);
                while (captionRows.some(row=>Math.abs(row-y)<15) && y < height-40 && (!ictStyle || y+29<=bottom)) y += 15;
                captionRows.push(y);
                label.style.cssText = `position:absolute;left:${ictStyle ? Math.max(left+3,right-55) : Math.max(0,right-260)}px;top:${y}px;padding:1px 3px;font:${ictStyle ? "600 11px" : "10px"} sans-serif;color:${ictStyle ? overlayColor(zone,true) : fvg ? "#275e8d" : "#88530d"};background:rgba(255,255,255,.94);white-space:nowrap;`;
                label.dataset.ictLabel=zone.kind;
                bindLabel(label,`zone:${zone.id}`);
                layer.append(label);
            }
            if(ictStyle && showZoneLabels)for(const zone of activeZones.filter(z=>["BSL","SSL","EQH","EQL"].includes(z.kind))){
                if(itemHidden(`zone:${zone.id}`))continue;
                const origin=bars.find(b=>b.knownAt>=zone.knownAt);if(!origin || !last)continue;
                const from=chart.timeScale().timeToCoordinate(timeOf(origin,frame)),to=chart.timeScale().timeToCoordinate(timeOf(last,frame));
                const y=series.priceToCoordinate((zone.high+zone.low)/2);
                if(from===null || to===null || y===null || y<0 || y>height-25)continue;
                const left=Math.max(0,from),right=Math.min(width-75,to);if(right<=left)continue;
                const label=document.createElement("span");label.dataset.ictLabel="liquidity";
                bindLabel(label,`zone:${zone.id}`);
                label.textContent=["BSL","EQH"].includes(zone.kind)?"Buyside Liquidity":"Sellside Liquidity";
                label.style.cssText=`position:absolute;left:${left+3}px;top:${Math.max(0,y-15)}px;font:600 11px sans-serif;color:#775166;background:rgba(255,255,255,.85);`;
                bindLabel(label,`zone:${zone.id}`);layer.append(label);
            }
            if (fib && (showFib || showRetracement)) {
                const anchor = bars.find(b => b.t === fib.origin);
                const x0 = anchor ? chart.timeScale().timeToCoordinate(timeOf(anchor, frame)) : null;
                const x1 = chart.timeScale().timeToCoordinate(timeOf(bars.at(-1)!, frame));
                if (x0 !== null && x1 !== null) {
                    const x = Math.max(0, x0), end = Math.min(width - 75, x1);
                    if (end >= x) {
                        const shade = (upper: number, lower: number, color: string) => {
                            const y0 = series.priceToCoordinate(upper), y1 = series.priceToCoordinate(lower);
                            if (y0 === null || y1 === null) return;
                            const top = Math.max(0, Math.min(y0,y1)), bottom = Math.min(height-25,Math.max(y0,y1));
                            if (bottom < top) return;
                            const node = document.createElement("div");
                            node.style.cssText = `position:absolute;left:${x}px;top:${top}px;width:${Math.max(5,end-x)}px;height:${Math.max(1,bottom-top)}px;background:${color};border:1px solid rgba(120,110,95,.25);`;
                            layer.append(node);
                        };
                        if (showFib) { shade(fib.high, fib.midpoint, "rgba(177,125,93,.06)"); shade(fib.midpoint, fib.low, "rgba(86,142,93,.06)"); }
                        if (showRetracement) {
                            const prices = fib.levels.filter(l => [.62,.79].includes(l.ratio)).map(l => l.price);
                            shade(Math.max(...prices),Math.min(...prices),"rgba(183,148,74,.10)");
                        }
                    }
                }
            }
            for (const ref of referencePoints) {
                const matchingZone=sourceZones.find(z=>ref.kind.includes(z.kind)&&z.knownAt===ref.knownAt&&z.low===ref.low&&z.high===ref.high);
                if(itemHidden(matchingZone?`zone:${matchingZone.id}`:`reference:${ref.kind}:${ref.knownAt}:${ref.low}:${ref.high}`))continue;
                const eligible = bars.filter(b => b.knownAt >= ref.knownAt);
                if (!eligible.length) continue;
                const from = chart.timeScale().timeToCoordinate(timeOf(eligible[0], frame));
                const until = chart.timeScale().timeToCoordinate(timeOf(eligible.at(-1)!, frame));
                const upper = series.priceToCoordinate(ref.high), lower = series.priceToCoordinate(ref.low);
                if (from === null || until === null || upper === null || lower === null) continue;
                const x = Math.max(0, from), end = Math.min(width - 75, until), top = Math.max(0, Math.min(upper, lower)), bottom = Math.min(height - 25, Math.max(upper, lower));
                if (end < x || top > height - 25 || bottom < 0) continue;
                const box = document.createElement("div");
                const isVoid = ref.kind.includes("void"), isBlock = ref.kind.includes("OB");
                box.style.cssText = `position:absolute;left:${x}px;top:${top}px;width:${Math.max(5,end-x)}px;height:${Math.max(1,bottom-top)}px;border:${ref.low !== ref.high ? "1px solid rgba(160,105,60,.35)" : "none"};background:${ref.low === ref.high ? "transparent" : isVoid ? "rgba(224,144,62,.14)" : isBlock ? ictStyle ? ref.kind.includes("BUY") ? "rgba(59,155,135,.13)" : "rgba(200,121,133,.16)" : "rgba(183,133,89,.12)" : "rgba(90,134,171,.10)"};`;
                layer.append(box);
                if (showZoneLabels && /^TF[12] /.test(ref.kind)) { const label=document.createElement("div"); label.textContent=ref.kind; label.style.cssText=`position:absolute;left:${Math.max(0,end-85)}px;top:${Math.max(2,Math.min(height-40,top+3))}px;font:600 10px sans-serif;background:rgba(255,255,255,.92);color:#426987;padding:1px 3px;`; label.title=ref.response; bindLabel(label,`reference:${ref.kind}:${ref.knownAt}:${ref.low}:${ref.high}`);layer.append(label); }
                if (showZoneLabels && /mean threshold/i.test(ref.kind)) { const label=document.createElement("div"); label.textContent=ref.kind; label.style.cssText=`position:absolute;left:${Math.max(0,end-190)}px;top:${Math.max(0,top-14)}px;font:10px sans-serif;background:rgba(255,255,255,.9);color:#88530d;`; bindLabel(label,`reference:${ref.kind}:${ref.knownAt}:${ref.low}:${ref.high}`);layer.append(label); }
            }
        };
        redrawLabels.current=drawReferences;
        chart.timeScale().subscribeVisibleLogicalRangeChange(drawReferences);
        const resize = new ResizeObserver(drawReferences); resize.observe(host.current);
        const annotationFrame = requestAnimationFrame(drawReferences);
        let syncingCrosshair=false;
        const unsubscribeCursor=crosshairSync?.subscribe(cursor=>{
            if(cursor?.source===frame)return;
            syncingCrosshair=true;
            try{
                const matched=cursor ? matchingReplayCandle(bars,cursor.at) : undefined;
                if(cursor && matched){
                    chart.setCrosshairPosition(cursor.price,timeOf(matched,frame),series);
                    setReadout({t:last!.t,text:`${matched.day} · O ${number(matched.o)} H ${number(matched.h)} L ${number(matched.l)} C ${number(matched.c)} · Cursor ${number(cursor.price)}`});
                }else{chart.clearCrosshairPosition();setReadout(undefined);}
            }finally{syncingCrosshair=false;}
        });
        chart.subscribeCrosshairMove(param => {
            if(syncingCrosshair)return;
            drawReferences();
            if (!param.time) {
                crosshairSync?.publish(null);
                setReadout(undefined);
                return;
            }
            const candle = param.seriesData.get(series);
            if (!candle || !("open" in candle))
                return;
            const b = bars.find(b => String(timeOf(b, frame)) === String(param.time));
            if (!b)
                return;
            const price=param.point ? series.coordinateToPrice(param.point.y) : null;
            if(price!==null)crosshairSync?.publish({source:frame,at:b.t,price});
            setReadout({ t: last!.t, text: `${b.day} · O ${number(candle.open)} H ${number(candle.high)} L ${number(candle.low)} C ${number(candle.close)}` });
        });
        chart.subscribeClick(param => { if (param.time) {
            const b = bars.find(b => String(timeOf(b, frame)) === String(param.time));
            if (b)
                onDaySelect(b.day);
        } });
        const count = manualTimeView.current?.scope===scope ? viewport.current ?? (frame === "1w" ? 14 : 20) : (frame === "1w" ? 14 : 20);
        const savedTime=manualTimeView.current?.scope===scope ? restoreViewport(bars.map(b=>b.t),manualTimeView.current.view) : null;
        const requestedTime=savedTime ?? { from: Math.max(-1, bars.length - count), to: bars.length + 4 };
        if(manualTimeView.current?.scope!==scope) {manualTimeView.current=null;viewport.current=null;}
        if(followWindow.current?.scope!==scope)followWindow.current=null;
        const followCount=followWindow.current?.count??80;
        chart.timeScale().setVisibleLogicalRange(followReplay ? (followWindow.current?.clock===(replayCutoff??last!.knownAt) ? followWindow.current.range : {from:Math.max(-.5,bars.length-followCount-.5),to:bars.length-.5}) : requestedTime);
        const initialTime=chart.timeScale().getVisibleLogicalRange() ?? requestedTime;
        if(followReplay && followWindow.current)followWindow.current={scope,count:followCount,clock:replayCutoff??last!.knownAt,range:{from:initialTime.from,to:initialTime.to}};
        resetTimeView.current=false; resetLogicalView.current=null;
        if(fixedPriceRange){chart.priceScale("right").setVisibleRange(fixedPriceRange);}
        else if(followReplay){manualPriceView.current=null;chart.priceScale("right").setAutoScale(true);}
        else if (manualPriceView.current?.scope === scope) chart.priceScale("right").setVisibleRange(manualPriceView.current.range);
        drawReferences();
        const chartHost=host.current;
        let captureFrame=0;
        let beforeInteraction:{from:number;to:number}|null=null;
        const startPriceInteraction=()=>{beforeInteraction=chart.priceScale("right").getVisibleRange();};
        const finishPriceInteraction=()=>{
            if(!beforeInteraction || !onPriceRangeChange)return;
            const before=beforeInteraction;beforeInteraction=null;
            cancelAnimationFrame(captureFrame);
            captureFrame=requestAnimationFrame(()=>{
                const scale=chart.priceScale("right"),current=scale.getVisibleRange();
                if(current && !scale.options().autoScale && Number.isFinite(current.from) && Number.isFinite(current.to) && current.from<current.to && (Math.abs(current.from-before.from)>1e-7 || Math.abs(current.to-before.to)>1e-7))onPriceRangeChange(frame,current);
            });
        };
        chartHost.addEventListener("pointerdown",startPriceInteraction);
        window.addEventListener("pointerup",finishPriceInteraction);
        chartHost.addEventListener("wheel",startPriceInteraction,{capture:true,passive:true});
        chartHost.addEventListener("wheel",finishPriceInteraction,{passive:true});
        return () => {
            cancelAnimationFrame(captureFrame);
            chartHost.removeEventListener("pointerdown",startPriceInteraction);
            window.removeEventListener("pointerup",finishPriceInteraction);
            chartHost.removeEventListener("wheel",startPriceInteraction,true);
            chartHost.removeEventListener("wheel",finishPriceInteraction);
            const visibleTime=chart.timeScale().getVisibleLogicalRange();
            if(followReplay && !explicitWindow.current && visibleTime && viewportChanged(visibleTime,resetLogicalView.current??initialTime))followWindow.current={scope,count:Math.max(2,visibleTime.to-visibleTime.from),clock:replayCutoff??last!.knownAt,range:{from:visibleTime.from,to:visibleTime.to}};
            explicitWindow.current=false;
            const defaultTime=resetLogicalView.current ?? initialTime;
            if(visibleTime && (resetTimeView.current ? viewportChanged(visibleTime,defaultTime) : savedTime || viewportChanged(visibleTime,initialTime))) {
                const view=anchorViewport(bars.map(b=>b.t),visibleTime);
                if(view)manualTimeView.current={scope,view};
            }
            const priceScale = chart.priceScale("right");
            const priceRange = priceScale.getVisibleRange();
            manualPriceView.current = !followReplay && !priceScale.options().autoScale && priceRange ? { scope, range: priceRange } : null;
            unsubscribeCursor?.();
            redrawLabels.current=null;cancelAnimationFrame(annotationFrame); resize.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null; };
    }, [savedDealingRange,chochWindow,labelScope,sourceZones,bindLabel,showRangeLiquidity,liquidity,fixedPriceRange, onPriceRangeChange, crosshairSync, followReplay, replayCutoff, tradeLevels, ictStyle, chartHeight, bars, frame, range, target, showSwings, showEquilibrium, layers.equilibrium, layers.plan, plan, zones, selected, onSelect, onDaySelect, swings, activeZones, referencePoints, strategyEvents, labeledZones, fitReferenceLevels, showZoneLabels, showWicks, drawnWicks, fib, showFib, showRetracement, fibExt, last, viewKey, market, showTimeInfluence, timingWindows, comparisonSegments, showSweepBoxes, sweepEvents, showLookback, lookback, number, precision]);
    function zoom(factor: number) { const chart = chartRef.current; if (!chart)
        return; const visible = chart.timeScale().getVisibleLogicalRange(); if (!visible)
        return; const count = Math.max(2, Math.min(1000, (visible.to - visible.from) * factor)); viewport.current = count; resetTimeView.current=false; const center=(visible.from+visible.to)/2; chart.timeScale().setVisibleLogicalRange({from:center-count/2,to:center+count/2}); }
    function toggle(label:string,checked:boolean,set:(value:boolean)=>void){return <label key={label}><input type="checkbox" checked={checked} onChange={e=>set(e.target.checked)}/> {label} · {title}</label>;}
    function renderLayers(keys:string[]){return layerControls.filter(([key])=>keys.includes(key)).filter(([key])=>key==="trade"?sourceTradeLevels.length>0:key==="swings"?allowSwings:key==="strategy"?sourceStrategyEvents.length>0:key==="comparison"?sourceSegments.length>0:key==="range"?!!sourceRange:key==="target"?sourceTarget!==null:key==="plan"?!!plan:key==="htf"?sourceReferences.some(p=>/^(Monthly|Weekly|Daily) (OB|FVG|IFVG|BREAKER)/.test(p.kind)):true).map(([key,label])=>toggle(label,layers[key],value=>setLayers(current=>({...current,[key]:value}))));}
    return <div className={sidePanel?"grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]":""}><div className="min-w-0"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="font-semibold">{title}</h3><div className="flex flex-wrap gap-1"><button aria-label={`Undo label removal ${title}`} title="Restore the last chart item removed from this chart" disabled={!removedLabelCounts[labelScope]} onClick={undoLabel} className="rounded border border-white/20 px-2 text-xs disabled:opacity-40">↶ Undo</button>{onToggleExpand ? <button aria-label={`${expanded?"Collapse":"Expand"} ${title} chart`} title={expanded?"Return to all seven charts":"Expand this chart"} className="rounded border border-white/20 px-2 text-xs" onClick={onToggleExpand}>{expanded?"↙ All charts":"⛶ Expand"}</button> : null}{onPriceRangeChange ? <><button title={`Select price zone ${title}: drag a rectangle to zoom time and fix this chart’s price range`} aria-label={`Select price zone ${title}`} aria-pressed={selectPriceZone} className="rounded border border-blue-300/40 px-2 text-xs" onClick={()=>{setSelectPriceZone(!selectPriceZone);setPriceBrush(null);}}>{selectPriceZone?"Cancel":"▭"}</button><button aria-label={`Clear price zone ${title}`} disabled={!fixedPriceRange && !selectPriceZone} className="rounded border border-white/20 px-2 text-xs" onClick={()=>{onPriceRangeChange(frame,null);setSelectPriceZone(false);setPriceBrush(null);}} title={`Clear price zone ${title}`}>↺ Range</button></> : null}<button aria-label={`Zoom in ${title}`} className="rounded border border-white/20 px-2" onClick={() => zoom(.75)}>+</button><button aria-label={`Zoom out ${title}`} className="rounded border border-white/20 px-2" onClick={() => zoom(1.3)}>−</button><button className="rounded border border-white/20 px-2 text-xs" onClick={() => { viewport.current = null; followWindow.current=null; manualTimeView.current=null; resetTimeView.current=true; manualPriceView.current = null; if(fixedPriceRange)chartRef.current?.priceScale("right").setVisibleRange(fixedPriceRange);else chartRef.current?.priceScale("right").setAutoScale(true); chartRef.current?.timeScale().setVisibleLogicalRange(followReplay ? {from:Math.max(-.5,bars.length-80-.5),to:bars.length-.5} : { from: Math.max(-1, bars.length - (frame === "1w" ? 14 : 20)), to: bars.length + 4 }); resetLogicalView.current=chartRef.current?.timeScale().getVisibleLogicalRange() ?? null; }}>Reset view</button></div></div><details className="mb-2 rounded border border-white/10 p-2 text-xs" data-ict-indicators><summary className="cursor-pointer font-medium">ICT Indicators</summary><div className="mt-2 space-y-2" data-overlay-controls>
<div className="flex flex-wrap items-center justify-between gap-2"><span className="text-slate-400">Replay tools · {title} · {frame==="1mo" || frame==="1w" ? "Macro narrative" : frame==="1d" || frame==="1h" ? "Range & intermarket context" : frame==="30m" || frame==="15m" ? "Session & setup" : "Execution"}</span><button className="rounded border border-white/20 px-2 py-1" onClick={()=>{setLayers(current=>Object.fromEntries(Object.keys(current).map(key=>[key,false])) as typeof current);setNearestPD(false);setShowRangeLiquidity(false);setShowLookback(false);setShowSweepBoxes(false);setShowTimeInfluence(false);setShowWicks(false);setShowZoneLabels(false);setShowFib(false);setShowRetracement(false);setShowExtension(false);}}>Hide all overlays · {title}</button></div>
<div className="flex flex-wrap gap-2">{(["context","setup","execution","all"] as const).map(focus=><button key={focus} aria-pressed={toolFocus===focus} className="rounded border border-white/15 px-2 py-1 capitalize" onClick={()=>setToolFocus(focus)}>{focus==="all"?"Expand all groups":`Focus: ${focus}`}</button>)}</div>
<div className="grid gap-2 sm:grid-cols-2">
<OverlayCategory title="Macro Bias & Range Matrix" initiallyOpen={toolFocus==="all" || toolFocus==="context" || toolFocus==="default" && (frame==="1mo" || frame==="1w")} gaps={["IPDA four market states","Weekly profile templates","Seasonality / quarterly shifts","Interest-rate / COT / open-interest context"]}>
<label><input type="checkbox" checked={drawOnLiquidity} onChange={e=>setLayers(current=>({...current,pools:e.target.checked,references:e.target.checked,range:e.target.checked}))}/> Draw on Liquidity · {title}</label>{liquidity ? toggle("Internal / External Range Liquidity",showRangeLiquidity,setShowRangeLiquidity) : null}{renderLayers(["equilibrium","references","range","target"])}
{toggle("Fibonacci range",showFib,setShowFib)}{toggle("Fib retracement / OTE",showRetracement,setShowRetracement)}{toggle("Fib extension",showExtension,setShowExtension)}
</OverlayCategory>
<OverlayCategory title="Institutional PD Arrays" initiallyOpen={toolFocus!=="context"} gaps={["Mitigation blocks","Propulsion blocks","Vacuum blocks / event gaps"]}>
<label title="Nearest active candidate below, inside and above the revealed close"><input type="checkbox" checked={nearestPD} onChange={e=>{setNearestPD(e.target.checked);if(e.target.checked){setLayers(current=>({...current,fvg:true,ob:true,breaker:true}));setShowZoneLabels(true);}}}/> Nearest PD Array · {title}</label>{renderLayers(["vi","fvg","bpr","ob","breaker","voids","threshold","htf"])}
<p className="text-[11px] text-slate-500">Arrays are mechanically detected candidates. Certified liquidity voids and rejection blocks are unavailable.</p>
</OverlayCategory>
<OverlayCategory title="Liquidity Pools & Stop Hunt Dynamics" initiallyOpen={toolFocus==="all" || toolFocus==="setup"}>
{renderLayers(["pools"])}{toggle("Liquidity sweeps / Turtle Soup",showSweepBoxes,setShowSweepBoxes)}{frame==="1mo" || frame==="1w" ? toggle("Wick rejection highlights",showWicks,setShowWicks) : null}
</OverlayCategory>
<OverlayCategory title="Market Structure & Intermarket Analysis" initiallyOpen={toolFocus==="all" || toolFocus==="context" || toolFocus==="setup"} gaps={["Power of 3 / AMD","Market maker buy / sell models"]}>
{renderLayers(["structure","comparison","strategy"])}{!sourceSegments.length ? <p className="text-[11px] text-slate-500">SMT: no aligned comparison data supplied to this chart.</p> : null}
</OverlayCategory>
<OverlayCategory title="Time, Killzones & Execution Filters" initiallyOpen={toolFocus==="all" || toolFocus==="execution" || toolFocus==="setup"} gaps={["Midnight opening price","Silver Bullet windows (separate course coverage needed)","CBDR / Asian range / Flout","ADR projections / event calendar"]}>
{intradayFrame ? toggle("Time of Day Influence / session killzones",showTimeInfluence,setShowTimeInfluence) : null}{renderLayers(["trade","plan"])}
<p className="text-[11px] text-slate-500">Time windows are context, not entry confirmation. Paper trading is below the chart.</p>
</OverlayCategory>
<OverlayCategory title="UI Controls & Chart Maintenance" initiallyOpen={toolFocus==="all"}>
{renderLayers(["swings"])}{lookback ? toggle("20 / 40 / 60 lookback boxes & anchor",showLookback,setShowLookback) : null}{toggle("Zone labels (text only)",showZoneLabels,setShowZoneLabels)}
<p className="text-[11px] text-slate-500">Crosshair links time and price; rectangle selections and price ranges stay independent per chart.</p>
</OverlayCategory>
</div></div></details>{showFib || showRetracement ? <p className="mb-2 text-xs text-slate-400">{fib ? `${fib.upward ? "Up" : "Down"} leg: confirmed swing ${fib.anchorDay} (known ${new Date(fib.anchorKnownAt).toISOString()}) → running extreme through ${fib.currentDay}. Indicator only; not a validated OTE entry.` : "Waiting for a confirmed three-bar swing. No Fibonacci range is fabricated."}</p> : null}<div className="overflow-hidden rounded-lg border border-[#d9dde2] bg-[#fafafa]"><div className="relative"><p className="min-h-8 px-3 py-2 text-xs text-[#4b5563]">{readout?.t === last?.t ? readout?.text : last ? `${last.day}${developingBar?" · Developing":""} · O ${number(last.o)} H ${number(last.h)} L ${number(last.l)} C ${number(last.c)}` : "No completed candles yet"}</p><div role="img" aria-label={`${title} candlestick chart`} data-trade-levels={JSON.stringify(tradeLevels)} data-weekly-replay-chart="true" data-swing-path={JSON.stringify(swings.map(s => ({ kind: s.kind, day: s.day, knownAt: s.knownAt })))} data-developing-candle={developingBar?JSON.stringify(developingBar):undefined} data-last-candle={last?.day} data-candle-count={bars.length} data-daily-reference-count={referencePoints.length} data-strategy-event-count={strategyEvents.filter(event=>bars.some(b=>event.at>=b.t && event.at<b.knownAt)).length} className="relative" style={{height:chartHeight}} onMouseLeave={() => setReadout(undefined)} ref={host}/><PaperRiskTool initiallyVisible={!!initialPaperDraft} chart={chartRef} series={seriesRef} locked={!!frozenPaper} status={frozenResult?.status} anchorTime={riskAnchor?timeOf(riskAnchor,frame):paperDraft.entryAt!==undefined?timeOf(completedBars.findLast(b=>b.knownAt<=paperDraft.entryAt!)??completedBars[0],frame):undefined} endTime={riskEnd?timeOf(riskEnd,frame):undefined} entry={frozenPaper?.entry??paperDraft.entry??(paperBars??completedBars).at(-1)?.c} draft={frozenPaper?{direction:frozenPaper.direction,stop:String(frozenPaper.stop),target:String(frozenPaper.target)}:paperDraft} onChange={setPaperDraft} height={chartHeight} title={title}/>{selectPriceZone ? <div role="img" aria-label={`Draw price zone rectangle ${title}`} className="absolute inset-x-0 bottom-0 z-20 touch-none cursor-crosshair" style={{height:chartHeight}} onPointerDown={e=>{const r=e.currentTarget.getBoundingClientRect();e.currentTarget.setPointerCapture(e.pointerId);const x=e.clientX-r.left,y=e.clientY-r.top;brushStart.current={x,y};setPriceBrush({x,y,endX:x,endY:y});}} onPointerMove={e=>{const start=brushStart.current;if(!start)return;const r=e.currentTarget.getBoundingClientRect();setPriceBrush({...start,endX:e.clientX-r.left,endY:e.clientY-r.top});}} onPointerCancel={()=>{brushStart.current=null;setPriceBrush(null);}} onPointerUp={e=>{
 const start=brushStart.current,chart=chartRef.current,series=seriesRef.current;
 brushStart.current=null;setPriceBrush(null);
 if(!start||!chart||!series)return;
 const r=e.currentTarget.getBoundingClientRect(),time=chart.timeScale();
 const clampX=(x:number)=>Math.max(0,Math.min(time.width()-1,x));
 const clampY=(y:number)=>Math.max(0,Math.min(chart.panes()[0].getHeight()-1,y));
 const sx=clampX(start.x),sy=clampY(start.y),ex=clampX(e.clientX-r.left),ey=clampY(e.clientY-r.top);
 const a=series.coordinateToPrice(sy),b=series.coordinateToPrice(ey),x0=time.coordinateToLogical(sx),x1=time.coordinateToLogical(ex);
 if(a===null||b===null||x0===null||x1===null||Math.abs(ex-sx)<5||Math.abs(ey-sy)<5)return;
 const from=Math.min(x0,x1),to=Math.max(from+2,Math.max(x0,x1));
 const scope=`${viewKey??`${market}:${bars[0].t}:${bars[0].o}`}:${frame}`;
 followWindow.current={scope,count:to-from,clock:replayCutoff??last!.knownAt,range:{from,to}};
 explicitWindow.current=true;viewport.current=to-from;resetTimeView.current=false;
 time.setVisibleLogicalRange({from,to});
 chart.priceScale("right").setVisibleRange({from:Math.min(a,b),to:Math.max(a,b)});
 onPriceRangeChange?.(frame,{from:Math.min(a,b),to:Math.max(a,b)});setSelectPriceZone(false);
}}>{priceBrush ? <div className="pointer-events-none absolute border-2 border-blue-500 bg-blue-400/20" style={{left:Math.min(priceBrush.x,priceBrush.endX),top:Math.min(priceBrush.y,priceBrush.endY),width:Math.abs(priceBrush.endX-priceBrush.x),height:Math.abs(priceBrush.endY-priceBrush.y)}}/>:null}</div>:null}<div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 z-10 overflow-hidden" style={{height:chartHeight}} ref={referenceLayer}/>{!bars.length ? <p className="p-8 text-center text-sm text-[#4b5563]">No completed candles at this replay time.</p> : null}</div></div>{tradeLevels.length ? <p className="mt-2 flex flex-wrap gap-3 text-xs" aria-label={`${title} trade levels`}>{tradeLevels.map(l=><span key={l.label} style={{color:l.color}}>{l.label} {number(l.price)}</span>)}</p> : null}</div><aside className={sidePanel?"min-w-0 overflow-y-auto rounded border border-white/10 p-2":""} style={sidePanel?{maxHeight:chartHeight+150}:undefined}>{sidePanel?<PaperTrading initiallyOpen={sidePanel} draft={paperDraft} onDraftChange={setPaperDraft} onTradesChange={handlePaperTrades} bars={paperBars??completedBars} symbol={viewKey ?? title} frame={frame} title={title} />:null}<details data-chart-explanation className="mt-3 rounded border border-white/10 p-3"><summary className="cursor-pointer text-sm">Chart explanation & levels · {title}</summary>{contextExplanation}{lookback ? <details className="mt-2 rounded border border-white/10 p-3 text-xs"><summary>IPDA · 20 / 40 / 60 trading-session lookbacks · Quarterly anchor</summary><p className="mt-2">Last completed daily sessions at the replay clock. These are observed source trading days; an exchange-calendar completeness certificate is unavailable.</p>{lookback.windows.map(w=><div className="mt-2" key={w.count}><p>{w.count} sessions · {w.complete ? `${w.first?.day}–${w.last?.day} · old high ${number(w.high!)} / old low ${number(w.low!)}` : `${w.available} available; range withheld`}</p><p>{w.references.length} active recent institutional reference candidates: {w.references.slice(-6).map(z=>`${z.direction} ${z.kind} ${number(z.low)}–${number(z.high)}`).join("; ") || "none detected / insufficient history"}</p></div>)}<p className="mt-2">Previous month {lookback.previousMonth}: first stored session {lookback.initial?.day??"unavailable"}. Current anchor {lookback.anchor?.day??"unavailable"} · {lookback.reason}. Anchor reset uses an extension of the running high/low from that initial session, confirmed at daily close.</p><p className="mt-2">Quarter boundary {lookback.quarterStart} is a calendar timing reference, not proof of a market shift. Prior market-shift anchoring, liquidity-void certification and institutional order-flow validation are not implemented.</p></details> : null}<details className="mt-2 rounded border border-white/10 p-3 text-xs"><summary>Liquidity raids / Turtle Soup candidates · {sweepEvents.length}</summary><p className="mt-2 text-slate-400">Month 04, pages 53–61. Pink boxes show the price region beyond a previously confirmed three-bar swing that was raided and reclaimed on a completed close. They become visible at reclaim, not before. A same-candle raid/break cannot establish the ordering needed for a breaker. Breaker candidates require the intervening swing candle direction and a later structural close; retest and higher-timeframe trend qualification remain separate. Full candle wick range is a local zone-boundary choice.</p>{sweepEvents.slice(-30).reverse().map(e=><p key={e.id}>{e.direction==="BUY"?"Sell-side raid · Turtle Soup BUY candidate":"Buy-side raid · Turtle Soup SELL candidate"} · raid {e.start.day} · reclaimed {e.end.day} · {number(e.low)}–{number(e.high)} · known {new Date(e.knownAt).toISOString()}</p>)}</details>{liquidity ? <details className="mt-2 rounded border border-white/10 p-3 text-xs"><summary>Internal / External Range Liquidity</summary><p className="mt-2">Reference basis: {liquidity.basis} · {liquidity.origin} · low {number(liquidity.low)} / high {number(liquidity.high)}. Use the reference-level checkboxes above to show the completed boundaries.</p><p className="mt-2">External: buy-side liquidity above {number(liquidity.high)} ({liquidity.buyPools.length} retained pools); sell-side liquidity below {number(liquidity.low)} ({liquidity.sellPools.length} retained pools). A run can pair with resting stop liquidity; OHLC does not reveal actual pending orders. Low/high resistance: not classified.</p><p className="mt-2">Internal: {liquidity.internal.length} active imbalance / block candidates wholly inside this range; {liquidity.voids.length} referenced liquidity voids. FVG / void filling is a possible rebalance when the range holds, not a certainty. Orderblocks are candidate references; new institutional orders cannot be observed from candles.</p><div className="mt-2 flex flex-wrap gap-2">{liquidity.internal.map(z=><button key={z.id} className="rounded border border-white/15 px-2 py-1" onClick={()=>onSelect(z.id)}>{z.kind} {number(z.low)}–{number(z.high)}</button>)}</div><p className="mt-2 text-slate-400">Market Maker Buy / Sell Models inside the range: detection not implemented. Zones crossing a boundary are not counted as wholly internal. A completed reference range is an explicit local basis, not a certified current dealing range.</p></details> : null}{intradayFrame && showTimeInfluence ? <div className="mt-2 text-xs text-slate-400"><p>New York clock, DST aware: London 02:00–05:00; New York open 07:00–10:00; New York AM 09:30–12:00. Only fully contained completed candles contribute. Session highs/lows are observed extrema; day extremes require a completed daily candle. These are timing references, not verified sponsorship.</p>{timingWindows.length ? timingWindows.map(w=><p key={w.id}>{w.day} · {w.label} · {w.closed ? "Window ended" : "Developing"} · {w.complete ? "Full window covered" : "Partial source coverage"} · low {number(w.low.l)} / high {number(w.high.h)}{w.lowOfDay ? " · confirmed NY-day low" : ""}{w.highOfDay ? " · confirmed NY-day high" : ""}</p>) : <p>No stored candles covering these windows. US regular-session data cannot show London; use an available finer timeframe for New York windows.</p>}</div> : null}<p className="mt-2 text-xs text-slate-400">Drag to move · scroll to zoom · click a candle for its daily explanation</p><p className="mt-2 text-xs text-slate-500">All valid completed candles are included, including neutral days. Candle colour describes close versus open.</p>
        {frame === "1w" || frame === "1mo" ? <details className="mt-2 rounded border border-[#bf835d]/30 p-3 text-xs"><summary>Wick rejection candidates · {showWicks ? drawnWicks.length : 0} highlighted / {wickZones.length} retained</summary><p className="mt-2 text-slate-400">Brown shading marks wick-to-body zones at confirmed three-bar swings. Local rule: wick ≥ 25% of candle range and ≥ body; within three bars price closes beyond the swing candle, at least 0.5 × prior ATR away from its body edge. Eight prior bars minimum. This approximates the reference illustration; it is not a validated ICT entry model. Highlight starts at confirmation; no forming period is used. Four most recent unbroken candidates are drawn. Neutral candles remain included.</p><div className="mt-2 space-y-1">{[...wickZones].reverse().map(z => <p key={z.id}>{z.direction === "BUY" ? "Lower wick · rejection upward" : "Upper wick · rejection downward"} · origin {z.originDay} · confirmed {z.confirmedDay} ({new Date(z.knownAt).toISOString()}) · {number(z.low)}–{number(z.high)} · {z.status} · {z.touches} return visits</p>)}</div></details> : null}
        {sourceReferences.length ? <details className="mt-2 rounded border border-white/10 p-2 text-xs"><summary>Daily explanation levels · {referencePoints.length} plotted / {sourceReferences.length} retained</summary><div className="mt-2 flex flex-wrap gap-2">{sourceReferences.map((p,i) => <span key={`${p.kind}:${p.knownAt}:${i}`} className="rounded border border-white/15 px-2 py-1" title={`Origin ${p.originDay}; known ${new Date(p.knownAt).toISOString()}; ${p.response}`}>{p.kind} {number(p.low)}{p.low !== p.high ? `–${number(p.high)}` : ""} · {p.timing}</span>)}</div></details> : null}
        {labeledZones.length > 0 ? <div className="mt-2 space-y-2 text-xs"><p className="text-slate-400"><span className="text-blue-300">FVG: green bullish / pink bearish · three-candle imbalance. All untouched gaps in loaded history are retained; a boundary touch counts as tested.</span> <span className="text-amber-300">{ictStyle ? "OB: light blue, solid · anchored to the opposite origin candle; visible only after confirmation." : "OB: amber solid · opposite candle before a qualifying break."}</span> Freshness = unfilled candle-range coverage. Filled = cumulative price-interval coverage after confirmation. Touches count separate visits; consecutive intersecting candles count as one visit. A wick touch can have 0% fill. These are local OHLC measures, not probabilities.</p><div className="flex flex-wrap gap-2">{labeledZones.map(z => { const m = zoneMetrics(z,completedBars); return <button key={z.id} onClick={() => onSelect(z.id)} className={`rounded border px-2 py-1 ${z.kind === "FVG" ? "border-blue-400/40 text-blue-200" : "border-amber-400/40 text-amber-200"}`}>{z.kind} {z.direction} · {z.status === "SWEPT" ? "Invalidated · " : ""}{z.originDay} · {number(z.low)}–{number(z.high)} · {m.completeHistory ? `${m.state} · ${m.freshness.toFixed(0)}% fresh · ${m.filled.toFixed(0)}% filled · ${m.touches} touches (${m.touchBars} candles)` : "Coverage incomplete; percentages unavailable"}</button>; })}</div></div> : null}
        {sourceZones.length ? <div className="mt-2 space-y-2 text-xs"><p className="text-slate-400">{sourceZones.length} retained events · {activeZones.length} drawn. Two recent active events per category plus your selected event; historical and other events remain selectable. Detection uses the last 240 candles per frame.</p><label className="block">Locate a zone or event<select aria-label={`${title} zone browser`} className="ml-2 max-w-full rounded border border-white/15 bg-[#101722] p-2" value={sourceZones.some(z => z.id === selected) ? selected : ""} onChange={e => onSelect(e.target.value)}><option value="">Choose an event to focus its price range</option>{[...sourceZones].sort((a,b) => b.knownAt-a.knownAt).map(z => <option key={z.id} value={z.id}>{z.tf} {z.kind} · {z.originDay} · {number(z.low)}–{number(z.high)} · {z.status}</option>)}</select></label></div> : <p className="mt-2 text-xs text-slate-400">No events in the enabled layers at this replay cutoff. Enable a category above or advance the replay.</p>}
        {activeZones.length ? <div className="mt-2 flex flex-wrap gap-2">{activeZones.map(z => <button className="rounded border border-white/15 px-2 py-1 text-xs" key={z.id} onClick={() => onSelect(z.id)}>{z.tf} {z.kind} · {number(z.low)}–{number(z.high)}</button>)}</div> : null}</details>{!sidePanel?<PaperTrading initiallyOpen={sidePanel} draft={paperDraft} onDraftChange={setPaperDraft} onTradesChange={handlePaperTrades} bars={paperBars??completedBars} symbol={viewKey ?? title} frame={frame} title={title} />:null}</aside></div>;
}

function OverlayCategory({title,children,gaps=[],initiallyOpen=false}:{title:string;children:ReactNode;gaps?:string[];initiallyOpen?:boolean}){
 return <details className="rounded border border-white/10 bg-white/[.02] p-2" open={initiallyOpen}><summary className="cursor-pointer font-medium">{title}</summary><div className="mt-2 flex flex-col gap-2">{children}{gaps.length ? <p className="text-[11px] text-slate-500">Not implemented: {gaps.join(" · ")}</p>:null}</div></details>;
}
