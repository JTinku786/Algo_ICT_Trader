"""Independent invariants/oracle for the Scalping Labs historical batch.

Research only. Matches the dashboard's completed-OHLC exit contract: entry candle
is excluded, stop wins an ambiguous later candle, unresolved trades remain OPEN.
This oracle never forces an end-date exit or fabricates a target.
"""
import math
import unittest

BUCKETS = ('0-1', '1-2', '2-3', '3-4', '4+')


def bucket_contains(rr, bucket):
    if not math.isfinite(rr) or rr <= 0:
        return False
    if bucket == '4+':
        return rr >= 4
    low, high = map(float, bucket.split('-'))
    return low <= rr < high


def select_target(plan, bucket):
    """Closest causal existing liquidity inside one independent bucket scenario."""
    sign = 1 if plan['direction'] == 'BUY' else -1
    risk = sign * (plan['entry'] - plan['stop'])
    if risk <= 0:
        return None
    candidates = []
    for source in plan.get('targetCandidates', []):
        rr = sign * (source['low'] - plan['entry']) / risk
        if bucket_contains(rr, bucket):
            candidates.append((rr, source))
    if not candidates:
        return None
    rr, source = min(candidates, key=lambda item: item[0])
    return {**plan, 'target': source['low'], 'targetSource': source, 'rr': rr}


def until_hit(plan, bars):
    """All available subsequent candles, without an artificial holding cutoff."""
    sign = 1 if plan['direction'] == 'BUY' else -1
    risk = sign * (plan['entry'] - plan['stop'])
    if risk <= 0:
        raise ValueError('Invalid signed stop geometry')
    hold_bars = 0
    for bar in bars:
        if bar['t'] <= plan['entryAt']:
            continue
        hold_bars += 1
        stopped = bar['l'] <= plan['stop'] if sign == 1 else bar['h'] >= plan['stop']
        targeted = bar['h'] >= plan['target'] if sign == 1 else bar['l'] <= plan['target']
        if stopped or targeted:
            return {'outcome': 'LOSS' if stopped else 'WIN',
                    'r': -1.0 if stopped else sign * (plan['target'] - plan['entry']) / risk,
                    'exitAt': bar['t'], 'exitKnownAt': bar['knownAt'],
                    'ambiguous': stopped and targeted, 'holdBars': hold_bars}
    return {'outcome': 'OPEN', 'r': None, 'exitAt': None, 'exitKnownAt': None, 'ambiguous': False, 'holdBars': None}


def evaluate_trade(entry, plan, bars):
    """Runner convenience contract, accepts full independent-bucket plan."""
    result = until_hit({**plan, 'entryAt': entry['at']}, bars)
    return {**result, 'result': result['outcome']}


def economic_identity(symbol, entry, direction, target=None):
    """Context/confirmation labels are attribution, not extra portfolio fills."""
    plan = entry['plan']
    return (symbol, direction, entry['at'], entry['price'], plan['stop'],
            plan['target'] if target is None else target)


def audit_candidate(investigation, candidate):
    """Return explicit violations; accepted candidates must satisfy all invariants."""
    entry = candidate.get('entry')
    if entry is None:
        return []
    event, context, array = investigation['mss'], investigation['htf'], candidate['zone']
    violations = []
    for name, clock in [('context', context['knownAt']), ('shift', event['knownAt']),
                        ('array', array['knownAt'])]:
        if clock > entry['at']:
            violations.append(name + '_after_entry')
    if context['kind'] not in {'BSL','SSL','EQH','EQL'} and context.get('retiredAt') is not None and context['retiredAt']<=entry['at']:
        violations.append('retired_tf1_context_at_entry')
    if context.get('sessionDay') is not None and context['sessionDay']!=entry['candle']['day']:
        violations.append('previous_day_context_wrong_session')
    if array.get('retiredAt') is not None and array['retiredAt']<=entry['at']:
        violations.append('retired_tf2_array_at_entry')
    if entry['knownAt'] <= entry['at']:
        violations.append('invalid_completed_entry_clock')
    evidence = entry.get('strategy_json', {})
    freshness = evidence.get('tf1TouchFreshness')
    if not freshness or not freshness.get('valid'):
        violations.append('missing_or_failed_tf1_freshness')
    else:
        for phase in ['shift', 'entry']:
            proof = freshness[phase]
            if not proof.get('valid') or proof['touchAt'] < proof['windowStart']:
                violations.append(phase + '_expired_touch')
            cutoff = event['knownAt'] if phase == 'shift' else min(entry['at'], event['knownAt'])
            if proof['touchKnownAt'] > cutoff:
                violations.append(phase + '_future_touch')
    plan = entry['plan']
    sign = 1 if event['direction'] == 'BUY' else -1
    if sign * (entry['price'] - plan['stop']) <= 0:
        violations.append('invalid_stop')
    for source in plan.get('targetCandidates', []):
        if source.get('knownAt', math.inf) > entry['at']:
            violations.append('future_target')
        if sign * (source['low'] - entry['price']) <= 0:
            violations.append('wrong_side_target')
    for proof in evidence.get('validFvg', {}).values():
        if not proof.get('valid') or proof.get('range', {}).get('knownAt', math.inf) > entry['at']:
            violations.append('invalid_or_future_fib_range')
    return sorted(set(violations))


class BacktestOracleTests(unittest.TestCase):
    def test_five_bucket_boundaries_and_nearest_within_each(self):
        p = {'direction': 'BUY', 'entry': 10, 'stop': 9,
             'targetCandidates': [{'low': 10 + r, 'knownAt': 1} for r in [.42, 1, 1.8, 2, 3, 4, 5]]}
        for actual, expected in zip([select_target(p, b)['rr'] for b in BUCKETS], [.42, 1, 2, 3, 4]):
            self.assertAlmostEqual(actual, expected)
        self.assertFalse(bucket_contains(1, '0-1'))
        self.assertFalse(bucket_contains(0, '0-1'))

    def test_sell_targets_and_fixed_stop(self):
        p = {'direction': 'SELL', 'entry': 10, 'stop': 11,
             'targetCandidates': [{'low': 8.6}, {'low': 8.9}, {'low': 7}]}
        result = select_target(p, '1-2')
        self.assertAlmostEqual(result['target'], 8.9)
        self.assertEqual(result['stop'], 11)
        self.assertIsNone(select_target(p, '4+'))

    def test_until_hit_continues_after_signal_window(self):
        p = {'direction': 'BUY', 'entryAt': 0, 'entry': 10, 'stop': 9, 'target': 12}
        bars = [{'t': t, 'knownAt': t + 1, 'l': 9.1, 'h': 10.5} for t in range(1, 2000)]
        bars.append({'t': 2000, 'knownAt': 2001, 'l': 10, 'h': 12})
        self.assertEqual(until_hit(p, bars)['exitAt'], 2000)

    def test_entry_bar_excluded_and_ambiguous_later_bar_stop_first(self):
        p = {'direction': 'BUY', 'entryAt': 1, 'entry': 10, 'stop': 9, 'target': 12}
        bars = [{'t': t, 'knownAt': t + 1, 'l': 8, 'h': 13} for t in [1, 2]]
        result = until_hit(p, bars)
        self.assertEqual((result['outcome'], result['r'], result['exitAt']), ('LOSS', -1, 2))
        self.assertTrue(result['ambiguous'])

    def test_unresolved_stays_open_without_end_mark(self):
        p = {'direction': 'SELL', 'entryAt': 1, 'entry': 10, 'stop': 11, 'target': 8}
        result = until_hit(p, [{'t': 2, 'knownAt': 3, 'l': 9, 'h': 10.5}])
        self.assertEqual((result['outcome'], result['r'], result['exitAt']), ('OPEN', None, None))

    def test_context_duplicates_have_one_economic_identity(self):
        e = {'at': 100, 'price': 10, 'plan': {'stop': 9, 'target': 12}}
        self.assertEqual(economic_identity('AAPL', e, 'BUY'), economic_identity('AAPL', {**e, 'contextId': 'another'}, 'BUY'))
        self.assertNotEqual(economic_identity('AAPL', e, 'BUY'), economic_identity('AAPL', e, 'SELL'))


if __name__ == '__main__':
    unittest.main()
