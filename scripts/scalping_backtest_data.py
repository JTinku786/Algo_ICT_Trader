"""Read-only candle inventory / export matching the website archive source priority."""
import os,json,math
from pathlib import Path
from datetime import datetime,timedelta,timezone
from zoneinfo import ZoneInfo
import psycopg2

ROOT=Path(__file__).resolve().parents[1]
def connect():
    for line in (ROOT/'.env.local').read_text(encoding='utf-8').splitlines():
        if line and not line.lstrip().startswith('#') and '=' in line:
            k,v=line.split('=',1);os.environ.setdefault(k,v.strip().strip('"').strip("'"))
    url=os.environ.get('DATABASE_URL') or os.environ.get('POSTGRES_URL')
    conn=psycopg2.connect(url) if url else psycopg2.connect(host=os.environ['POSTGRES_HOST'],dbname=os.environ['POSTGRES_DATABASE'],user=os.environ['POSTGRES_USER'],password=os.environ['POSTGRES_PASSWORD'],port=os.environ.get('POSTGRES_PORT',5432),sslmode=os.environ.get('POSTGRES_SSLMODE','prefer'))
    conn.set_session(readonly=True,autocommit=True)
    return conn

def inventory(conn):
    rows=[]
    with conn.cursor() as cur:
        for table in ['historical_candles_5m','candles_5m','historical_candles_1h','historical_candles_1d','candles_1d']:
            cur.execute(f"SELECT market,yahoo_symbol,count(*),min(candle_ts),max(candle_ts),array_agg(DISTINCT source) FROM {table} WHERE market IN ('us','forex') GROUP BY market,yahoo_symbol ORDER BY market,yahoo_symbol")
            rows.extend({'table':table,'market':r[0],'symbol':r[1],'count':r[2],'first':r[3].isoformat(),'last':r[4].isoformat(),'sources':r[5]} for r in cur.fetchall())
    return rows

def load(conn,market,symbol,tf,start,end,cutoff_ms=None):
    zone=ZoneInfo('America/New_York')
    start_ts=datetime.fromisoformat(start).replace(tzinfo=zone);end_ts=(datetime.fromisoformat(end)+timedelta(days=1)).replace(tzinfo=zone)
    if market=='us' and tf!='1d':
        source="""(SELECT * FROM (SELECT raw.*,min(priority) OVER(PARTITION BY candle_ts) AS chosen FROM (
          SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,0 priority FROM historical_candles_5m WHERE market=%s AND yahoo_symbol=%s AND source='barchart' AND candle_ts>=%s AND candle_ts<%s
          UNION ALL SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,1 FROM candles_5m WHERE market=%s AND yahoo_symbol=%s AND candle_ts>=%s AND candle_ts<%s
          UNION ALL SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,2 FROM realtime_production_mss_reversal_candles WHERE market=%s AND ticker=%s AND candle_ts>=%s AND candle_ts<%s AND candle_ts+interval '5 minutes'<=now()
        ) raw) ranked WHERE priority=chosen) candles"""
        args=(market,symbol,start_ts,end_ts)*3
    elif market=='us' and tf=='1d':
        source="""(SELECT * FROM (SELECT raw.*,min(priority) OVER(PARTITION BY (candle_ts AT TIME ZONE 'America/New_York')::date) AS chosen FROM (
          SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,0 priority FROM candles_1d WHERE market=%s AND yahoo_symbol=%s AND candle_ts>=%s AND candle_ts<%s
          UNION ALL SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source,1 FROM historical_candles_1d WHERE market=%s AND yahoo_symbol=%s AND source='barchart' AND candle_ts>=%s AND candle_ts<%s
        ) raw) ranked WHERE priority=chosen) candles"""
        args=(market,symbol,start_ts,end_ts)*2
    else:
        table=f'historical_candles_{tf}' if market=='forex' else 'candles_1d'
        source=f'{table}';args=(market,symbol,start_ts,end_ts)
    where='' if market=='us' else ' WHERE market=%s AND yahoo_symbol=%s AND candle_ts>=%s AND candle_ts<%s'
    with conn.cursor() as cur:
        cur.execute(f'SELECT candle_ts,open_price,high_price,low_price,close_price,volume,source FROM {source}{where} ORDER BY candle_ts,source',args)
        raw=cur.fetchall()
    seen={};excluded=set();audit={'invalid':0,'duplicates':0,'conflicts':0,'sources':sorted({r[6] for r in raw})}
    for r in raw:
        ts=r[0];ts=ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts
        local=ts.astimezone(zone);minute=local.hour*60+local.minute;t=int(ts.timestamp()*1000)
        if tf!='1d' and market=='us' and not 570<=minute<960:continue
        values=[float(v) if v is not None else float('nan') for v in r[1:5]]
        o,h,l,c=values
        if not all(math.isfinite(v) for v in values) or l>min(o,c) or h<max(o,c) or l>h:
            audit['invalid']+=1;excluded.add(t);seen.pop(t,None);continue
        duration=(960-minute if market=='us' else 1440-minute) if tf=='1d' else 60 if tf=='1h' else 5
        duration=min(duration,(960 if market=='us' else 1440)-minute)
        b={'t':t,'day':local.date().isoformat(),'minute':minute,'o':o,'h':h,'l':l,'c':c,'v':float(r[5] or 0),'knownAt':t+duration*60000}
        if t in excluded:audit['duplicates']+=1;continue
        if t in seen:
            audit['duplicates']+=1
            if any(seen[t][k]!=b[k] for k in ['o','h','l','c']):audit['conflicts']+=1;excluded.add(t);seen.pop(t,None)
            continue
        if b['knownAt']>(cutoff_ms if cutoff_ms is not None else int(datetime.now(timezone.utc).timestamp()*1000)):continue
        seen[t]=b
    return list(seen.values()),audit

def hourly(bars,market='us'):
    # US grid 09:30 plus complete final 30-minute bucket; forex midnight grid.
    opening=570 if market=='us' else 0;closing=960 if market=='us' else 1440
    buckets={}
    for b in bars:
        minute=opening+((b['minute']-opening)//60)*60
        buckets.setdefault((b['day'],minute),[]).append(b)
    out=[]
    for (day,minute),items in buckets.items():
        needed=min(60,closing-minute)//5
        if len(items)!=needed or any(items[i]['minute']!=minute+i*5 or items[i]['t']!=items[0]['t']+i*300000 or items[i]['knownAt']!=items[i]['t']+300000 for i in range(needed)):continue
        out.append({**items[0],'o':items[0]['o'],'h':max(x['h'] for x in items),'l':min(x['l'] for x in items),'c':items[-1]['c'],'v':sum(x['v'] for x in items),'knownAt':items[-1]['knownAt']})
    return out

def merge_hourly(native,lower,market):
    derived=hourly(lower,market);by_time={b['t']:b for b in derived};comparisons=conflicts=0
    for b in native:
        if b['t'] in by_time:
            comparisons+=1
            if any(abs(b[k]-by_time[b['t']][k])>1e-9 for k in ['o','h','l','c']):conflicts+=1
        by_time[b['t']]=b
    native_clocks={b['t'] for b in native}
    return sorted(by_time.values(),key=lambda b:b['t']),{'native':len(native),'derivedInserted':sum(b['t'] not in native_clocks for b in derived),'nativeDerivedOverlaps':comparisons,'nativeDerivedDifferentOHLC':conflicts,'policy':'Native validated H1 has precedence; only absent timestamps derive from complete contiguous 5m bars; differences recorded, never averaged.'}

def merge_daily_us(native,lower):
    by_day={b['day']:b for b in native};groups={};inserted=excluded=0
    for b in lower:groups.setdefault(b['day'],[]).append(b)
    for day,bars in groups.items():
        if day in by_day:continue
        if len(bars)!=78 or bars[0]['minute']!=570 or any(b['minute']!=570+i*5 or b['t']!=bars[0]['t']+i*300000 or b['knownAt']!=b['t']+300000 for i,b in enumerate(bars)):
            excluded+=1;continue
        # Native daily conventions use midnight NY, known only at RTH close.
        first=bars[0];midnight=int(datetime.fromisoformat(day).replace(tzinfo=ZoneInfo('America/New_York')).timestamp()*1000);by_day[day]={**first,'t':midnight,'minute':0,'o':first['o'],'h':max(b['h'] for b in bars),'l':min(b['l'] for b in bars),'c':bars[-1]['c'],'v':sum(b['v'] for b in bars),'knownAt':bars[-1]['knownAt']};inserted+=1
    return sorted(by_day.values(),key=lambda b:b['t']),{'nativeDays':len(native),'derivedInserted':inserted,'missingNativeIncompleteSessionDays':excluded,'policy':'Native live/archive daily priority; absent dates use exactly 78 contiguous completed RTH 5m bars. Gappy/partial sessions excluded.'}

if __name__=='__main__':
    conn=connect();rows=inventory(conn);conn.close()
    output=ROOT/'public/reports/scalping-backtest/coverage-inventory.json';output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(rows,indent=2),encoding='utf-8')
    print(json.dumps({'file':str(output),'symbols':len({(r['market'],r['symbol']) for r in rows}),'ranges':{m:{'first':min(r['first'] for r in rows if r['market']==m),'last':max(r['last'] for r in rows if r['market']==m)} for m in ['us','forex']}}))
