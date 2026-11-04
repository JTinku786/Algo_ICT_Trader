const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
function load(name, file, dependencies = {}) {
  const m = new Module(name);
  m.require = id => { if (dependencies[id]) return dependencies[id]; throw Error(`Unexpected dependency ${id}`); };
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, `${name}.cjs`);
  return m.exports;
}
const sweep = load('sweeps', 'src/lib/liquidity-sweeps.ts');
const { confirmedSwingPath, deriveIctOverlays } = load('replay', 'src/lib/weekly-replay.ts', { './liquidity-sweeps': sweep });
const bar = (i, o, h, l, c) => ({ t: Date.parse('2026-04-08T13:30:00Z') + i * 60000,
  knownAt: Date.parse('2026-04-08T13:30:00Z') + (i + 1) * 60000,
  day: '2026-04-08', minute: 570 + i, o, h, l, c });
const pivot = [bar(0,10,11,9,10), bar(1,11,14,10,13), bar(2,11,12,10,11)];
assert.equal(confirmedSwingPath(pivot, '1m')[0].knownAt, pivot[2].knownAt);
assert.equal(confirmedSwingPath(pivot.slice(0,2), '1m').length, 0);
assert.equal(confirmedSwingPath([pivot[0],pivot[1],{...pivot[2],t:pivot[2].t+60000}], '1m').length, 0);
const gap = [bar(0,10,11,9,10), bar(1,11,14,10,13), bar(2,13,15,12,14)];
const fvg = deriveIctOverlays(gap, '1m', 'us', []).find(z => z.kind === 'FVG');
assert.ok(fvg); assert.equal(fvg.tf, '1m'); assert.equal(fvg.knownAt, gap[2].knownAt);
assert.equal(deriveIctOverlays(gap.slice(0,2), '1m', 'us', []).filter(z => z.kind === 'FVG').length, 0);
(async () => {
  const response = await fetch('http://localhost:3000/api/daily-bias/replay?symbol=AAPL&tf=1m&from=2026-04-08&backtest=1');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.frame, '1m'); assert.ok(data.bars.length);
  assert.ok(data.bars.every(b => b.knownAt - b.t === 60000));
  assert.match(data.provenance, /not derived from 5-minute/);
  console.log('PASS: native 1m candles, 60-second completion, causal swings/FVG, missing-minute rejection');
})().catch(error => { console.error(error); process.exitCode = 1; });
