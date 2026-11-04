const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
function load(file){const m=new Module(file);m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file+'.cjs');return m.exports;}
const {swingFourHour}=load('src/lib/swing-four-hour.ts');
const {swingRisk}=load('src/lib/swing-risk.ts');
function source(count,minutes,anchor=570,day='2026-01-06'){const t=Date.parse(day+'T14:30:00Z');return Array.from({length:count},(_,i)=>({t:t+i*minutes*60000,knownAt:t+(i+1)*minutes*60000,day,minute:anchor+i*minutes,o:100+i,h:102+i,l:99+i,c:101+i}));}
const fine=source(78,5),hours=source(7,60);
const r=swingFourHour(fine,hours,'us');assert.equal(r.bars.length,1);assert.equal(r.bars[0].knownAt-r.bars[0].t,14400000);assert.equal(r.bars[0].o,100);assert.equal(r.bars[0].c,148);assert.equal(r.bars[0].h,149);assert.equal(r.bars[0].l,99);assert.equal(r.hourlyWindows,0);assert.equal(r.withheld,1);
assert.equal(swingFourHour(fine.slice(0,47),hours,'us').bars.length,0,'Never patch a finer-data gap with coarse rows');
assert.equal(swingFourHour([],hours,'us').bars.length,1);
assert.equal(swingFourHour([],hours,'us').hourlyWindows,1);
assert.equal(swingFourHour([...fine,fine[0]],hours,'us').bars.length,0,'Duplicates withheld');
assert.equal(swingFourHour(source(48,5,575),[],'us').bars.length,0,'A late beginning is not a full anchored window');
const india=swingFourHour(source(75,5,555),[],'india');assert.equal(india.bars.length,1);
const fx=swingFourHour(source(48,5,1020),[],'forex');assert.equal(fx.bars.length,1);
const risk=swingRisk(100,95,140,'BUY',10000,1,1,3);assert.equal(risk.units,20);assert.equal(risk.loss,100);assert.equal(risk.reward,800);assert.equal(risk.grossR,8);assert.equal(risk.rewardPercent,8);assert.equal(risk.leverage,.2);
const limited=swingRisk(100,99,108,'BUY',10000,10,1,1);assert.equal(limited.units,100);assert.equal(limited.riskPercent,1);assert.equal(limited.rewardPercent,8);assert.equal(limited.leverageLimited,true);
const short=swingRisk(100,105,60,'SELL',10000,1,1,3,1);assert.equal(short.netR,39/6);assert.equal(short.loss,100);
assert.equal(swingRisk(100,105,140,'BUY',10000,1,1,3),null);
assert.equal(swingRisk(100,95,90,'BUY',10000,1,1,3),null);
assert.equal(swingRisk(100,95,140,'BUY',10000,1,0,3),null);
console.log('PASS: session-anchored 4H aggregation, causal completion, partial/duplicate/gap withholding, coarse fallback, India/FX anchors, risk budget, costs and leverage cap without double-counted returns.');
