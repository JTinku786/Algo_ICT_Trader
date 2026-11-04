const fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),assert=require('node:assert/strict');
function load(path,deps={}){const m=new Module(path);const native=m.require.bind(m);m.require=id=>deps[id]||native(id);m._compile(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,path+'.cjs');return m.exports;}
const weekly=load('src/lib/weekly-replay.ts',{'./liquidity-sweeps':load('src/lib/liquidity-sweeps.ts')});
const {completedMonthlyBars}=load('src/lib/top-down.ts',{'./weekly-replay':weekly});
function b(day,o,h,l,c){const t=Date.parse(day+'T14:30:00Z');return {t,day,knownAt:t+23400000,minute:570,o,h,l,c};}
const bars=[b('2025-12-01',100,105,99,104),b('2025-12-31',104,108,101,107),b('2026-01-06',107,110,106,108),b('2026-02-03',108,999,1,500)];
const result=completedMonthlyBars(bars,'2026-01-06');assert.equal(result.length,1);assert.deepEqual([result[0].o,result[0].h,result[0].l,result[0].c],[100,108,99,107]);assert.equal(result[0].knownAt,bars[1].knownAt);
assert.equal(completedMonthlyBars(bars,'2026-01-06',['2025-12-18']).length,0);
assert.deepEqual(completedMonthlyBars(bars.slice(0,3),'2026-01-06'),result);
const gap=[b('2025-01-01',2,3,1,2),b('2025-03-01',4,5,3,4),b('2025-04-01',2,3,1,2)];assert.equal(weekly.confirmedSwingPath(gap,'1mo').length,0);
console.log('PASS: completed monthly OHLC, final-session confirmation, forming month exclusion, invalid month exclusion, future invariance and monthly swing adjacency.');
