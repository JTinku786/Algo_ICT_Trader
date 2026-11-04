const fs=require('node:fs'),ts=require('typescript'),Module=require('node:module'),assert=require('node:assert/strict');
function load(path,deps={}){const m=new Module(path);const native=m.require.bind(m);m.require=id=>deps[id]||native(id);m._compile(ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,path+'.cjs');return m.exports;}
const w=load('src/lib/weekly-replay.ts',{'./liquidity-sweeps':load('src/lib/liquidity-sweeps.ts')}),{wickRejections}=load('src/lib/wick-rejections.ts',{'./weekly-replay':w});
function b(i,o,h,l,c){const t=Date.UTC(2024,i,1);return {t,day:new Date(t).toISOString().slice(0,10),knownAt:t+20*86400000,minute:0,o,h,l,c};}
const base=Array.from({length:8},(_,i)=>b(i,105,111,99,106));
const pivot=b(8,108,110,94,109), confirm=b(9,110,117,101,116);
assert.equal(wickRejections([...base,pivot],'1mo').length,0);
const start=[...base,pivot,confirm];const zone=wickRejections(start,'1mo')[0];assert.ok(zone);assert.equal(zone.low,94);assert.equal(zone.high,108);assert.equal(zone.knownAt,confirm.knownAt);assert.equal(zone.touches,0);
const returned=[...start,b(10,110,112,106,110),b(11,110,112,106,110),b(12,112,115,111,114),b(13,110,112,106,110)];assert.equal(wickRejections(returned,'1mo').find(z=>z.id===zone.id).touches,2);
const invalid=[...returned,b(14,100,105,90,93)];assert.equal(wickRejections(invalid,'1mo').find(z=>z.id===zone.id).status,'INVALIDATED');
assert.deepEqual(wickRejections(invalid.slice(0,start.length),'1mo'),wickRejections(start,'1mo'));
assert.equal(wickRejections(start,'1mo',['2024-08-18']).length,0);
const mirrored=start.map(x=>({...x,o:220-x.o,h:220-x.l,l:220-x.h,c:220-x.c}));assert.equal(wickRejections(mirrored,'1mo')[0].direction,'SELL');
assert.equal(wickRejections([...base,{...pivot,l:107},confirm],'1mo').length,0);
console.log('PASS: wick-to-body bounds, delayed departure confirmation, mirrored rejection, separate return visits, invalidation, invalid source exclusion and replay rewind.');
