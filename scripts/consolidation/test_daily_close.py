import unittest
import pandas as pd
from analyze_daily_close import classify_close, metrics


class DailyCloseContracts(unittest.TestCase):
    def test_sell_close_above_range_contradicts_fade(self):
        self.assertEqual(classify_close(111, 110, 100, -1), 'PRESSURE_CONTINUES')

    def test_buy_close_below_range_contradicts_fade(self):
        self.assertEqual(classify_close(99, 110, 100, 1), 'PRESSURE_CONTINUES')

    def test_opposite_edge_is_reversal_not_continuation(self):
        self.assertEqual(classify_close(99, 110, 100, -1), 'THROUGH_OPPOSITE_EDGE')
        self.assertEqual(classify_close(111, 110, 100, 1), 'THROUGH_OPPOSITE_EDGE')

    def test_equal_and_float_noise_are_separate(self):
        self.assertEqual(classify_close(110, 110, 100, -1), 'AT_EDGE')
        self.assertEqual(classify_close(110.00005, 110, 100, -1), 'AT_EDGE')

    def test_inside_is_neither_proof_of_win_nor_invalidation(self):
        self.assertEqual(classify_close(105, 110, 100, -1), 'INSIDE_RANGE')
        self.assertEqual(classify_close(105, 110, 100, 1), 'INSIDE_RANGE')

    def test_invalid_box_rejected(self):
        with self.assertRaises(ValueError):
            classify_close(100, 100, 110, -1)

    def test_unverified_daily_evidence_never_enters_baseline_r(self):
        common = dict(box_tf='1h', config='tight', model='RAID_FADE', target='2R', policy='CLOSE5', side='SELL', year=2025, entry_at=0, outcome='win', close_known_at_entry=False, closed_before_day_close=True)
        frame = pd.DataFrame([{**common, 'regime': 'PRESSURE_CONTINUES', 'r': 2, 'net_5bps_r': 1.8}, {**common, 'regime': 'UNVERIFIED_DAY', 'r': 100, 'net_5bps_r': 99.8}])
        row = next(r for r in metrics(frame) if r['regime'] == 'ALL' and r['side'] == 'ALL' and r['period'] == 'ALL')
        self.assertEqual(row['entries'], 2)
        self.assertEqual(row['scored'], 1)
        self.assertEqual(row['total_r'], 2)
        self.assertEqual(row['close_known_at_entry'], 0)


if __name__ == '__main__':
    unittest.main()
