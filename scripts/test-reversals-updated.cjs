const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const moduleBox = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/reversals-updated.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: moduleBox.exports, URLSearchParams, Date, Number, Error });
const { parseReversalFilters, costInR, fmtR, estimateReversalCost } = moduleBox.exports;
assert.equal(costInR(0.25, 5), 0.2);
assert.equal(costInR(0.1, 2), 0.2);
assert.equal(costInR(0, 5), null);
assert.equal(costInR(null, 5), null);
assert.equal(fmtR(null), '—');
const fxAssumptions = parseReversalFilters(new URLSearchParams('market=forex&costMode=reconstructed&spread=2&commissionBps=1&slippageBps=1&financingBpsPerDay=1'));
assert(Math.abs(estimateReversalCost({ ticker:'^EURUSD', entry:1, stop:0.999, risk_pct:0.1, held_days:2 }, fxAssumptions)-0.6)<1e-10, '2 pips spread + 2 bps fees/slippage + 2 days financing = 0.6R');
assert(Math.abs(estimateReversalCost({ ticker:'^USDJPY', entry:150, stop:149.85, risk_pct:0.1, held_days:0 }, {...fxAssumptions,commissionBps:0,slippageBps:0,financingBpsPerDay:0})-2*0.01/0.15)<1e-10, 'JPY pip conversion');
assert.equal(estimateReversalCost({ ticker:'^EURUSD', entry:1, stop:0.999, risk_pct:0.1, held_days:null }, fxAssumptions), null, 'unknown holding cost cannot become zero');
assert.throws(() => parseReversalFilters(new URLSearchParams('lane=practice&costMode=reconstructed')), 'do not charge spread twice on practice fills');
for (const query of ['tf=2h', 'lane=live', 'start=2026-02-30', 'start=2026-10-16&end=2026-01-01', 'costBps=-1', 'costBps=Infinity', 'page=1.2', 'symbol=ABC%27%3BDELETE']) {
  assert.throws(() => parseReversalFilters(new URLSearchParams(query)), query);
}
assert.equal(parseReversalFilters(new URLSearchParams('symbol=%5Eeurusd')).symbol, '^EURUSD');

const { reversalDecisionReason } = moduleBox.exports;
assert.equal(reversalDecisionReason({state:'SKIPPED',reason:'STALE_SIGNAL (> 15 min old)'}),'STALE_SIGNAL (> 15 min old)');
assert.equal(reversalDecisionReason({state:'SKIPPED',reason:'  '}),'No skip reason was recorded.');
assert.equal(reversalDecisionReason({state:'SKIPPED',reason:null}),'No skip reason was recorded.');
assert.equal(reversalDecisionReason({state:'UNVERIFIED',reason:'["MISSING_RAW_CANDLES","MISSING_RAW_CANDLES","NO_CAUSAL_FILL"]'}),'MISSING_RAW_CANDLES; NO_CAUSAL_FILL');
assert.equal(reversalDecisionReason({state:'SKIPPED',reason:'[]'}),'No skip reason was recorded.');
assert.equal(reversalDecisionReason({state:'SKIPPED',reason:'[incomplete'}),'[incomplete');
assert.equal(reversalDecisionReason({state:'CLOSED_SL',reason:'DISASTER_STOP'}),'DISASTER_STOP');

const origin = process.env.REVERSAL_TEST_ORIGIN || 'http://localhost:3000';
async function read(query) {
  const response = await fetch(`${origin}/api/reversals-updated?${query}`);
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  const m = data.metrics;
  assert.equal(m.total, m.closed + m.open + m.unverified + m.invalid + m.excluded + m.other, 'waterfall must reconcile');
  assert.equal(m.closed, m.wins + m.losses);
  assert.equal(data.yearly.reduce((sum, y) => sum + y.n, 0), m.closed, 'calendar slices cover the complete closed cohort');
  assert(data.rows.length <= data.page_size);
  return data;
}
(async () => {
  const history = await read('lane=history&market=us&tf=1h');
  assert.equal(history.run.timeframe, '1h');
  assert(history.run.run_id.includes('FULL_1h'));
  assert(history.metrics.closed > 50, 'metrics must cover more than the displayed page');
  assert.equal(history.metrics.sensitivity_r, history.metrics.avg_r, 'zero added costs preserve expectancy');
  assert(history.policies.every(p => p.policy === 'M5_CLOSE_SL_WICK_TP_V1'));
  const page2 = await read('lane=history&market=us&tf=1h&page=2');
  assert.equal(page2.metrics.closed, history.metrics.closed);
  const ids = new Set(history.rows.map(r => r.id));
  assert(page2.rows.every(r => !ids.has(r.id)), 'pages must not overlap');
  const cost = await read('lane=history&market=us&tf=1h&costBps=5');
  assert(cost.metrics.sensitivity_r < cost.metrics.avg_r);
  const empty = await read('lane=history&market=us&tf=1h&symbol=ZZZZZZ');
  assert.equal(empty.metrics.closed, 0); assert.equal(empty.metrics.avg_r, null); assert.equal(empty.rows.length, 0);
  const missing = await read('lane=practice&market=us&tf=1h');
  assert.equal(missing.available, false); assert.equal(missing.rows.length, 0);
  const paper = await read('lane=paper&market=forex&tf=1h');
  assert(paper.rows.every(r => r.evidence.execution_mode === 'PAPER_ONLY'));
  const reconstructed = await read('lane=history&market=forex&tf=1h&costMode=reconstructed&spread=1.5&commissionBps=0.2&slippageBps=0.1&financingBpsPerDay=0.1');
  assert(reconstructed.metrics.adjusted_avg_r < reconstructed.metrics.avg_r);
  assert.equal(reconstructed.metrics.adjusted_wins + reconstructed.metrics.adjusted_losses, reconstructed.metrics.adjusted_n);
  assert.equal(reconstructed.yearly.reduce((sum,y) => sum+y.adjusted_n,0),reconstructed.metrics.adjusted_n);
  const reconstructedFilters = parseReversalFilters(new URLSearchParams('market=forex&costMode=reconstructed&spread=1.5&commissionBps=0.2&slippageBps=0.1&financingBpsPerDay=0.1'));
  for(const row of reconstructed.rows.filter(r => r.r !== null)) {
    const expected = estimateReversalCost(row,reconstructedFilters);
    assert(Math.abs(row.cost_r-expected)<1e-9, 'server and independent per-trade reconstruction must agree');
    assert(Math.abs(row.display_r-(row.r-expected))<1e-9);
  }
  const switchedOff = await read('lane=history&market=forex&tf=1h&costMode=gross&spread=1.5&commissionBps=0.2');
  assert.equal(switchedOff.metrics.avg_r,switchedOff.metrics.adjusted_avg_r,'switching costs off restores gross result');
  const practice = await read('lane=practice&market=forex&tf=30m');
  assert(practice.rows.every(r => r.policy === 'OANDA_PRACTICE_MARKET'));
  const ticker = history.rows[0].ticker;
  const filtered = await read(`lane=history&market=us&tf=1h&symbol=${encodeURIComponent(ticker)}`);
  assert(filtered.rows.every(r => r.ticker === ticker));
  const csv = await fetch(`${origin}/api/reversals-updated?lane=history&market=us&tf=1h&symbol=${encodeURIComponent(ticker)}&format=csv`);
  assert.equal(csv.status, 200);
  assert.equal(Number(csv.headers.get('x-export-row-count')), filtered.row_count, 'export must include every matching eligible row');
  const text = await csv.text();
  assert(text.includes('"evidence"')); assert(text.includes('M5_CLOSE_SL_WICK_TP_V1'));
  const bad = await fetch(`${origin}/api/reversals-updated?tf=invalid`);
  assert.equal(bad.status, 400);
  console.log(JSON.stringify({ result: 'PASS', historyClosed: history.metrics.closed, paperClosed: paper.metrics.closed, practiceClosed: practice.metrics.closed, exportedRows: filtered.row_count, checks: ['filter validation','R cost units','waterfall','yearly totals','pagination','cost sensitivity','empty states','market isolation','contract isolation','full export'] }));
})().catch(error => { console.error(error); process.exitCode = 1; });
