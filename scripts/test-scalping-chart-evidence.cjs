const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve('src/lib/scalping-chart-evidence.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
const m=new Module(filename,module);m.filename=filename;m.paths=module.paths;m._compile(compiled.outputText,filename);
const {scalpingEvidence}=m.exports;
const proof={
 context:{id:'1h:OB:1',kind:'OB',tf:'1h',low:99,high:101,origin:1,knownAt:10},
 array:{id:'5m:IFVG:2',kind:'IFVG',tf:'5m',low:100,high:102,origin:2,knownAt:20,lineage:'5m:FVG:2'},
 plan:{sweepSources:[{id:'raid',kind:'SSL',tf:'5m',level:98,knownAt:5}],targetSource:{id:'target',kind:'BSL',tf:'1h',low:104,origin:3,knownAt:8},targetCandidates:[{id:'far',kind:'EQH',tf:'5m',low:110,origin:4,knownAt:9}]},
 validFvg:{VALID_FVG_TF2:{valid:true,range:{tf:'5m',low:97,high:105,equilibrium:101,lowOrigin:1,highOrigin:3,knownAt:15}}}
};
const low=scalpingEvidence(proof,'TF2');
assert.deepEqual(low.zones,[proof.array]);
assert.equal(low.lines.find(l=>l.label==='TF2 dealing range EQ · 50%').price,101);
assert.equal(low.lines.find(l=>l.sourceId==='raid').price,98);
assert.equal(low.lines.find(l=>l.sourceId==='target').originAt,3);
assert.equal(low.lines.filter(l=>l.sourceId==='5m:FVG:2').length,2);
assert.ok(!low.lines.some(l=>l.sourceId==='far'));
assert.ok(scalpingEvidence(proof,'TF2',true).lines.some(l=>l.sourceId==='far'));
const high=scalpingEvidence(proof,'TF1',true);
assert.deepEqual(high.zones,[proof.context]);
assert.ok(!high.lines.some(l=>l.sourceId==='raid'||l.sourceId==='far'));
assert.ok(high.lines.every(l=>Number.isFinite(l.price)&&Number.isFinite(l.knownAt)));
console.log('Saved JSON zones, lineage, raid, target and dealing-range mappings pass.');
