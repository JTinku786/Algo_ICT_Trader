import {GET as replay} from '@/app/api/daily-bias/replay/route';
import {rollupMinuteBars,rollupTenMinuteBars,rollupStoredFiveMinuteBars,rollupFourHourBars} from '@/lib/minute-rollup';
import {completedWeeklyBars,type ReplayData} from '@/lib/weekly-replay';
import {completedMonthlyBars} from '@/lib/top-down';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 const p=new URL(request.url).searchParams,tf=p.get('tf')??'1h',symbol=p.get('symbol')??'AAPL',from=p.get('from')??'',through=p.get('through')??'';
 if(!['1m','2m','3m','5m','10m','15m','30m','1h','4h','1d','1w','1mo'].includes(tf))return Response.json({error:'Choose a supported timeframe.'},{status:400});
 for(const day of [from,through])if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)return Response.json({error:'Choose valid start and end dates.'},{status:400});
 if(from>through)return Response.json({error:'Start date must not follow end date.'},{status:400});
 const warmup=new Date(Date.parse(from)-(['1m','2m','3m'].includes(tf)?4:30)*86400000).toISOString().slice(0,10);
 const load=async(frame:string)=>{const r=await replay(new Request(`${new URL(request.url).origin}/api/daily-bias/replay?symbol=${encodeURIComponent(symbol)}&tf=${frame}&from=${warmup}&through=${through}&backtest=1`));const data=await r.json();if(!r.ok)throw new Error(data.error);return data as ReplayData;};
 const source=tf==='2m'||tf==='3m'?'1m':tf==='10m'?'5m':tf==='4h'?'1h':tf==='1w'||tf==='1mo'?'1d':tf;
 let data=await load(source);
 if(!data.bars.length&&['15m','30m','1h','4h'].includes(tf)){const five=await load('5m');data={...five,bars:rollupStoredFiveMinuteBars(five.bars,tf==='15m'?15:tf==='30m'?30:60,five.instrument.market)};}
 let bars=data.bars;
 if(tf==='2m'||tf==='3m')bars=rollupMinuteBars(bars,tf==='2m'?2:3);
 if(tf==='10m')bars=rollupTenMinuteBars(bars);
 if(tf==='4h')bars=rollupFourHourBars(bars);
 if(tf==='1w')bars=completedWeeklyBars(data.daily,new Date(Date.parse(through)+86400000).toISOString().slice(0,10),data.invalidDailyDays);
 if(tf==='1mo')bars=completedMonthlyBars(data.daily,new Date(Date.parse(through)+86400000).toISOString().slice(0,10),data.invalidDailyDays);
 if(!bars.some(b=>b.day>=from&&b.day<=through))return Response.json({error:'No completed candles for this ticker, timeframe and period.'},{status:422});
 const first=bars.findIndex(b=>b.day>=from);if(first>600)bars=bars.slice(first-600);
 if(bars.length>10000)return Response.json({error:'More than 10,000 candles. Choose a shorter period.'},{status:422});
 return Response.json({...data,bars,frame:tf,selection:{symbol,tf,from,through},provenance:data.provenance+` Fib inspection uses completed ${tf} candles, with earlier pivot warmup.`},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:'Fib candle load failed.'},{status:500});}}
