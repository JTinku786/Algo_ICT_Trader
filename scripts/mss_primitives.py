"""Array execution of smartmoneyconcepts 0.0.24 primitives.

Same prefix inputs, float32 levels, comparisons and mutation order as the package.
No full-history inference or future swings. Parity tests compare every output column.
Adapted from smartmoneyconcepts (MIT; see smartmoneyconcepts-LICENSE.txt).
"""
import numpy as np
import pandas as pd
from numba import njit


@njit(cache=True)
def _liquidity(high, low, signs, levels, range_percent):
    signs = signs.copy()
    n = len(high)
    result = np.zeros(n, np.int32)
    level = np.zeros(n, np.float32)
    ends = np.zeros(n, np.int32)
    swept = np.zeros(n, np.int32)
    span = (np.max(high) - np.min(low)) * range_percent
    for side in (1, -1):
        for i in range(n):
            if signs[i] != side:
                continue
            lo, hi = levels[i] - span, levels[i] + span
            total, count, end, broken = levels[i], 1, i, 0
            for c in range(i + 1, n):
                if signs[c] == side and lo <= levels[c] <= hi:
                    total += levels[c]
                    count += 1
                    end = c
                    signs[c] = 0
                if (side == 1 and high[c] >= hi) or (side == -1 and low[c] <= lo):
                    broken = c
                    break
            if count > 1:
                result[i], level[i], ends[i], swept[i] = side, total / count, end, broken
    return result, level, ends, swept


@njit(cache=True)
def _structure(upper, lower, signs, levels):
    n = len(upper)
    bos, choch = np.zeros(n, np.int32), np.zeros(n, np.int32)
    level = np.zeros(n, np.float32)
    broken = np.zeros(n, np.int32)
    positions = np.flatnonzero(~np.isnan(signs))
    for k in range(3, len(positions)):
        a, b, c, d = positions[k-3], positions[k-2], positions[k-1], positions[k]
        j = b  # package last_positions[-2], before appending the fourth swing
        up = signs[a] == -1 and signs[b] == 1 and signs[c] == -1 and signs[d] == 1
        down = signs[a] == 1 and signs[b] == -1 and signs[c] == 1 and signs[d] == -1
        if up and levels[a] < levels[c] < levels[b] < levels[d]:
            bos[j] = 1
        elif down and levels[a] > levels[c] > levels[b] > levels[d]:
            bos[j] = -1
        if up and levels[d] > levels[b] > levels[a] > levels[c]:
            choch[j] = 1
        elif down and levels[d] < levels[b] < levels[a] < levels[c]:
            choch[j] = -1
        if bos[j] or choch[j]:
            level[j] = levels[b]
    for i in range(n):
        if not (bos[i] or choch[i]):
            continue
        side = 1 if bos[i] == 1 or choch[i] == 1 else -1
        for j in range(i+2, n):
            if (side == 1 and upper[j] > level[i]) or (side == -1 and lower[j] < level[i]):
                broken[i] = j
                for k in range(i):
                    if (bos[k] or choch[k]) and broken[k] >= j:
                        bos[k] = choch[k] = 0
                        level[k] = 0
                break
    for i in range(n):
        if (bos[i] or choch[i]) and broken[i] == 0:
            bos[i] = choch[i] = 0
            level[i] = 0
    return bos, choch, level, broken


@njit(cache=True)
def _ob(open_, high, low, close, volume, signs):
    n = len(close)
    crossed, breaker = np.zeros(n, np.bool_), np.zeros(n, np.bool_)
    ob = np.zeros(n, np.int32)
    top, bottom, vol = np.zeros(n, np.float32), np.zeros(n, np.float32), np.zeros(n, np.float32)
    low_vol, high_vol = np.zeros(n, np.float32), np.zeros(n, np.float32)
    percentage, mitigated = np.zeros(n, np.int32), np.zeros(n, np.int32)
    for side in (1, -1):
        last_swing = -1
        origins = []
        recorded = np.zeros(n, np.bool_)
        for i in range(n):
            # The package considers only swings strictly before the current candle.
            if i > 0 and signs[i-1] == side:
                last_swing = i-1
            # Each update mutates only its own OB slot. Visiting existing slots
            # avoids scanning all candles for the mostly-empty package OB array.
            for position in range(len(origins)-1, -1, -1):
                j = origins[position]
                if ob[j] != side:
                    continue
                if breaker[j]:
                    if (side == 1 and high[i] > top[j]) or (side == -1 and low[i] < bottom[j]):
                        ob[j] = 0
                        top[j] = bottom[j] = vol[j] = low_vol[j] = high_vol[j] = 0
                        mitigated[j] = percentage[j] = 0
                elif (side == 1 and min(open_[i], close[i]) < bottom[j]) or (side == -1 and max(open_[i], close[i]) > top[j]):
                    breaker[j] = True
                    mitigated[j] = i-1 if side == 1 else i
            if last_swing < 0 or crossed[last_swing]:
                continue
            if not ((side == 1 and close[i] > high[last_swing]) or (side == -1 and close[i] < low[last_swing])):
                continue
            crossed[last_swing] = True
            lo = high[i-1] if side == 1 else low[i-1]
            hi = low[i-1] if side == 1 else high[i-1]
            origin = i-1
            for j in range(last_swing+1, i):
                if side == 1:
                    lo = min(low[j], lo)
                    if lo == low[j]:
                        hi, origin = high[j], j
                else:
                    hi = max(high[j], hi)
                    if hi == high[j]:
                        lo, origin = low[j], j
            ob[origin], top[origin], bottom[origin] = side, hi, lo
            if not recorded[origin]:
                origins.append(origin)
                recorded[origin] = True
            vol[origin] = volume[i] + volume[i-1] + volume[i-2]
            low_vol[origin] = volume[i-2] if side == 1 else volume[i] + volume[i-1]
            high_vol[origin] = volume[i] + volume[i-1] if side == 1 else volume[i-2]
            maximum = max(high_vol[origin], low_vol[origin])
            # Preserve the package's float32 arithmetic before int truncation.
            ratio = np.float32(min(high_vol[origin], low_vol[origin]) / maximum) if maximum != 0 else np.float32(1)
            percentage[origin] = ratio * 100.0
    return ob, top, bottom, vol, mitigated, percentage


def liquidity(ohlc, swings, range_percent=0.01):
    values = _liquidity(ohlc.high.to_numpy(), ohlc.low.to_numpy(), swings.HighLow.to_numpy(), swings.Level.to_numpy(), range_percent)
    mask = values[0] != 0
    return pd.DataFrame({k: np.where(mask, v, np.nan) for k, v in zip(('Liquidity', 'Level', 'End', 'Swept'), values)})


def bos_choch(ohlc, swings, close_break=True):
    values = _structure(ohlc['close' if close_break else 'high'].to_numpy(), ohlc['close' if close_break else 'low'].to_numpy(), swings.HighLow.to_numpy(), swings.Level.to_numpy())
    return pd.DataFrame({k: np.where(v != 0, v, np.nan) for k, v in zip(('BOS', 'CHOCH', 'Level', 'BrokenIndex'), values)})


def ob(ohlc, swings, close_mitigation=True):
    if not close_mitigation:
        raise ValueError('MSS uses close_mitigation=True only')
    values = _ob(*(ohlc[k].to_numpy() for k in ('open', 'high', 'low', 'close', 'volume')), swings.HighLow.to_numpy())
    mask = values[0] != 0
    return pd.DataFrame({k: np.where(mask, v, np.nan) for k, v in zip(('OB', 'Top', 'Bottom', 'OBVolume', 'MitigatedIndex', 'Percentage'), values)})
