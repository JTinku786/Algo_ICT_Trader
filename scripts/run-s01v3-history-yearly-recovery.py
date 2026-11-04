"""Generate disjoint annual cohorts for symbols excluded from the full-span run.
Same strategy, zero missing-bar tolerance, eight workers per sequential cohort.
Does not publish or replace existing cohorts.
"""
import sys,json,subprocess,time
from pathlib import Path
sys.path.insert(0,r'C:/Users/saite/Desktop/ICT_Automation/Backtesting_ICT_2017')
from db import connect
FULL='s01v3-us-2018-01-16-2025-12-31-10608eb5-37ff0e6c-c52b799c'
ROOT=Path(__file__).resolve().parents[1]
def main():
 while True:
  with connect() as c,c.cursor() as q:
   q.execute('select status,excluded from s01v3_runs where run_id=%s',(FULL,));status,excluded=q.fetchone()
  if status=='complete':break
  if status!='running':raise SystemExit(f'Full-span run stopped: {status}')
  time.sleep(15)
 symbols=sorted(s for s in excluded if not s.startswith('_'))
 for year in range(2018,2026):
  start='2018-01-16' if year==2018 else f'{year}-01-01'
  args=[sys.executable,str(ROOT/'scripts/run-s01v3-history-calendar.py'),'--market','us','--start',start,'--end',f'{year}-12-31','--symbols',','.join(symbols),'--workers','8','--allow-dirty-code']
  print(f'YEAR {year}: {len(symbols)} remaining symbols',flush=True)
  with (ROOT/f'tmp/s01v3-history-{year}.log').open('w',encoding='utf-8') as f:
   result=subprocess.run(args,cwd=ROOT,stdout=f,stderr=subprocess.STDOUT)
  print(f'YEAR {year}: exit {result.returncode}; log tmp/s01v3-history-{year}.log',flush=True)
  if result.returncode: print((ROOT/f'tmp/s01v3-history-{year}.log').read_text()[-1500:],flush=True)
 subprocess.run([sys.executable,str(ROOT/'scripts/export-s01v3-history.py')],cwd=ROOT,check=True)
if __name__=='__main__':main()
