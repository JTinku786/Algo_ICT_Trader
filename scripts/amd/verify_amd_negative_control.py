"""Prove the new validator rejects a future confirmation (in memory only)."""
import sys,json,warnings
from pathlib import Path
import pandas as pd,psycopg2
warnings.filterwarnings('ignore',category=UserWarning)
sys.path.insert(0,str(Path(__file__).parent))
import amd_engine as ae
import amd_data as data
from amd_validation import validate
con=psycopg2.connect(ae.rv.db_uri());con.set_session(readonly=True)
T=pd.read_sql_query("""select t.* from amd_trades t join amd_runs r using(run_id)
 where r.params->>'spec_version'='amd-local-v2.1' and r.timeframe='1d' and t.model='MSS_FVG'
 order by r.created_at desc,t.trade_id limit 1""",con)
assert len(T)==1
C=pd.read_sql_query('select * from amd_cycles where run_id=%s and cycle_id=%s',con,params=(T.run_id.iloc[0],T.cycle_id.iloc[0]))
raw,_=data.load(con,'1d','2017-01-01')
original=validate(C,T,raw,'1d');assert not original['failures'],original['failures']
bad=T.copy();bad.loc[0,'mss_known_at']=pd.Timestamp(bad.entry_not_before.iloc[0])+pd.Timedelta(days=1)
rejected=validate(C,bad,raw,'1d')
assert any('MSS complete before decision and fill' in s for s in rejected['failures']),rejected
out=Path(__file__).resolve().parents[2]/'reviews'/'amd_causal_v2_2026-10-14'/'negative_control.json'
out.write_text(json.dumps(dict(run_id=T.run_id.iloc[0],trade_id=T.trade_id.iloc[0],original_passes=True,artificial_future_mss_rejected=True,failures=rejected['failures'],database_writes=False),indent=2),encoding='utf-8')
print('PASS: genuine stored row passes; artificial future MSS is rejected; database remains read-only',flush=True)
con.rollback();con.close()
