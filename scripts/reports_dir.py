"""Single source of truth for where report/backtest output lives.

Order: REPORTS_DIR env var -> REPORTS_DIR in .env.local -> <repo>/public/reports.
"""
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _from_env_file():
    env = REPO / '.env.local'
    if not env.exists():
        return None
    for line in env.read_text(encoding='utf-8', errors='ignore').splitlines():
        line = line.strip()
        if line.startswith('REPORTS_DIR='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    return None


REPORTS = Path(os.environ.get('REPORTS_DIR') or _from_env_file() or (REPO / 'public' / 'reports'))
SCALPING_BACKTEST = REPORTS / 'scalping-labs' / 'backtest'
