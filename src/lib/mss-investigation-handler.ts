import { validateStrategyFilters } from "@/lib/mss-strategy-filters";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { resolveReplayInstrument } from "@/lib/replay-instruments";
import { GET as replay } from "@/app/api/daily-bias/replay/route";
import { completedWeeklyBars, WEEKLY_REPLAY_VERSION, type ReplayData } from "@/lib/weekly-replay";
import { rollupMinuteBars,rollupFourHourBars,rollupTenMinuteBars,rollupStoredFiveMinuteBars,supplementNativeBars,supplementUsDailyBars } from "@/lib/minute-rollup";
import { completedMonthlyBars } from "@/lib/top-down";

const ranks:Record<string,number>={"1m":1,"2m":2,"3m":3,"5m":5,"10m":10,"15m":15,"30m":30,"1h":60,"4h":240,"1d":1440,"1w":10080,"1mo":43200};
const htfKinds=["OB","BREAKER","FVG","IFVG","BPR","BSL","SSL","SWINGS","PDH","PDL"];
const ltfKinds=["OB","BREAKER","FVG","IFVG","BPR"];
const maxCandles=10000;
export async function investigate(request:Request, engine:"MSS"|"SCALPING_LABS"="MSS"){
  try{
    const body=await request.json();
    const permittedHtf=engine==='SCALPING_LABS'?[...htfKinds,'WICK','REJECTION','GAP','NYOPEN','VALID_FVG']:htfKinds;
    const permittedLtf=engine==='SCALPING_LABS'?[...ltfKinds,'MITIGATION','PROPULSION','VALID_FVG']:ltfKinds;
    const filterError=validateStrategyFilters(body.strategyFilters);
    if(filterError)return Response.json({error:filterError},{status:400});
    const {symbol,tf1,tf2,start,end}=body;
    const confirmation=body.confirmation??'CHOCH';
    const arrayScope=body.arrayScope??'FORMATION';
    if(body.candleOrderBlocks!==undefined&&typeof body.candleOrderBlocks!=='boolean')return Response.json({error:'Candle OB inclusion must be true or false.'},{status:400});
    if(body.entryWindowMinutes!==undefined&&(!Array.isArray(body.entryWindowMinutes)||body.entryWindowMinutes.length!==2||body.entryWindowMinutes.some((v:unknown)=>typeof v!=='number'||!Number.isInteger(v)||v<0||v>1439)||body.entryWindowMinutes[0]>body.entryWindowMinutes[1]))return Response.json({error:'Entry window must be an ordered pair of minutes within a day.'},{status:400});
    if(body.retestMode!==undefined&&!['FIRST','ALL','CANDLES'].includes(body.retestMode))return Response.json({error:'Choose first or all retest visits.'},{status:400});
    if(body.pivotStrength!==undefined&&![1,3].includes(body.pivotStrength))return Response.json({error:'Local pivot strength must be 1 or 3.'},{status:400});
    if(body.carryIn!==undefined&&typeof body.carryIn!=='boolean')return Response.json({error:'Carry-in must be true or false.'},{status:400});
    if(!['FORMATION','EXISTING','CONTINUATION'].includes(arrayScope))return Response.json({error:'Choose formation-only or existing and displacement arrays.'},{status:400});
    if(!['CHOCH','WICK','CISD','EITHER','LOCAL','LOCAL_WICK',...(engine==='SCALPING_LABS'?['IFVG_FAILURE']:[])].includes(confirmation))return Response.json({error:'Choose close-break CHOCH, wick-break CHOCH, CISD candidate, or either confirmation.'},{status:400});
    const validDate=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
    if(typeof symbol!=='string'||!ranks[tf1]||!ranks[tf2]||ranks[tf1]<=ranks[tf2]||!validDate(start)||!validDate(end)||start>end||!Array.isArray(body.htfKinds)||!Array.isArray(body.ltfKinds)||!body.htfKinds.length||!body.ltfKinds.length||body.htfKinds.some((k:string)=>!permittedHtf.includes(k))||body.ltfKinds.some((k:string)=>!permittedLtf.includes(k)))return Response.json({error:'Select a ticker, TF1 > TF2, valid dates and at least one level in each group.'},{status:400});
    const from=new Date(Date.parse(start)-30*86400000).toISOString().slice(0,10);
    let reversalFrames:Record<string,ReplayData['bars']>|null=null;
    let reversalAudit:ReplayData['audit']|null=null;
    const reversalInstrument=body.candleSource==='REVERSAL_K1'?await resolveReplayInstrument(symbol):null;
    if(reversalInstrument&&['1d','1h','30m','1w'].includes(tf1)&&['1d','1h','30m'].includes(tf2)) {
      const native=await new Promise<{frames:Record<string,ReplayData['bars']>;audit:{lower:{invalid:number;conflicts:number;sources:string[]};daily:{invalid:number;conflicts:number;sources:string[]}}}>((resolve,reject)=>{
        const runtime=process.env.REVERSAL_RUNTIME_DIR??path.join(os.homedir(),'Desktop','ICT_Automation','realtime_execution');
        const child=spawn(process.env.MSS_PYTHON??'python',[path.join(runtime,'export_reversal_k1_frames.py')],{windowsHide:true});
        let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('Reversal candle handoff exceeded 120 seconds.'));},120000);
        child.stdout.on('data',chunk=>{output+=chunk.toString();});child.stderr.on('data',()=>{});
        child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error('Unable to load completed reversal candles for MSS.'));return;}try{resolve(JSON.parse(output));}catch{reject(new Error('Invalid reversal candle handoff.'));}});
        request.signal.addEventListener('abort',()=>child.kill(),{once:true});child.stdin.on('error',()=>{});
        child.stdin.end(JSON.stringify({market:reversalInstrument.market,ticker:reversalInstrument.symbol,start:from}));
      });reversalFrames=native.frames;reversalAudit={invalid:native.audit.lower.invalid+native.audit.daily.invalid,conflicts:native.audit.lower.conflicts+native.audit.daily.conflicts,duplicates:0,sources:[...new Set([...native.audit.lower.sources,...native.audit.daily.sources])],missingDailyContext:!native.frames['1d']?.length};
    }
    const load=async(tf:string):Promise<ReplayData>=>{
      if(reversalFrames&&reversalInstrument) {
        const sourceTf=tf==='1w'?'1d':tf;
        return {version:WEEKLY_REPLAY_VERSION,frame:sourceTf as ReplayData['frame'],generatedAt:new Date().toISOString(),instrument:reversalInstrument,bars:reversalFrames[sourceTf]??[],daily:reversalFrames['1d'],invalidDailyDays:[],audit:reversalAudit!,provenance:'Completed OHLC handoff from the k1_reclaim3 reversal lane; includes validated native data and isolated gap supplements.'} as ReplayData;
      }
      const response=await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=${tf==='4h'?'1h':tf==='1w'||tf==='1mo'?'1d':tf==='10m'?'5m':tf==='2m'||tf==='3m'?'1m':tf}&from=${from}&through=${end}&backtest=1`));
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      if(engine==='SCALPING_LABS'&&result.instrument?.market==='us'){
        const baseResponse=tf==='5m'?response:await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=5m&from=${from}&through=${end}&backtest=1`));
        const baseData=tf==='5m'?result:await baseResponse.json() as ReplayData;
        if(baseResponse.ok){
          const before=result.daily?.length??0;
          result.daily=supplementUsDailyBars(result.daily??[],baseData.bars??[]);
          if(result.daily.length>before){
          result.audit={...result.audit,missingDailyContext:!result.daily.length,sources:[...new Set([...result.audit.sources,'missing daily context -> complete regular 5m session'])]};
          result.provenance+=' Missing native daily context derived from complete regular 5m sessions; partial sessions omitted.';
          }
        }
      }
      if(engine==='SCALPING_LABS'&&result.instrument?.market==='forex'&&tf==='1h'){
        // Partial native H1 archives must not hide earlier completed 5m history.
        const baseResponse=await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=5m&from=${from}&through=${end}&backtest=1`));
        const baseData=await baseResponse.json() as ReplayData;
        if(baseResponse.ok&&baseData.bars?.length){
          const native:ReplayData['bars']=result.bars??[];
          const bars=supplementNativeBars(native,rollupStoredFiveMinuteBars(baseData.bars,60,'forex'));
          if(bars.length>native.length)return {...result,bars,provenance:result.provenance+' Missing native H1 timestamps supplemented with complete consecutive stored 5m candles; native OHLC retained.',audit:{...result.audit,sources:[...new Set([...result.audit.sources,...baseData.audit.sources,'derived completed 5m -> 60m'])]}};
        }
      }
      if(engine==='SCALPING_LABS'&&!result.bars?.length&&['15m','30m','1h','4h'].includes(tf)){
        const baseResponse=await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=5m&from=${from}&through=${end}&backtest=1`));
        const baseData=await baseResponse.json() as ReplayData;
        if(baseResponse.ok&&baseData.bars?.length){
          const minutes=tf==='15m'?15:tf==='30m'?30:60;
          const bars=rollupStoredFiveMinuteBars(baseData.bars,minutes,baseData.instrument.market);
          if(bars.length)return {...baseData,frame:tf==='4h'?'1h':tf as ReplayData['frame'],bars,provenance:baseData.provenance+` Native ${tf} archive empty; complete consecutive stored 5m rolled up to ${minutes} minutes.`,audit:{...baseData.audit,sources:[...baseData.audit.sources,`derived completed 5m -> ${minutes}m`]}};
        }
      }
      return result as ReplayData;
    };
    const [higher,lower]=await Promise.all([load(tf1),load(tf2)]);
    const tomorrow=new Date(Date.parse(end)+86400000).toISOString().slice(0,10);
    const frameBars=(data:ReplayData,tf:string)=>tf==='10m'?rollupTenMinuteBars(data.bars):tf==='4h'?rollupFourHourBars(data.bars):tf==='2m'||tf==='3m'?rollupMinuteBars(data.bars,tf==='2m'?2:3):tf==='1w'?completedWeeklyBars(data.daily,tomorrow,data.invalidDailyDays):tf==='1mo'?completedMonthlyBars(data.daily,tomorrow,data.invalidDailyDays):data.bars;
    const highBars=frameBars(higher,tf1).filter(b=>b.day<=end).slice(-600);
    const lowBars=frameBars(lower,tf2).filter(b=>b.day<=end);
    const startIndex=lowBars.findIndex(b=>b.day>=start);
    const queryBars=startIndex<0?[]:lowBars.slice(Math.max(0,startIndex-250));
    if(!queryBars.length)return Response.json({error:tf2==='1m'?'No stored completed 1-minute candles for the selected dates. Choose a date range with stored 1-minute data; 5-minute candles cannot provide 1-minute replay.':tf2==='2m'||tf2==='3m'?`No complete ${tf2} candles can be formed from stored consecutive 1-minute candles for the selected dates.`:'No stored completed TF2 candles for these dates and timeframe.'},{status:422});
    if(!highBars.length)return Response.json({error:`TF2 data is available, but there are no stored completed TF1 (${tf1}) candles for the selected dates. Choose dates with higher-timeframe history.`},{status:422});
    if(queryBars.length>maxCandles){const warmupCandles=queryBars.filter(b=>b.day<start).length;return Response.json({error:`This range contains ${queryBars.length.toLocaleString('en-US')} TF2 candles, including ${warmupCandles} warm-up candles. Each investigation supports up to ${maxCandles.toLocaleString('en-US')} candles; split this range into smaller investigations.`,dataAvailable:true,availableCandles:queryBars.length,warmupCandles,maxCandles},{status:422});}
    const input={...body,confirmation,arrayScope,higher:highBars,lower:queryBars,daily:higher.daily.filter(b=>b.day<=end)};
    const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
      const child=spawn(process.env.MSS_PYTHON??'python',[path.join(process.cwd(),'scripts',engine==='SCALPING_LABS'?'scalping_labs_updated.py':'market-structure-shift.py')],{windowsHide:true,env:{...process.env,SMC_CREDIT:'0',SCALPING_GRAPH:engine==='SCALPING_LABS'?'1':'0'}});
      let output='',errors='';
      const timer=setTimeout(()=>{child.kill();reject(new Error('Analysis exceeded 120 seconds. Choose a shorter date range.'));},120000);
      request.signal.addEventListener('abort',()=>child.kill(),{once:true});
      child.stdout.on('data',chunk=>{output+=chunk.toString();});child.stderr.on('data',chunk=>{errors+=chunk.toString();});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);if(code!==0){console.error('MSS library analysis failed',errors);reject(new Error('SMC analysis failed. Check the installed Python library and server logs.'));return;}try{resolve(JSON.parse(output));}catch(error){reject(new Error(engine==='SCALPING_LABS'?`Scalping Labs result decode failed (${output.length} chars): ${error instanceof Error?error.message:'invalid JSON'}`:'SMC returned an invalid result.'));}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
    });
    const meta={success:true,selection:{symbol,tf1,tf2,start,end,htfKinds:body.htfKinds,ltfKinds:body.ltfKinds,strategyFilters:body.strategyFilters??null,confirmation,arrayScope,...(engine==='SCALPING_LABS'?{scalping:body.scalping}:{}),pivotStrength:body.pivotStrength??3,carryIn:body.carryIn??false,candleOrderBlocks:body.candleOrderBlocks??false,retestMode:body.retestMode??"FIRST",entryWindowMinutes:body.entryWindowMinutes??null},instrument:lower.instrument,higher:highBars,lower:queryBars,daily:input.daily,audit:{higher:higher.audit,lower:lower.audit},provenance:lower.provenance,...(['2m','3m','10m'].includes(tf2)?{aggregation:{source:tf2==='10m'?'stored completed 5m':'stored 1m',minutes:ranks[tf2],alignment:'local session-day minute grid',completeConsecutiveOnly:true}}:{})};
    return Response.json(engine==='SCALPING_LABS'?{...result,meta}:{...result,...meta},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Investigation unavailable'},{status:500});}
}
