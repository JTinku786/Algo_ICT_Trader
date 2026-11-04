const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),Module=require('node:module');
const m=new Module('developing');
m.require=(id)=>{assert.equal(id,'./weekly-replay');return {weekStart(day){const d=new Date(`${day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);}};};
m._compile(ts.transpileModule(fs.readFileSync('src/lib/replay-developing.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,'developing.cjs');
const {developingReplayBar}=m.exports;
const start=Date.parse('2026-03-03T14:30:00Z');
const bars=Array.from({length:7},(_,i)=>({t:start+i*300000,knownAt:start+(i+1)*300000,minute:570+i*5,day:'2026-03-03',o:100+i,h:102+i,l:99+i,c:101+i}));
const yesterday={t:start-86400000,knownAt:start-64800000,minute:570,day:'2026-03-02',o:90,h:110,l:85,c:99};
for(const frame of ['15m','30m','1h','1d','1w','1mo']){
 const b=developingReplayBar(frame,bars,[yesterday],[],bars[1].knownAt,570);
 assert.equal(b.c,102);assert.equal(b.knownAt,bars[1].knownAt);assert.equal(b.h,frame==='1w'||frame==='1mo'?110:103);assert.equal(b.o,frame==='1w'||frame==='1mo'?90:100);
 const rewound=developingReplayBar(frame,bars,[yesterday],[],bars[0].knownAt,570);assert.equal(rewound.c,101);
}
const closed15={...bars[0],h:104,l:99,c:103,knownAt:bars[2].knownAt};
assert.equal(developingReplayBar('15m',bars,[],[closed15],bars[2].knownAt,570),null);
assert.equal(developingReplayBar('15m',bars,[],[closed15],bars[3].knownAt,570).o,103);
assert.equal(developingReplayBar('30m',bars.filter((_,i)=>i!==1),[],[],bars[2].knownAt,570),null);
assert.equal(developingReplayBar('5m',bars,[],[],bars[1].knownAt,570),null);
assert.equal(developingReplayBar('1d',bars,[],[{...bars[0],knownAt:bars[6].knownAt}],bars[6].knownAt,570),null);
console.log('PASS: six developing timeframes share revealed 5m close, preserve opens, exclude future data, rewind, roll at closure, and reject missing intraday bars');
