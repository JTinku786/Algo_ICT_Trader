const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript'), Module = require('node:module');
const m = new Module('mss-risk-buckets');
m._compile(ts.transpileModule(fs.readFileSync('src/lib/mss-risk-buckets.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, 'mss-risk-buckets.cjs');
const { bucketContains, planForBucket } = m.exports;
const source = low => ({ kind: 'BSL', tf: '5m', low, knownAt: 1 });
const plan = { state: 'READY', direction: 'BUY', entry: 100, stop: 95,
  target: 102.1, rr: .42, targetSource: source(102.1),
  targetCandidates: [102.1, 105, 110, 115, 120, 125].map(source) };
for (const [bucket, price, rr] of [['0-1',102.1,.42],['1-2',105,1],['2-3',110,2],['3-4',115,3],['4+',120,4]]) {
  const result = planForBucket(plan, bucket);
  assert.equal(result.state, 'READY'); assert.equal(result.stop, 95);
  assert.equal(result.target, price); assert.ok(Math.abs(result.rr - rr) < 1e-10);
}
assert.equal(bucketContains(1, '0-1'), false);
assert.equal(bucketContains(1, '1-2'), true);
assert.equal(bucketContains(2, '1-2'), false);
assert.equal(bucketContains(4, '3-4'), false);
assert.equal(bucketContains(4, '4+'), true);
assert.equal(bucketContains(0, '0-1'), false);
assert.equal(bucketContains(NaN, 'NEAREST'), false);
assert.strictEqual(planForBucket(plan, 'NEAREST'), plan);
const missing = planForBucket({ ...plan, targetCandidates: [source(102.1)] }, '2-3');
assert.equal(missing.state, 'NO_TARGET_IN_BUCKET'); assert.equal(missing.target, null);
assert.equal(missing.stop, 95); assert.equal(missing.rr, null);
const uncertified = { ...plan, state: 'NO_CONFIRMED_SWEEP' };
assert.strictEqual(planForBucket(uncertified, '4+'), uncertified);
const short = planForBucket({ ...plan, direction: 'SELL', stop: 105,
  targetCandidates: [98, 90, 80].map(low => ({ ...source(low), kind: 'SSL' })) }, '2-3');
assert.equal(short.stop, 105); assert.equal(short.target, 90); assert.equal(short.rr, 2);
assert.equal(plan.target, 102.1); // Selection must not modify exported base evidence.
console.log('PASS: five buckets, exact boundaries, fixed stop, BUY/SELL, missing targets and immutable evidence');
