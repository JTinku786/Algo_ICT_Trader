// REVERSAL_RAW5M_V2: retain raw OHLC, reject material native conflicts,
// and supplement only timestamps absent from both native feeds.
export function reversalFiveMinuteSql(symbol: string, market: string, from: string, to: string) {
  const aliases = `ARRAY[${symbol}::text,ltrim(${symbol}::text,'^'),'^'||ltrim(${symbol}::text,'^')]`;
  return `raw_native AS (
    SELECT candle_ts,open_price,high_price,low_price,close_price,0 AS source_priority FROM historical_candles_5m
    WHERE market=${market} AND base_symbol=ANY(${aliases}) AND candle_ts>=${from} AND candle_ts<${to}
    UNION ALL
    SELECT candle_ts,open_price,high_price,low_price,close_price,1 AS source_priority FROM candles_5m
    WHERE market=${market} AND base_symbol=ANY(${aliases}) AND candle_ts>=${from} AND candle_ts<${to}
  ),raw AS (
    SELECT * FROM raw_native
    UNION ALL
    SELECT s.candle_ts,s.open_price,s.high_price,s.low_price,s.close_price,2 AS source_priority
    FROM realtime_production_mss_reversal_candles s
    WHERE s.market=${market} AND s.ticker=ANY(${aliases}) AND s.candle_ts>=${from} AND s.candle_ts<${to}
      AND NOT EXISTS(SELECT 1 FROM raw_native n WHERE n.candle_ts=s.candle_ts)
  ),accepted AS (
    SELECT candle_ts FROM raw WHERE candle_ts+interval '5 minutes'<=now()
    GROUP BY candle_ts
    HAVING ${['open_price','high_price','low_price','close_price'].map(p=>`max(${p})-min(${p})<=CASE WHEN ${market}='us' THEN 0.0001 ELSE greatest(0.0000001,greatest(abs(max(${p})),abs(min(${p})))*0.0000001) END`).join(' AND ')}
      AND bool_and(open_price IS NOT NULL AND high_price IS NOT NULL AND low_price IS NOT NULL AND close_price IS NOT NULL
        AND open_price::text NOT IN ('NaN','Infinity','-Infinity') AND high_price::text NOT IN ('NaN','Infinity','-Infinity')
        AND low_price::text NOT IN ('NaN','Infinity','-Infinity') AND close_price::text NOT IN ('NaN','Infinity','-Infinity')
        AND low_price<=least(open_price,close_price) AND high_price>=greatest(open_price,close_price))
  ),five AS (
    SELECT DISTINCT ON(r.candle_ts) r.candle_ts,r.open_price,r.high_price,r.low_price,r.close_price
    FROM raw r JOIN accepted a USING(candle_ts)
    ORDER BY r.candle_ts,r.source_priority
  )`;
}
