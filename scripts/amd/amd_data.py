"""AMD-only raw completed-candle input. Never repairs intraday bars from daily OHLC.

Missing/invalid bars break a symbol's continuity at the next observed bar. Prior
signals survive as open/unresolved at the boundary; no future gap removes them.
"""
from functools import lru_cache
import datetime as dt
import numpy as np
import pandas as pd
import exchange_calendars as xc

VERSION = 'amd_raw_completed_v2'

@lru_cache(maxsize=1)
def schedule():
    cal = xc.get_calendar('XNYS', start='2014-01-01', end='2027-12-31')
    return cal.schedule

@lru_cache(maxsize=3)
def clock(tf):
    out = {}
    for _, row in schedule().iterrows():
        op = row['open'].tz_convert('America/New_York').tz_localize(None)
        cl = row['close'].tz_convert('America/New_York').tz_localize(None)
        if tf == '1d': out[op.normalize()] = cl
        else:
            step = pd.Timedelta(minutes=60 if tf == '1h' else 30)
            for label in pd.date_range(op, cl, freq=step, inclusive='left'):
                out[label] = min(label + step, cl)
    return out

def known_at(label, tf):
    return clock(tf)[pd.Timestamp(label)].tz_localize('America/New_York').tz_convert('UTC').to_pydatetime()

def open_at(label, tf):
    label = pd.Timestamp(label)
    if tf == '1d': label = label + pd.Timedelta(hours=9, minutes=30)
    return label.tz_localize('America/New_York').tz_convert('UTC').to_pydatetime()

def finish(raw, tf, dq):
    """Only self-contained OHLC sanity checks; no completed-day comparisons."""
    raw = raw.copy(); raw['d'] = pd.to_datetime(raw.d)
    original = len(raw)
    valid = raw[list('ohlc')].notna().all(axis=1)
    valid &= (raw[list('ohlc')] > 0).all(axis=1)
    valid &= (raw.h >= raw[['o','c','l']].max(axis=1)) & (raw.l <= raw[['o','c','h']].min(axis=1))
    raw = raw[valid].copy()
    dq.append(f'{tf}: {original-len(raw)} invalid/nonpositive OHLC rows quarantined, never repaired')
    # Conflicting duplicate source rows are quarantined, not selected by hindsight.
    counts = raw.groupby(['sym','d'])[list('ohlc')].nunique()
    conflicts = counts.index[(counts > 1).any(axis=1)]
    if len(conflicts):
        raw = raw[~pd.MultiIndex.from_frame(raw[['sym','d']]).isin(conflicts)]
    raw = raw.drop_duplicates(['sym','d']).sort_values(['sym','d']).reset_index(drop=True)
    dq.append(f'{tf}: {len(conflicts)} conflicting timestamp keys quarantined')
    times = clock(tf)
    raw = raw[raw.d.isin(times)].copy()
    now = dt.datetime.now(dt.timezone.utc)
    completed = {k for k,v in times.items() if v.tz_localize('America/New_York').tz_convert('UTC').to_pydatetime() <= now}
    raw = raw[raw.d.isin(completed)].copy()
    # Existing fail-closed symbol discontinuity guard; never use later data to
    # change an earlier prefix. Corporate actions remain a separate research risk.
    jump = (raw.c / raw.groupby('sym').c.shift(1) - 1).abs() > .6
    for sym, cut in raw[jump].groupby('sym').d.min().items():
        dq.append(f'{sym}: quarantined from {cut} after >60% close jump')
        raw = raw[~((raw.sym == sym) & (raw.d >= cut))]
    positions = {d:i for i,d in enumerate(times)}
    raw['clock_pos'] = raw.d.map(positions)
    delta = raw.groupby('sym').clock_pos.diff()
    raw['segment'] = (delta.ne(1)).groupby(raw.sym).cumsum().astype(int)
    raw['canonical_complete'] = True
    dq.append(f'{tf}: raw source only; no daily clipping or fabricated tails; gaps reset state')
    return raw.reset_index(drop=True)

def load(con, tf, start):
    dq = []
    lf = str((pd.Timestamp(start) - pd.Timedelta(days=550)).date())
    if tf == '1d':
        raw = pd.read_sql_query("""SELECT base_symbol sym, (candle_ts AT TIME ZONE 'America/New_York')::date d,
          open_price o,high_price h,low_price l,close_price c FROM candles_1d WHERE market='us' AND candle_ts >= %s
          UNION ALL SELECT base_symbol,(candle_ts AT TIME ZONE 'America/New_York')::date,
          open_price,high_price,low_price,close_price FROM historical_candles_1d
          WHERE market='us' AND base_symbol IN ('SPY','QQQ') AND candle_ts >= %s""", con,params=(lf,lf))
        return finish(raw,'1d',dq),dq
    raw = pd.read_sql_query("""SELECT base_symbol sym,candle_ts AT TIME ZONE 'America/New_York' d,
      open_price o,high_price h,low_price l,close_price c FROM candles_30m
      WHERE market='us' AND candle_ts >= '2026-01-21'
      UNION ALL SELECT base_symbol,candle_ts AT TIME ZONE 'America/New_York',open_price,high_price,low_price,close_price
      FROM historical_candles_30m WHERE market='us' AND candle_ts >= %s
      AND (base_symbol IN ('SPY','QQQ') OR candle_ts < '2026-01-21')""",con,params=(lf,))
    raw = finish(raw,'30m',dq)
    if tf == '30m': return raw,dq
    # Complete hourly groups only. A missing constituent becomes a gap; an
    # otherwise complete session's final half-hour is a genuine short bar.
    mins = raw.d.dt.hour*60 + raw.d.dt.minute
    raw['bucket'] = raw.d.dt.normalize() + pd.to_timedelta(570 + ((mins-570)//60)*60,unit='m')
    grouped = raw.groupby(['sym','bucket'],sort=True)
    hourly = grouped.agg(o=('o','first'),h=('h','max'),l=('l','min'),c=('c','last'),count=('d','size')).reset_index().rename(columns={'bucket':'d'})
    times = clock('1h')
    hourly['expected'] = hourly.d.map(lambda d: int((times[d]-d).total_seconds()/1800))
    bad = hourly['count'].ne(hourly.expected)
    dq.append(f'1h: {int(bad.sum())} incomplete hourly groups quarantined')
    return finish(hourly[~bad][['sym','d',*'ohlc']],'1h',dq),dq

def groups(df):
    for (sym,_),g in df.groupby(['sym','segment'],sort=True):
        yield sym,g.reset_index(drop=True)
