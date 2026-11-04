"""Export / profile a bounded detector input; never execute orders."""
import sys as _rs, os as _ro; _rs.path.insert(0, _ro.path.dirname(_ro.path.abspath(__file__))); from reports_dir import REPORTS, SCALPING_BACKTEST  # noqa: E402
import json,bisect,argparse,cProfile
from pathlib import Path
from scalping_backtest_data import connect,load,hourly,merge_hourly
from scalping_backtest_runner import freeze_config
import scalping_labs_updated as engine
from datetime import date,timedelta

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--market',default='forex');ap.add_argument('--symbol',default='^EURUSD');ap.add_argument('--start',default='2026-04-14');ap.add_argument('--end',default='2026-04-20');ap.add_argument('--profile',action='store_true');args=ap.parse_args()
    conn=connect();warm=(date.fromisoformat(args.start)-timedelta(days=30)).isoformat()
    low,_=load(conn,args.market,args.symbol,'5m',warm,args.end);hi,_=load(conn,args.market,args.symbol,'1h',warm,args.end) if args.market=='forex' else (hourly(low),None);daily,_=load(conn,args.market,args.symbol,'1d','2024-01-01',args.end);conn.close()
    if args.market=='forex':hi,_=merge_hourly(hi,low,args.market)
    index=next(i for i,b in enumerate(low) if b['day']>=args.start)
    data={**freeze_config(args.market,args.symbol,args.start,args.end),'lower':low[max(0,index-250):],'higher':hi[-600:],'daily':daily}
    folder=SCALPING_BACKTEST;folder.mkdir(parents=True,exist_ok=True);path=folder/f'pilot-{args.symbol.replace("^","")}.json';path.write_text(json.dumps(data),encoding='utf-8');print(str(path),flush=True)
    if args.profile:
        p=cProfile.Profile();result=p.runcall(engine.run,data);p.dump_stats(str(path.with_suffix('.prof')));print(len(result['investigations']))
