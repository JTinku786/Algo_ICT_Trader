const assert = require('node:assert/strict');
const origin = 'http://localhost:3000';
const selection = {symbol:'^EURUSD', start:'2026-08-27', end:'2026-08-29',
  htfKinds:['OB','BREAKER','FVG','IFVG','BSL','SSL','PDH','PDL'], ltfKinds:['OB','BREAKER','FVG','IFVG']};
(async () => {
  for (const [tf, minutes, count] of [['5m',5,492], ['15m',15,164], ['30m',30,82], ['1h',60,41]]) {
    const response = await fetch(`${origin}/api/daily-bias/replay?symbol=%5EEURUSD&tf=${tf}&from=${selection.start}&through=${selection.end}&backtest=1`);
    const data = await response.json();
    assert.equal(response.status,200,data.error); assert.equal(data.bars.length,count);
    assert.ok(data.bars.every(b=>b.knownAt-b.t===minutes*60000 && b.day>=selection.start && b.day<=selection.end));
    assert.ok(data.daily.some(b=>b.day==='2026-08-28'));
    assert.ok(data.audit.sources.includes('derived_1m'));
    assert.match(data.provenance,new RegExp(`historical_candles_${tf}`));
    // Exercise both uses: TF1 above native 1m, and TF2 beneath Daily.
    for (const [tf1,tf2] of [[tf,'1m'],['1d',tf]]) {
      const t=Date.now();
      const investigation=await fetch(`${origin}/api/market-structure-shift`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...selection,tf1,tf2})});
      const result=await investigation.json();
      assert.equal(investigation.status,200,result.error);
      assert.ok(result.higher.length && result.lower.length);
      assert.equal(result.selection.tf1,tf1); assert.equal(result.selection.tf2,tf2);
      assert.ok(result.higher.some(b=>b.day==='2026-08-28'));
      assert.ok(result.lower.every(b=>b.knownAt-b.t===(tf2==='1m'?1:minutes)*60000));
      console.log(`PASS EURUSD ${tf1} -> ${tf2}: ${result.higher.length} HTF / ${result.lower.length} TF2 candles, ${result.investigations.length} investigations, ${(Date.now()-t)/1000}s`);
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1});
