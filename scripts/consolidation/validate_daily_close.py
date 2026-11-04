"""Independent classification, timing, aggregate and sampled raw Daily OHLC checks."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path.home() / 'Desktop/ICT_Automation/realtime_execution'))
from mss_reversal_data import connect
from reversal_candle_source import load_candles, session_bounds, ZONE


def main():
    report = json.loads((ROOT / 'public/reports/consolidation-day-close.json').read_text())
    events = pd.read_csv(ROOT / 'public/reports/consolidation-day-close-events.csv.gz')
    assert len(events) == report['unique_entry_events']
    assert not events.duplicated(['sym', 'box_id', 'model', 'entry_at']).any()
    verified = events.regime.ne('UNVERIFIED_DAY')
    e = events[verified]
    tol = (e.box_hi + e.box_lo) * .5e-5
    above = e.day_close > e.box_hi + tol
    below = e.day_close < e.box_lo - tol
    edge = (abs(e.day_close - e.box_hi) <= tol) | (abs(e.day_close - e.box_lo) <= tol)
    continues = (above & e.side.eq('SELL')) | (below & e.side.eq('BUY'))
    opposite = (above & e.side.eq('BUY')) | (below & e.side.eq('SELL'))
    expected = np.select([continues, opposite, edge], ['PRESSURE_CONTINUES', 'THROUGH_OPPOSITE_EDGE', 'AT_EDGE'], 'INSIDE_RANGE')
    assert (e.regime.to_numpy() == expected).all()
    raid_days = pd.to_datetime(e.raid_at - 1, unit='ms', utc=True).dt.tz_convert(ZONE).dt.strftime('%Y-%m-%d')
    assert (raid_days == e.raid_day).all()
    known = (e.day_close_known_at <= e.decision_known_at) & (e.day_close_known_at <= e.entry_at)
    assert (e.close_known_at_entry == known).all()
    assert (~events.loc[~verified, 'close_known_at_entry']).all()
    bounds = session_bounds('us', datetime(2015, 7, 1).date(), datetime.fromisoformat(report['asof']).astimezone(ZONE).date())
    assert all(int(row.day_close_known_at) == bounds[row.raid_day][1] for row in e[['raid_day', 'day_close_known_at']].drop_duplicates().itertuples())

    # Reconcile every selected aggregate against saved variants without using the producer's metrics function.
    dims = ['box_tf', 'config', 'model', 'target', 'policy', 'side', 'period', 'regime']
    partial = []
    cols = ['box_tf', 'config', 'model', 'target', 'policy', 'side', 'year', 'regime', 'outcome', 'r', 'net_5bps_r', 'close_known_at_entry', 'closed_before_day_close']
    for sym in report['symbols']:
        df = pd.read_csv(ROOT / 'tmp/consolidation-day-close' / (sym + '.csv.gz'), usecols=cols)
        df['scored'] = df.outcome.isin(['win', 'loss', 'time_exit']) & df.r.notna() & df.regime.ne('UNVERIFIED_DAY')
        df['r_sum'] = df.r.where(df.scored, 0)
        df['net_sum'] = df.net_5bps_r.where(df.scored, 0)
        df['positive'] = df.scored & (df.r > 0)
        df['entries'] = 1
        df['closed_at_day'] = df.scored & df.closed_before_day_close
        for side in ('ALL', 'BUY', 'SELL'):
            sd = df if side == 'ALL' else df[df.side.eq(side)]
            for period in ('ALL', '2022_PLUS'):
                selected = (sd if period == 'ALL' else sd[sd.year >= 2022]).copy()
                selected['side'] = side
                selected['period'] = period
                fields = ['entries', 'scored', 'r_sum', 'net_sum', 'positive', 'close_known_at_entry', 'closed_at_day']
                grouped = selected.groupby(dims)[fields].sum().reset_index()
                baseline = grouped.groupby(dims[:-1])[fields].sum().reset_index()
                baseline['regime'] = 'ALL'
                partial.extend([grouped, baseline])
    sums = pd.concat(partial).groupby(dims).sum()
    for metric in report['metrics']:
        actual = sums.loc[tuple(metric[k] for k in dims)]
        assert int(actual.entries) == metric['entries']
        assert int(actual.scored) == metric['scored']
        assert int(actual.positive) == metric['gross_positive']
        assert int(actual.close_known_at_entry) == metric['close_known_at_entry']
        assert int(actual.closed_at_day) == metric['closed_before_day_close']
        assert abs(actual.r_sum - metric['total_r']) < 1e-7
        assert abs(actual.net_sum - metric['total_net_r']) < 1e-7

    sample = e[e.model.isin(['RAID_FADE', 'RECLAIM_FADE']) & e.box_tf.eq('1d') & e.config.eq('tight')]
    sample = sample.sort_values('entry_at', ascending=False).groupby(['side', 'regime']).head(3)
    checked = []
    with connect() as con:
        for row in sample.itertuples():
            start = datetime.fromisoformat(row.raid_day).replace(tzinfo=ZONE)
            finish = datetime.fromtimestamp(row.day_close_known_at / 1000, timezone.utc)
            bars, audit = load_candles(con, 'us', row.sym, start, finish)
            begin, end = bounds[row.raid_day]
            expected_ts = list(range(begin, end, 300000))
            assert [b['t'] for b in bars] == expected_ts
            assert abs(bars[-1]['c'] - row.day_close) < 1e-7
            assert abs(max(b['h'] for b in bars) - row.day_high) < 1e-7
            assert abs(min(b['l'] for b in bars) - row.day_low) < 1e-7
            assert bars[-1]['knownAt'] == row.day_close_known_at
            checked.append(dict(sym=row.sym, raid_day=row.raid_day, side=row.side, regime=row.regime,
                box_hi=row.box_hi, box_lo=row.box_lo, raw_daily_close=row.day_close, raw_constituents=len(bars)))
    result = dict(verdict='PASS', distinct_entry_events=len(events), verified_daily_events=len(e),
        missing_or_unverified_daily_events=int((~verified).sum()), metric_cells_checked=len(report['metrics']),
        independent_raw_daily_samples=checked, validated_at=datetime.now(timezone.utc).isoformat())
    (ROOT / 'public/reports/consolidation-day-close-validation.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k:v for k,v in result.items() if k != 'independent_raw_daily_samples'}))
    print('Raw Daily samples:', len(checked))


if __name__ == '__main__':
    main()
