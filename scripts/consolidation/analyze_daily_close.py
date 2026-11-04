"""Breakout-day close diagnostic on audited consolidation fade trades; no DB writes."""
import argparse
import gzip
import hashlib
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path.home() / 'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect
from reversal_candle_source import load_candles, rollup_candles, ZONE

VERSION = 'CONSOLIDATION_BREAKOUT_DAY_CLOSE_V1'
KEYS = ['box_tf', 'config', 'model', 'target', 'policy', 'side', 'period', 'regime']


def classify_close(close, high, low, side, epsilon=0.0001):
    if high <= low or side not in (-1, 1):
        raise ValueError('Invalid frozen range or fade side')
    if close > high + epsilon:
        return 'PRESSURE_CONTINUES' if side == -1 else 'THROUGH_OPPOSITE_EDGE'
    if close < low - epsilon:
        return 'PRESSURE_CONTINUES' if side == 1 else 'THROUGH_OPPOSITE_EDGE'
    if abs(close - high) <= epsilon or abs(close - low) <= epsilon:
        return 'AT_EDGE'
    return 'INSIDE_RANGE'


def metrics(frame):
    records = []
    for side in ('ALL', 'BUY', 'SELL'):
        sides = frame if side == 'ALL' else frame[frame.side == side]
        for period in ('ALL', '2022_PLUS'):
            part = sides if period == 'ALL' else sides[sides.year >= 2022]
            for all_regimes in (False, True):
                sub = part.copy()
                sub['side'] = side
                sub['period'] = period
                sub['scored'] = sub.outcome.isin(['win', 'loss', 'time_exit']) & sub.r.notna() & sub.regime.ne('UNVERIFIED_DAY')
                if all_regimes:
                    sub['regime'] = 'ALL'
                sub['gross_positive'] = sub.scored & (sub.r > 0)
                sub['target_hit'] = sub.scored & sub.outcome.eq('win')
                sub['net_positive'] = sub.scored & (sub.net_5bps_r > 0)
                sub['gross_r_scored'] = sub.r.where(sub.scored)
                sub['net_r_scored'] = sub.net_5bps_r.where(sub.scored)
                sub['closed_before_close_scored'] = sub.closed_before_day_close & sub.scored
                grouped = sub.groupby(KEYS).agg(entries=('entry_at', 'size'), scored=('scored', 'sum'),
                    gross_positive=('gross_positive', 'sum'), target_hits=('target_hit', 'sum'),
                    net_positive=('net_positive', 'sum'), avg_r=('gross_r_scored', 'mean'),
                    total_r=('gross_r_scored', 'sum'), avg_net_r=('net_r_scored', 'mean'),
                    total_net_r=('net_r_scored', 'sum'), close_known_at_entry=('close_known_at_entry', 'sum'),
                    closed_before_day_close=('closed_before_close_scored', 'sum')).reset_index()
                records.extend(grouped.to_dict('records'))
    return records


def worker(task):
    sym, asof, cached_only = task
    cached = ROOT / 'tmp/consolidation-day-close' / (sym + '.csv.gz')
    if cached_only:
        annotated = pd.read_csv(cached)
        sample = annotated[annotated.target.eq('2R') & annotated.policy.eq('CLOSE5') & annotated.regime.eq('PRESSURE_CONTINUES')]
        sample = sample.sort_values('entry_at', ascending=False).groupby(['box_tf', 'config', 'model', 'side', 'outcome']).head(1)
        return dict(sym=sym, fingerprint_matches=not annotated.day_evidence_reason.eq('SOURCE_SNAPSHOT_CHANGED').any(),
            fingerprint=str(annotated.source_fingerprint.iloc[0]), entries=len(annotated),
            unique_events=len(annotated[['box_id', 'model', 'entry_at']].drop_duplicates()),
            complete_raid_days=int(annotated.loc[annotated.regime.ne('UNVERIFIED_DAY'), 'raid_day'].nunique()),
            metrics=metrics(annotated), examples=json.loads(sample.to_json(orient='records')))
    path = ROOT / 'tmp/consolidation-research-audited' / (sym + '.csv')
    frame = pd.read_csv(path)
    frame = frame[frame.policy.isin(['HARD5', 'CLOSE5']) & ~frame.model.eq('EXPANSION_OB_RETEST')].copy()
    # The outcome ledger was independently audited against this frozen raw snapshot.
    with connect() as con:
        bars, audit = load_candles(con, 'us', sym, datetime(2015, 7, 1, tzinfo=timezone.utc), datetime.fromisoformat(asof))
    source_matches = set(frame.source_fingerprint) == {audit['fingerprint']}
    daily = {b['day']: b for b in rollup_candles(bars, 'us', '1d')}
    raw = {b['knownAt']: b for b in bars}
    evidence = []
    events = frame[['box_id', 'model', 'entry_at', 'raid_at', 'decision_known_at', 'box_hi', 'box_lo', 'side']].drop_duplicates()
    for row in events.itertuples(index=False):
        day = datetime.fromtimestamp((row.raid_at - 1) / 1000, timezone.utc).astimezone(ZONE).date().isoformat()
        d = daily.get(day)
        raid = raw.get(int(row.raid_at))
        valid = source_matches and d is not None and raid is not None
        # A confirmed raw raid is required; edge-touch fills alone are not a break.
        tol = 1e-5 * (row.box_hi + row.box_lo) / 2
        pierced = raid is not None and (raid['h'] > row.box_hi + tol if row.side == -1 else raid['l'] < row.box_lo - tol)
        regime = classify_close(d['c'], row.box_hi, row.box_lo, row.side, tol) if valid and pierced else 'UNVERIFIED_DAY'
        reason = None if valid and pierced else 'SOURCE_SNAPSHOT_CHANGED' if not source_matches else 'NO_COMPLETE_DAILY_CANDLE' if d is None else 'NO_RAW_RAID_CANDLE' if raid is None else 'EDGE_TOUCH_NOT_CONFIRMED_BREAK'
        evidence.append(dict(box_id=row.box_id, model=row.model, entry_at=row.entry_at,
            raid_day=day, regime=regime, day_close=d['c'] if valid else None,
            day_high=d['h'] if valid else None, day_low=d['l'] if valid else None,
            day_close_known_at=d['knownAt'] if valid else None,
            raid_candle_high=raid['h'] if raid else None, raid_candle_low=raid['l'] if raid else None,
            raid_candle_close=raid['c'] if raid else None, day_evidence_reason=reason,
            close_known_at_entry=bool(valid and pierced and d['knownAt'] <= row.decision_known_at and d['knownAt'] <= row.entry_at)))
    annotated = frame.merge(pd.DataFrame(evidence), on=['box_id', 'model', 'entry_at'], how='left', validate='many_to_one')
    annotated['closed_before_day_close'] = annotated.exit_at.notna() & (annotated.exit_at <= annotated.day_close_known_at)
    annotated['side'] = annotated.side.map({1: 'BUY', -1: 'SELL'})
    output = ROOT / 'tmp/consolidation-day-close'
    output.mkdir(exist_ok=True)
    annotated.to_csv(output / (sym + '.csv.gz'), index=False, compression='gzip')
    return dict(sym=sym, fingerprint_matches=source_matches, fingerprint=audit['fingerprint'],
        entries=len(annotated), unique_events=len(events), daily_bars=len(daily),
        metrics=metrics(annotated), examples=json.loads(annotated[annotated.regime.eq('PRESSURE_CONTINUES') & annotated.target.eq('2R') & annotated.policy.eq('CLOSE5')].sort_values('entry_at', ascending=False).head(6).to_json(orient='records')))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--symbols', nargs='*')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--assemble', action='store_true', help='Rebuild summary from saved reconciled annotations')
    args = parser.parse_args()
    base = json.loads((ROOT / 'public/reports/consolidation-research-results.json').read_text())
    symbols = args.symbols or base['universe']
    results = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(worker, (sym, base['asof'], args.assemble)) for sym in symbols]
        for job in as_completed(jobs):
            r = job.result()
            results.append(r)
            print(r['sym'], r['entries'], 'source_matches', r['fingerprint_matches'], flush=True)
    combined = pd.DataFrame([m for r in results for m in r['metrics']])
    sums = ['entries', 'scored', 'gross_positive', 'target_hits', 'net_positive', 'total_r', 'total_net_r', 'close_known_at_entry', 'closed_before_day_close']
    combined = combined[combined.regime.ne('ALL')]
    merged = combined.groupby(KEYS)[sums].sum().reset_index()
    baseline = merged.groupby(KEYS[:-1])[sums].sum().reset_index()
    baseline['regime'] = 'ALL'
    merged = pd.concat([merged, baseline], ignore_index=True)
    for name, total in [('avg_r', 'total_r'), ('avg_net_r', 'total_net_r')]:
        merged[name] = merged[total] / merged.scored.replace(0, float('nan'))
    merged['gross_win_pct'] = merged.gross_positive / merged.scored.replace(0, float('nan')) * 100
    merged['net_win_pct'] = merged.net_positive / merged.scored.replace(0, float('nan')) * 100
    unique = []
    for sym in symbols:
        f = pd.read_csv(ROOT / 'tmp/consolidation-day-close' / (sym + '.csv.gz'))
        cols = ['sym', 'box_id', 'box_tf', 'config', 'model', 'side', 'raid_at', 'raid_day', 'entry_at', 'decision_known_at', 'box_hi', 'box_lo', 'day_close', 'day_high', 'day_low', 'day_close_known_at', 'regime', 'close_known_at_entry', 'day_evidence_reason', 'raid_candle_high', 'raid_candle_low', 'raid_candle_close', 'source_fingerprint']
        unique.append(f[cols].drop_duplicates(['sym', 'box_id', 'model', 'entry_at']))
    entries = pd.concat(unique, ignore_index=True)
    entries.to_csv(ROOT / 'public/reports/consolidation-day-close-events.csv.gz', index=False, compression='gzip')
    examples = pd.DataFrame([e for r in results for e in r['examples']])
    examples = examples.sort_values('entry_at', ascending=False).groupby(['box_tf', 'config', 'model', 'side', 'outcome']).head(1)
    example_columns = ['sym', 'box_tf', 'config', 'model', 'target', 'policy', 'side', 'raid_day', 'box_hi', 'box_lo', 'day_close', 'entry_at', 'day_close_known_at', 'close_known_at_entry', 'outcome', 'r']
    report = dict(version=VERSION, generated_at=datetime.now(timezone.utc).isoformat(), asof=base['asof'],
        symbols=symbols, unique_entry_events=len(entries), variants=sum(r['entries'] for r in results),
        source='Audited canonical completed raw 5m ledger; full-hold HARD5/CLOSE5 fade models only',
        rule_lineage='USER_HYPOTHESIS; LOCAL_ADAPTATION',
        rules={'SELL': 'Break above frozen consolidation high; breakout-day Daily close above that high contradicts the SELL fade at day close.',
               'BUY': 'Break below frozen consolidation low; breakout-day Daily close below that low contradicts the BUY fade at day close.',
               'timing': 'Daily close is known only at official session end. Unknown-at-entry labels are retrospective diagnostics, not entry filters or proof that a trade failed.',
               'edge': 'Use the detector tolerance 0.001% of box midpoint; exact/tolerance-edge closes are a separate group.',
               'excluded': 'Expansion-direction model and EOD duplicate exit policies excluded. Prearmed edge touches without a confirmed raw break are unverified.'},
        limitations=['Overlapping variants are not independent portfolio trades.', '5bps round-trip is a friction sensitivity, not observed costs.',
            '2022+ is a descriptive historical split, not a new untouched test.', 'A continuing-pressure close can coexist with an earlier winning trade.',
            'Missing full Daily bars or changed raw source fingerprints are excluded from scored comparisons.',
            'Universe survivorship and corporate-action continuity remain existing research limits.'],
        metrics=json.loads(merged.to_json(orient='records')), sources=[{k:v for k,v in r.items() if k not in ('metrics', 'examples')} for r in sorted(results, key=lambda r:r['sym'])],
        examples=json.loads(examples[example_columns].to_json(orient='records')),
        code_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    path = ROOT / 'public/reports/consolidation-day-close.json'
    path.write_text(json.dumps(report, default=str, separators=(',', ':'), allow_nan=False))
    print('COMPLETE', report['variants'], 'variants;', report['unique_entry_events'], 'entry events', flush=True)


if __name__ == '__main__':
    main()
