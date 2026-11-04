import sys, warnings, pandas as pd, psycopg2
warnings.filterwarnings("ignore")
import consolidation_engine as ce
rv = ce.rv
con = psycopg2.connect(rv.db_uri())
for tf, sym, sd in [("1h", "CSCO", "2021-11-22 10:30"), ("1h", "KO", "2022-06-28 11:30"), ("30m", "WMT", "2021-05-19 10:30")]:
    b = pd.read_sql(f"select * from consolidation_boxes where run_id like 'CONS_FULL_{tf}_standard%%' and sym=%s and start_date=%s", con, params=(sym, sd)).iloc[0]
    print(tf, sym, dict(b[["confirm_date", "box_hi", "box_lo", "sweep_side", "sweep_kind", "sweep_date", "break_dir", "break_date", "fate"]]))
    c = pd.read_sql(f"select candle_ts at time zone 'America/New_York' d, open_price o, high_price h, low_price l, close_price c from {'historical_candles_30m'} "
                    "where base_symbol=%s and candle_ts at time zone 'America/New_York' between %s::timestamp and %s::timestamp + interval '4 day' order by 1",
                    con, params=(sym, str(b.confirm_date), str(b.confirm_date)))
    print(c.head(40).to_string())
