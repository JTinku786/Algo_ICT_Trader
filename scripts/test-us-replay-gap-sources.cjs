const assert = require('node:assert/strict');
const origin = 'http://localhost:3000';

(async () => {
  // JNJ's July archive is empty, while candles_5m holds fourteen full sessions.
  // All replay timeframes must use those same stored bars, rather than report
  // missing history or build incomplete HTF candles.
  for (const [tf, count] of [['5m',1092], ['15m',364], ['30m',182], ['1h',98]]) {
    const response = await fetch(`${origin}/api/daily-bias/replay?symbol=JNJ&tf=${tf}&from=2026-07-07&through=2026-07-24&backtest=1`);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    assert.equal(data.bars.length, count, tf);
    assert.ok(data.audit.sources.includes('yfinance'));
    assert.ok(data.bars.every(b => b.day >= '2026-07-07' && b.day <= '2026-07-24' && b.knownAt > b.t));
    if (tf === '1h') {
      assert.ok(data.bars.every(b => b.minute >= 570 && (b.minute - 570) % 60 === 0));
      assert.ok(data.bars.every(b => b.knownAt - b.t === Math.min(60, 960 - b.minute) * 60000));
    }
    console.log(`PASS JNJ July gap source ${tf}: ${data.bars.length} completed candles`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
