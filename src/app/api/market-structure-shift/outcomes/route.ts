import {GET as replay} from '../../daily-bias/replay/route';
import {completedWeeklyBars,type ReplayData,type ReplayBar} from '@/lib/weekly-replay';
import {completedMonthlyBars} from '@/lib/top-down';
import {rollupMinuteBars,rollupFourHourBars,rollupTenMinuteBars} from '@/lib/minute-rollup';
import {candleExit,type OutcomePlan,type TradeOutcome} from '@/lib/mss-outcomes';
import {resolveReplayInstrument} from '@/lib/replay-instruments';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const frames=['1m','2m','3m','5m','10m','15m','30m','1h','4h','1d','1w','1mo'];
const dayAfter=(day:string)=>new Date(Date.parse(day)+86400000).toISOString().slice(0,10);
const unique=(bars:ReplayBar[])=>[...new Map(bars.map(b=>[b.t,b])).values()].sort((a,b)=>a.t-b.t);
function frameBars(d:ReplayData,tf:string,through:string){return tf==='10m'?rollupTenMinuteBars(d.bars):tf==='2m'||tf==='3m'?rollupMinuteBars(d.bars,tf==='2m'?2:3):tf==='4h'?rollupFourHourBars(d.bars):tf==='1w'?completedWeeklyBars(d.daily,dayAfter(through),d.invalidDailyDays):tf==='1mo'?completedMonthlyBars(d.daily,dayAfter(through),d.invalidDailyDays):d.bars;}

/** Future OHLC is read only for outcome resolution, never passed to signal detection. */
export async function POST(request:Request){
 try {
  const {symbol,tf1,tf2,end,plans}=await request.json();
  if(typeof symbol!=='string'||!frames.includes(tf1)||!frames.slice(0,9).includes(tf2)||typeof end!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(Date.parse(end))||new Date(end).toISOString().slice(0,10)!==end||end<'2000-01-01'||!Array.isArray(plans)||plans.length>2000||plans.some((p:OutcomePlan)=>!p||typeof p.key!=='string'||p.key.length>512||!['BUY','SELL'].includes(p.direction)||![p.entryAt,p.entry,p.stop,p.target].every(Number.isFinite)||(p.direction==='BUY'?p.stop>=p.entry||p.target<=p.entry:p.stop<=p.entry||p.target>=p.entry))||new Set(plans.map((p:OutcomePlan)=>p.key)).size!==plans.length)return Response.json({error:'Choose valid outcome plans, dates and timeframes.'},{status:400});
  const instrument=await resolveReplayInstrument(symbol);
  if(!instrument||frames.indexOf(tf1)<=frames.indexOf(tf2))return Response.json({error:'Choose a supported symbol and TF1 > TF2.'},{status:400});
  const pending=new Map<string,OutcomePlan>(plans.map((p:OutcomePlan)=>[p.key,p]));
  const outcomes:Record<string,TradeOutcome>={};
  const lower:ReplayBar[]=[],higher:ReplayBar[]=[],daily:ReplayBar[]=[];
  let cursor=dayAfter(end),scannedThrough=end,lastCandleAt:number|null=null;
  const today=new Date().toLocaleDateString('en-CA',{timeZone:instrument.zone});
  const upper=[today,'2027-01-01'].sort()[0];
  const lastAvailableDay=new Date(Date.parse(upper)-86400000).toISOString().slice(0,10);
  const load=async(tf:string,from:string,through:string)=>{
   const source=tf==='10m'?'5m':['2m','3m'].includes(tf)?'1m':tf==='4h'?'1h':['1w','1mo'].includes(tf)?'1d':tf;
   const response=await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=${source}&from=${from}&through=${through}&backtest=1`));
   const d=await response.json();if(!response.ok)throw new Error(d.error);return d as ReplayData;
  };
  while(pending.size&&cursor<=lastAvailableDay){
   if(request.signal.aborted)throw new Error('Outcome scan cancelled.');
   const through=[new Date(Date.parse(cursor)+29*86400000).toISOString().slice(0,10),lastAvailableDay].sort()[0];
   const d=await load(tf2,cursor,through);
   const bars=frameBars(d,tf2,through).filter(b=>b.day>=cursor&&b.day<=through&&b.knownAt<=Date.now());
   for(const b of bars){
    lower.push(b);lastCandleAt=b.knownAt;
    for(const [key,p] of pending){const hit=candleExit(p,b);if(hit){outcomes[key]=hit;pending.delete(key);}else {const sign=p.direction==='BUY'?1:-1;outcomes[key]={outcome:'OPEN',r:sign*(b.c-p.entry)/(sign*(p.entry-p.stop)),exitAt:null,exitKnownAt:null,lastClose:b.c};}}
    if(!pending.size)break;
   }
   if(bars.length){
    const h=tf1===tf2?d:await load(tf1,cursor,through);
    higher.push(...frameBars(h,tf1,through).filter(b=>b.day>end&&b.knownAt<=(lastCandleAt??0)));
    daily.push(...h.daily.filter(b=>b.day>end&&b.knownAt<=(lastCandleAt??0)));
   }
   scannedThrough=pending.size?through:lower.at(-1)?.day??through;cursor=dayAfter(through);
  }
  return Response.json({outcomes,lower:unique(lower),higher:unique(higher),daily:unique(daily),scannedThrough,unresolved:pending.size,lastCandleAt},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Outcome history unavailable.'},{status:503});}
}
