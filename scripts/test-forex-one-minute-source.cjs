const assert = require('node:assert/strict');
(async () => {
  const r = await fetch('http://localhost:3000/api/daily-bias/replay?symbol=%5EEURUSD&tf=1m&from=2026-08-26&through=2026-08-30&backtest=1');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.frame, '1m'); assert.ok(d.bars.length > 3000);
  assert.ok(d.bars.every(b => b.day >= '2026-08-26' && b.day <= '2026-08-30' && b.knownAt-b.t === 60000));
  assert.match(d.provenance, /historical_candles_1m/);
  const invalid = await fetch('http://localhost:3000/api/daily-bias/replay?symbol=%5EEURUSD&tf=1m&through=2026-02-30');
  assert.equal(invalid.status, 400);
  const p = await fetch('http://localhost:3000/api/market-structure-shift', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
      symbol:'^EURUSD',tf1:'1d',tf2:'1m',start:'2026-08-26',end:'2026-08-30',htfKinds:['FVG'],ltfKinds:['FVG'],
    }),
  });
  const result = await p.json();
  assert.equal(p.status, 200, result.error);
  assert.equal(result.lower.length, d.bars.length + 250);
  assert.ok(result.lower.every(b => b.knownAt-b.t === 60000));
  assert.ok(result.timings.totalSeconds < 120);
  const tooLarge = await fetch('http://localhost:3000/api/market-structure-shift', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      symbol:'^EURUSD',tf1:'1d',tf2:'1m',start:'2026-08-01',end:'2026-08-30',htfKinds:['FVG'],ltfKinds:['FVG'],
    }),
  });
  const cap = await tooLarge.json();
  assert.equal(tooLarge.status, 422); assert.equal(cap.dataAvailable, true);
  assert.equal(cap.maxCandles, 10000); assert.ok(cap.availableCandles > cap.maxCandles);
  console.log(`PASS: EURUSD native 1m, bounded dates, five-day investigation (${result.lower.length} candles), honest 10,000-candle capacity limit`);
})().catch(error => { console.error(error); process.exitCode = 1; });
