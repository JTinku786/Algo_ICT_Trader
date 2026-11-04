import errno,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from scalping_backtest_runner import replace_atomic,json_write
class AtomicTests(unittest.TestCase):
    def test_temporary_sharing_denial_retries_atomic_replace(self):
        source=Path('source');destination=Path('destination')
        with patch.object(Path,'replace',side_effect=[PermissionError('locked'),OSError(None,'Access is denied'),destination]) as replace,patch('scalping_backtest_runner.time.sleep') as sleep:
            self.assertEqual(replace_atomic(source,destination),destination);self.assertEqual(replace.call_count,3);self.assertEqual([x.args[0] for x in sleep.call_args_list],[.05,.1])
    def test_real_missing_file_does_not_retry(self):
        with patch.object(Path,'replace',side_effect=FileNotFoundError(errno.ENOENT,'missing')) as replace,patch('scalping_backtest_runner.time.sleep') as sleep:
            with self.assertRaises(FileNotFoundError):replace_atomic(Path('source'),Path('destination'))
            self.assertEqual(replace.call_count,1);sleep.assert_not_called()
    def test_retry_is_bounded(self):
        with patch.object(Path,'replace',side_effect=PermissionError('locked')) as replace,patch('scalping_backtest_runner.time.sleep'):
            with self.assertRaises(PermissionError):replace_atomic(Path('source'),Path('destination'),attempts=3)
            self.assertEqual(replace.call_count,3)
    def test_unique_temp_publication_complete_and_clean(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'status.json';json_write(p,{'old':1});json_write(p,{'new':2});self.assertEqual(json.loads(p.read_text()),{'new':2});self.assertEqual(list(Path(folder).iterdir()),[p])
if __name__=='__main__':unittest.main()
