// Research-only: reuse the exact chart detector without changing strategy or database rows.
const fs=require('fs'),ts=require('typescript'),crypto=require('crypto');
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(fs.readFileSync(p,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,p);
const {deriveIctOverlays}=require('../src/lib/weekly-replay.ts');
const input=JSON.parse(fs.readFileSync('tmp/s01v3-daily-pd-input.json','utf8'));
const kinds=['OB','BREAKER','FVG','IFVG'];
const rows=input.orders.map(o=>{
 const daily=input.symbols[o.symbol].filter(b=>b.knownAt<o.fill_ms && b.day<o.day);
 const overlays=deriveIctOverlays(daily,'1d','us',daily);
 const zones=overlays.filter(z=>kinds.includes(z.kind)&&z.knownAt<o.fill_ms&&z.status!=='SWEPT');
 const pools=overlays.filter(z=>['BSL','SSL','EQH','EQL'].includes(z.kind)&&z.knownAt<o.fill_ms&&z.status!=='SWEPT');
 function raids(bar){return bar?pools.filter(p=>['BSL','EQH'].includes(p.kind)?bar.h>p.high&&bar.c<p.high:bar.l<p.low&&bar.c>p.low).map(p=>({...p,reversal_direction:['BSL','EQH'].includes(p.kind)?'SELL':'BUY',bar_known_at:new Date(bar.knownAt).toISOString()})):[];}
 const preEntryRaids=raids(o.previous_5m),entryRaids=raids(o.entry_5m);
 const adverse=entryRaids.filter(p=>p.reversal_direction!==o.direction);
 const sessionRaids=pools.filter(p=>['BSL','EQH'].includes(p.kind)?o.pre_entry_day_high>p.high&&o.fill_price<p.high:o.pre_entry_day_low<p.low&&o.fill_price>p.low).map(p=>({...p,reversal_direction:['BSL','EQH'].includes(p.kind)?'SELL':'BUY'}));
 const sessionAdverse=sessionRaids.filter(p=>p.reversal_direction!==o.direction);
 const inside=z=>o.fill_price>=z.low&&o.fill_price<=z.high;
 const evidence=zones.map(z=>{
  const later=daily.filter(b=>b.knownAt>z.knownAt);
  const fullRebalanced=z.kind==='FVG'&&later.some(b=>z.direction==='BUY'?b.l<=z.low:b.h>=z.high);
  return {...z,known_at_iso:new Date(z.knownAt).toISOString(),origin_iso:new Date(z.origin).toISOString(),at_entry:inside(z),session_touched_by_entry:o.pre_entry_day_high>=z.low&&o.pre_entry_day_low<=z.high,alignment:z.direction===o.direction?'supporting':'opposing',fully_rebalanced:fullRebalanced};
 });
 const hits=evidence.filter(z=>z.at_entry),fresh=hits.filter(z=>!z.fully_rebalanced);
 const net=o.r_plan==null?null:Math.round((o.r_plan-0.0003*(o.fill_price+o.exit_price)/Math.abs(o.fill_price-o.stop))*100)/100;
 return {...o,net_r:net,result:net==null?'UNRESOLVED':net>0?'WIN':'LOSS',daily_last_completed:daily.at(-1)?.day,zones_at_entry:hits,session_touch_zones:evidence.filter(z=>z.session_touched_by_entry),active_zone_count:zones.length,session_liquidity_reclaims_at_entry:sessionRaids,session_liquidity_reversal:!!sessionRaids.length,session_adverse_liquidity_reversal:!!sessionAdverse.length,pre_entry_liquidity_reclaims:preEntryRaids,entry_candle_liquidity_reclaims:entryRaids,entry_liquidity_reversal:!!entryRaids.length,entry_adverse_liquidity_reversal:!!adverse.length,pre_entry_liquidity_reversal:!!preEntryRaids.length,any:!!hits.length,opposing:hits.some(z=>z.alignment==='opposing'),supporting:hits.some(z=>z.alignment==='supporting'),fresh_any:!!fresh.length,fresh_opposing:fresh.some(z=>z.alignment==='opposing'),...Object.fromEntries(kinds.map(k=>[k,hits.some(z=>z.kind===k)]))};
});
function stats(rs){const closed=rs.filter(r=>r.net_r!==null),wins=closed.filter(r=>r.result==='WIN'),loss=closed.filter(r=>r.result==='LOSS');return{fills:rs.length,closed:closed.length,wins:wins.length,losses:loss.length,unresolved:rs.length-closed.length,win_rate:closed.length?100*wins.length/closed.length:null,net_r:closed.reduce((a,r)=>a+r.net_r,0),profit_factor:loss.length?wins.reduce((a,r)=>a+r.net_r,0)/-loss.reduce((a,r)=>a+r.net_r,0):null};}
const groups={baseline:stats(rows)};
for(const f of ['any','opposing','supporting','fresh_any','fresh_opposing',...kinds,'session_liquidity_reversal','session_adverse_liquidity_reversal','pre_entry_liquidity_reversal','entry_liquidity_reversal','entry_adverse_liquidity_reversal'])for(const v of [true,false])groups[`${f}_${v}`]=stats(rows.filter(r=>r[f]===v));
for(const side of ['BUY','SELL'])for(const v of [true,false])groups[`${side}_opposing_${v}`]=stats(rows.filter(r=>r.direction===side&&r.opposing===v));
for(const [name,predicate] of Object.entries({only_opposing:r=>r.opposing&&!r.supporting,only_supporting:r=>r.supporting&&!r.opposing,both:r=>r.opposing&&r.supporting,neither:r=>!r.any,untouched_opposing:r=>r.zones_at_entry.some(z=>z.alignment==='opposing'&&z.touches===0)}))groups[name]=stats(rows.filter(predicate));
const closed=rows.filter(r=>r.net_r!==null).sort((a,b)=>a.fill_ms-b.fill_ms),split=Math.floor(closed.length*0.7);
for(const [name,rs] of [['first70',closed.slice(0,split)],['last30',closed.slice(split)]])for(const v of [true,false])groups[`${name}_opposing_${v}`]=stats(rs.filter(r=>r.opposing===v));
const assert=require('assert');assert.equal(rows.length,64);assert.equal(new Set(rows.map(r=>r.setup_id)).size,64);assert.equal(closed.length,62);assert.ok(Math.abs(groups.baseline.net_r-3.85)<1e-8);
for(const r of rows){assert.ok(r.entry_5m,'Missing exact entry 5m candle');assert.ok(r.daily_last_completed<r.day);for(const z of [...r.zones_at_entry,...r.session_liquidity_reclaims_at_entry])assert.ok(z.knownAt<r.fill_ms);}
const report={run_id:input.run_id,method:'Chart detector candidates from completed prior Daily candles only. Entry-price containment; session touch uses only completed 5m bars preceding fill plus fill price. No entry-day completed OHLC. Zones active until Daily close through; FVG full-rebalance sensitivity provided. Breaker detector uses its existing trailing 240 Daily bars. Entry-5m reversal is a post-fill diagnostic only.',costs:'Target 1; fixed $100 risk; stored gross planned-risk R minus 3bps on entry plus exit notionals, sized using actual fill-stop distance and rounded per trade to 2 decimals; matches dashboard default',detector_hash:crypto.createHash('sha256').update(fs.readFileSync('src/lib/weekly-replay.ts')).update(fs.readFileSync('src/lib/liquidity-sweeps.ts')).digest('hex'),groups,rows};
fs.writeFileSync('public/reports/s01-v3-daily-pd-entry-analysis.json',JSON.stringify(report,null,2));
const cols=['symbol','setup_id','entry_et','direction','fill_price','result','exit_type','net_r','daily_last_completed','any','opposing','supporting','fresh_any','OB','BREAKER','FVG','IFVG','session_liquidity_reversal','session_adverse_liquidity_reversal','entry_liquidity_reversal','entry_adverse_liquidity_reversal'];
fs.writeFileSync('public/reports/s01-v3-daily-pd-entry-analysis.csv',cols.join(',')+'\n'+rows.map(r=>cols.map(c=>JSON.stringify(r[c]??'')).join(',')).join('\n'));
console.log(JSON.stringify(groups,null,2));
console.log('EXAMPLES',JSON.stringify(rows.filter(r=>r.any).map(r=>({symbol:r.symbol,entry:r.entry_et,direction:r.direction,price:r.fill_price,result:r.result,zones:r.zones_at_entry.map(z=>({kind:z.kind,direction:z.direction,low:z.low,high:z.high,origin:z.originDay,known:z.known_at_iso,status:z.status,full:z.fully_rebalanced}))})),null,2));
