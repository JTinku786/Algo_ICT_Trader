const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),{spawnSync}=require('node:child_process');
const m={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/fib-calculation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);const f=m.exports;
const cases=[];
for(const name of ['AAPL','CHFJPY','GBPJPY','ASIANPAINT_NS','BAJAJFINSV_NS','CIPLA_NS','ETERNAL_NS','INDUSINDBK_NS']){
 const {bars}=JSON.parse(fs.readFileSync(`public/reports/fib-calculation/${name}-daily.json`,'utf8'));
 for(const size of [50,Math.floor(bars.length/2),bars.length-10,bars.length]){
  const prefix=bars.slice(0,size),at=prefix.at(-1).knownAt,anchor=f.retracementAnchors(f.zigzagPivots(prefix,10,3));
  cases.push({name,size,bars,at,expected:anchor&&{low:Math.min(...anchor.points.map(p=>p.price)),high:Math.max(...anchor.points.map(p=>p.price)),knownAt:Math.max(...anchor.points.map(p=>p.knownAt))}});
 }
}
const result=spawnSync('python',['-c',`import sys,json;sys.path.insert(0,'scripts');from fvg_dealing_range import AutoFibRanges
cases=json.load(sys.stdin);out=[]
for case in cases:
 index=AutoFibRanges(case['bars'],'1d');r=index.range_at(case['at'],'BUY');prefix=AutoFibRanges([b for b in case['bars'] if b['knownAt']<=case['at']],'1d').range_at(case['at'],'BUY');assert r==prefix
 proofs=[]
 if r and r['state']=='ACTIVE':
  span=r['high']-r['low']
  for direction,fraction in [('BUY',.25),('BUY',.75),('SELL',.75),('SELL',.25),('BUY',.5),('SELL',.5)]:
   price=r['low']+span*fraction;proofs.append(index.qualify({'direction':direction,'low':price,'high':price},case['at'])['valid'])
 out.append({'range':r,'proofs':proofs})
json.dump(out,sys.stdout)`],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:10*1024*1024});
assert.equal(result.status,0,result.stderr);const results=JSON.parse(result.stdout);let active=0;
results.forEach(({range:r,proofs},i)=>{const e=cases[i].expected;assert.equal(Boolean(r),Boolean(e));if(e){assert.equal(r.low,e.low);assert.equal(r.high,e.high);assert.equal(r.knownAt,e.knownAt);assert(r.knownAt<=cases[i].at);assert.equal(r.method,'AUTO_FIB_RETRACEMENT');}if(proofs.length){active++;assert.deepEqual(proofs,[true,false,true,false,true,true]);}});
assert(active>0);console.log(`PASS Auto Fib FVG: ${cases.length} cross-language prefix comparisons; ${active} active BUY/SELL discount/premium and equilibrium cases; append-future stability`);
