"""Compare the AMD chart's actual HTTP output to raw loader candles."""
import sys,json,urllib.request,warnings
from pathlib import Path
import numpy as np,pandas as pd,psycopg2
warnings.filterwarnings('ignore',category=UserWarning)
sys.path.insert(0,str(Path(__file__).parent))
import amd_data as data
import amd_engine as ae

out=Path(__file__).resolve().parents[2]/'reviews'/'amd_causal_v2_2026-10-14'
out.mkdir(parents=True,exist_ok=True)
con=psycopg2.connect(ae.rv.db_uri());con.set_session(readonly=True)
checks=[]
for tf in ['1d','1h','30m']:
    df,_=data.load(con,tf,'2017-01-01')
    for sym,start,end in [('UNH','2023-09-12','2023-09-21'),('MSFT','2025-11-28','2025-11-28')]:
        url=f'http://localhost:3000/api/amd/chart?sym={sym}&tf={tf}&from={start}&to={end}'
        result=json.load(urllib.request.urlopen(url,timeout=60))
        assert result['ok'],result
        expected=df[df.sym.eq(sym)&(df.d>=start)&(df.d<pd.Timestamp(end)+pd.Timedelta(days=1))]
        actual=pd.DataFrame(result['candles'])
        assert len(actual)==len(expected),(tf,sym,len(actual),len(expected))
        keys=expected.d.dt.strftime('%Y-%m-%d' if tf=='1d' else '%Y-%m-%d %H:%M').tolist()
        assert actual.key.tolist()==keys,(tf,sym,'timestamps differ')
        assert np.allclose(actual[['open','high','low','close']].to_numpy(float),expected[list('ohlc')].to_numpy(float),rtol=0,atol=1e-7),(tf,sym,'OHLC mismatch')
        checks.append(dict(tf=tf,sym=sym,start=start,end=end,bars=len(actual),pass_=True))
        print(tf,sym,len(actual),'chart bars match raw replay',flush=True)
(out/'chart_parity_checks.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
con.rollback();con.close()
