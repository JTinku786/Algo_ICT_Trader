const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript');
const mod = { exports: {} };
new Function('exports', 'require', ts.transpileModule(fs.readFileSync('src/lib/minute-rollup.ts','utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(mod.exports, require);
const rollup = mod.exports.rollupMinuteBars;
const t = Date.parse('2026-08-03T06:00:00Z');
const bars = Array.from({length:6},(_,i)=>({t:t+i*60000,day:'2026-08-03',minute:120+i,
  o:10+i,h:12+i,l:9+i,c:11+i,v:i+1,knownAt:t+(i+1)*60000}));
assert.deepEqual(rollup(bars,2)[0],{...bars[0],h:13,l:9,c:12,v:3,knownAt:t+120000});
assert.equal(rollup(bars,3).length,2);
assert.equal(rollup(bars.filter((_,i)=>i!==1),2).length,2,'missing minute excludes its bucket');
assert.equal(rollup(bars.slice(0,1),2).length,0,'partial candle excluded');
assert.equal(rollup([...bars,bars[0]],2).length,2,'duplicate bucket excluded');
assert.equal(rollup(bars.map((b,i)=>i===1?{...b,knownAt:b.t}:b),2).length,2,'uncompleted source excluded');
assert.equal(rollup([...bars].reverse(),2)[0].o,10);
assert(rollup(bars,3).every(b=>b.knownAt===b.t+180000));
console.log('PASS: OHLCV, 2m/3m activation, partial/missing/duplicate/incomplete buckets, sorted input');

const hours=Array.from({length:4},(_,i)=>({...bars[0],t:t+i*3600000,knownAt:t+(i+1)*3600000,minute:i*60}));
assert.equal(mod.exports.rollupFourHourBars(hours)[0].knownAt,t+4*3600000);
assert.equal(mod.exports.rollupFourHourBars(hours.slice(0,3)).length,0);
assert.equal(mod.exports.rollupFourHourBars([...hours,hours[0]]).length,0);
console.log("PASS: complete consecutive local-day 4h aggregation, activation, incomplete and duplicate rejection");
