# Trend Reversals · Daily · Forex (2017 → 2026)

Run 2026-10-05: `python reversal_engine.py --market forex --start 2017-01-01` (Desktop/ICT_Automation/trend_reversal_2026).
Runs `REV_FX_{baseline,reclaim3,k1,k1_reclaim3}_20261005`, period `FX_FULL`, timeframe 1d. Reversal tab → "Forex 2017 → 2026".

Data: historical_candles_1d market=forex (derived_1m), 12 pairs (AUDJPY AUDUSD CHFJPY EURGBP EURJPY EURUSD GBPJPY GBPUSD NZDUSD
USDCAD USDCHF USDJPY), 30,515 daily bars, 2017-01-02 → 2026-10-02. NY calendar days; the Sunday 17:00–24:00 stub is merged into
Monday (6,107 merged, 12 trailing orphans dropped). Same sweep → MSS rules, weekly FVG/OB, 126-bar premium/discount as equities.
FX calibration: audit reversal = ≥2% move in 20 bars (equities 6%); tiny-stop guard 0.15% (equities 0.5%). No spread/swap costs.
Walk-forward split 2022-01-01. Charts: /api/reversal/chart and /api/reversal/daily-forward read the forex tables for 6-letter pairs.

Default selection (k1_reclaim3 · OTE62_limit · 2R · hard stop, primary only): 278 trades, 39.2% win, +0.18R/trade, +49.5R;
in-sample +0.27R (135), out-of-sample +0.09R (143); 2025 −0.08R, 2026 −0.25R. US FULL same selection: 713 trades, +0.06R.
