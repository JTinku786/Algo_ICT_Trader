const assert = require('node:assert/strict');

const fs = require('node:fs');

const path = require('node:path');

const os = require('node:os');

const {spawnSync} = require('node:child_process');

const Module = require('node:module');

const ts = require('typescript');

const workspace = process.cwd();

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scalping-backtest-api-'));

const root = path.join(temporary, 'public/reports/scalping-labs/backtest');

fs.mkdirSync(root, {recursive: true});

const entryAt = Date.parse('2023-12-01T15:00:00Z');

const trade = {id: 'fixture-1', symbol: 'AAPL', market: 'us', side: 'BUY', entryAt, entryKnownAt: entryAt + 300000, exitAt: entryAt + 600000, entry: 100, stop: 99, target: 101.5, rrBucket: '1-2', plannedRR: 1.5, result: 'WIN', r: 1.5, tf1Kind: 'OB', tf2Kind: 'VALID_FVG', confirmation: 'CHOCH', attributions: [{tf1Kind: 'OB', tf2Kind: 'VALID_FVG', confirmation: 'CHOCH', contextId: 'context-a', arrayId: 'array-a'}, {tf1Kind: 'OB', tf2Kind: 'VALID_FVG', confirmation: 'CISD', contextId: 'context-b', arrayId: 'array-a'}]};

const opened = {...trade, id: 'fixture-2', entryAt: Date.parse('2024-01-02T15:00:00Z'), exitAt: null, result: 'OPEN', r: null, rrBucket: '4+', plannedRR: 4.5};

fs.writeFileSync(path.join(root, 'trades.ndjson'), [trade, opened].map(r => JSON.stringify(r)).join('\n'));

fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify({status: 'RUNNING', generatedAt: 'fixture', files: ['trades.ndjson'], holdoutStart: '2024-01-01'}));

const script = `import sys;sys.path.insert(0,sys.argv[1]);from scalping_backtest_index import ingest;print(ingest(sys.argv[2]))`;

const indexed = spawnSync('python', ['-c', script, path.join(workspace, 'scripts'), root], {encoding: 'utf8'});

assert.equal(indexed.status, 0, indexed.stderr);

const filename = path.join(workspace, 'src/lib/scalping-backtest-results.ts');

const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText;

process.chdir(temporary);

const m = new Module(filename, module); m.filename = filename; m.paths = module.paths; m._compile(output, filename);

const filters = {markets: [], symbols: [], years: [], buckets: [], side: 'ALL', confirmation: 'ALL', page: 1};

(async () => {

  const results = await m.exports.loadBacktestResults(filters);

  assert.equal(results.summary.status, 'RUNNING'); assert.equal(results.stats.scenarios, 2); assert.equal(results.stats.closed, 1); assert.equal(results.stats.open, 1); assert.equal(results.stats.grossR, 1.5);

  assert.equal(results.heatmapCells.find(c => c.bucket === '1-2').closed, 1, 'Both confirmations must count one economic scenario in a pair heatmap');

  assert.equal(results.combinations.filter(c => c.bucket === '1-2').length, 2);

  assert.equal(results.trades[0].result, 'OPEN'); assert.equal(results.trades[1].attributions.length, 2);

  assert.equal(results.trades[1].attributions[0].contextId, 'context-a');

  const selected = await m.exports.loadBacktestResults({...filters, markets: ['us'], years: ['2023'], confirmation: 'CISD', buckets: ['1-2']});

  assert.equal(selected.stats.scenarios, 1); assert.equal(selected.stats.grossR, 1.5); assert.equal(selected.combinations.length, 1); assert.equal(selected.heatmapCells[0].closed, 1);

  assert.ok(Math.abs(selected.costSensitivity.find(c => c.bps === 2).grossR - 1.48) < 1e-8);

  const exact = await m.exports.loadBacktestResults({...filters, symbols:['AAPL'], buckets:['1-2'], tf1:'OB', tf2:'VALID_FVG', confirmation:'CISD'});
  assert.equal(exact.stats.scenarios,1);assert.equal(exact.pagination.total,1);
  assert.equal(exact.stats.grossR,1.5);assert.equal(exact.combinations.length,1);
  assert.equal(exact.heatmapCells.length,1);assert.equal(exact.buckets.length,1);
  assert.equal(exact.trades[0].sourceFile,'trades.ndjson');
  const missingPair = await m.exports.loadBacktestResults({...filters, tf1:'PDL', tf2:'OB'});
  assert.equal(missingPair.stats.scenarios,0);assert.equal(missingPair.pagination.total,0);
  assert.equal(missingPair.options.symbols[0],'AAPL','Empty filtered results retain selectable historical options');
  assert.equal(results.pairedRR, null);

  const paired = {status: 'AVAILABLE', comparisonAvailable: true, commonFamilies: [], bucketResults: []};

  fs.writeFileSync(path.join(root, 'paired-rr-comparison.json'), JSON.stringify(paired));

  fs.writeFileSync(path.join(root, 'validation.json'), JSON.stringify({status: 'COMPLETE'}));

  const published = await m.exports.loadBacktestResults(filters);

  assert.deepEqual(published.pairedRR, paired, 'Publishing saved paired audit must invalidate a cached response');

  assert.equal(published.validation.status, 'COMPLETE');

  fs.writeFileSync(path.join(root, 'paired-rr-comparison.json'), '{');

  const interrupted = await m.exports.loadBacktestResults(filters);

  assert.equal(interrupted.pairedRR, null, 'Partially published artifact must not break result queries');

  console.log('PASS: readonly SQLite API integrates causal filters, open exclusions, economic heatmap union, confirmation attribution, cost sensitivity, saved replay IDs and provisional status.');

})().catch(e => {console.error(e); process.exitCode = 1;}).finally(() => {

  process.chdir(workspace);

  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));

  assert.ok(path.basename(temporary).startsWith('scalping-backtest-api-'));

  fs.rmSync(temporary, {recursive: true});

});

