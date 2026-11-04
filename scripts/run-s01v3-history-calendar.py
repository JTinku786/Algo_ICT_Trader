"""Historical S01 V3 runner: unchanged signals, exchange-scheduled session closes.

Adds this adapter and installed calendar version to the run code manifest.
Never publishes automatically; retains the existing published 2026 cohort.
"""
import sys
from pathlib import Path
from datetime import time
import exchange_calendars as xc
import pandas as pd
sys.path.insert(0,r'C:/Users/saite/Desktop/ICT_Automation/Backtesting_ICT_2017')
import run_s01v3_backtest_updated as runner
from s16v2 import bars as B
original_calendar=runner.build_calendar
original_files=runner.code_files
def historical_calendar(conn,market):
 cal=original_calendar(conn,market)
 if market!='us':return cal
 exchange=xc.get_calendar('XNYS',start=str(cal.sessions[0]),end=str(cal.sessions[-1]))
 schedule=exchange.schedule
 sessions=[d for d in cal.sessions if pd.Timestamp(d) in schedule.index]
 half={d for d in sessions if schedule.loc[pd.Timestamp(d),'close'].tz_convert(cal.tz).time()<time(16)}
 corrected=B.Calendar(tz=cal.tz,sessions=sessions,open_t=cal.open_t,close_t=cal.close_t,half_days=half,grid=cal.grid)
 for d in sessions:
  assert corrected.close_ts[corrected.idx[d]]==schedule.loc[pd.Timestamp(d),'close'].tz_convert(cal.tz)
 print(f'[calendar] XNYS exchange_calendars {xc.__version__}: {len(half)} scheduled early closes; no gap tolerance',flush=True)
 return corrected
runner.build_calendar=historical_calendar
runner.code_files=lambda:original_files()+[Path(__file__).resolve(),Path(xc.__file__).resolve()]
if __name__=='__main__':runner.main()
