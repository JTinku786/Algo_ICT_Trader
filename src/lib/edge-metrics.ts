// Shared edge / risk-sizing metrics.
//
// These are the textbook formulas that sit on top of the win rate and the
// payoff ratio a population already produces, kept in one place so the
// backtest API, the realtime analytics API and the Python REST bridge all
// agree on the arithmetic.
//
//   payoff ratio      b  = avg win / |avg loss|
//   break-even WR     p(BE) = 1 / (1 + b)
//   Kelly (simplified) f* = p - (1 - p) / b
//   risk of ruin      RoR = [(1 - p) / p] ^ N          (equal +-1 payoffs)
//
// The equal-payoff risk of ruin is only meaningful when p > 0.5, which almost
// no ICT setup is, so a payoff-aware variant is reported alongside it:
//
//   z = expectancy / sqrt(mean(R^2));  RoR = [(1 - z) / (1 + z)] ^ N
//
// N is the number of risk units in the account (capital / risk per trade).

export type EdgeMetricsInput = {
  /** Win rate as a percentage (0-100). */
  winRatePct: number | null;
  /** Average winning trade in R (positive). */
  avgWinR: number | null;
  /** Average losing trade in R (sign ignored). */
  avgLossR: number | null;
  /** Risk staked per trade in account currency. */
  riskPerTradeUsd?: number | null;
  /** Account size the sizing is measured against. */
  initialCapitalUsd?: number | null;
  /** Realized R of every closed trade, for the payoff-aware risk of ruin. */
  rMultiples?: number[] | null;
  /** Fallback risk units when no capital / risk pair is available. */
  fallbackRiskUnits?: number;
};

export type EdgeMetrics = {
  payoff_ratio: number | null;
  breakeven_win_rate_pct: number | null;
  win_rate_edge_pct: number | null;
  kelly_fraction_pct: number | null;
  half_kelly_fraction_pct: number | null;
  risk_of_ruin_pct: number | null;
  risk_of_ruin_simple_pct: number | null;
  risk_units: number | null;
};

const EMPTY: EdgeMetrics = {
  payoff_ratio: null,
  breakeven_win_rate_pct: null,
  win_rate_edge_pct: null,
  kelly_fraction_pct: null,
  half_kelly_fraction_pct: null,
  risk_of_ruin_pct: null,
  risk_of_ruin_simple_pct: null,
  risk_units: null,
};

function r2(value: number, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Clamp a probability expressed as a percentage into [0, 100]. */
function pct(value: number, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return r2(Math.min(100, Math.max(0, value)), digits);
}

export function computeEdgeMetrics(input: EdgeMetricsInput): EdgeMetrics {
  const winRatePct = input.winRatePct;
  if (winRatePct === null || !Number.isFinite(winRatePct)) return EMPTY;
  const p = winRatePct / 100;
  const avgWin = Math.abs(input.avgWinR ?? 0);
  const avgLoss = Math.abs(input.avgLossR ?? 0);
  const b = avgLoss > 0 && avgWin > 0 ? avgWin / avgLoss : null;

  // Risk units in the account.  Fixed-risk sizing gives this directly; without
  // it, fall back to the caller's convention (1% per trade => 100 units).
  const capital = input.initialCapitalUsd ?? null;
  const risk = input.riskPerTradeUsd ?? null;
  const riskUnits =
    capital !== null && risk !== null && capital > 0 && risk > 0
      ? Math.max(1, Math.floor(capital / risk))
      : input.fallbackRiskUnits ?? null;

  const breakeven = b !== null ? 100 / (1 + b) : null;
  const kelly = b !== null && b > 0 ? (p - (1 - p) / b) * 100 : null;

  // Equal +-1 payoff risk of ruin, exactly as the classic formula states it.
  // Below a 50% win rate the series does not converge: ruin is certain in the
  // limit, so it is reported as 100 rather than as a number above it.
  let simpleRor: number | null = null;
  if (riskUnits !== null) {
    simpleRor = p > 0.5 ? Math.min(100, (((1 - p) / p) ** riskUnits) * 100) : 100;
  }

  // Payoff-aware variant: scales the edge by the typical trade size, so a
  // 35% win rate at 3R still shows a survivable ruin probability.
  let ror: number | null = null;
  const rs = (input.rMultiples ?? []).filter((value) => Number.isFinite(value));
  if (riskUnits !== null) {
    let expectancy: number | null = null;
    let rms: number | null = null;
    if (rs.length) {
      expectancy = rs.reduce((a, value) => a + value, 0) / rs.length;
      rms = Math.sqrt(rs.reduce((a, value) => a + value ** 2, 0) / rs.length);
    } else if (b !== null) {
      expectancy = p * avgWin - (1 - p) * avgLoss;
      rms = Math.sqrt(p * avgWin ** 2 + (1 - p) * avgLoss ** 2);
    }
    if (expectancy !== null && rms !== null && rms > 0) {
      if (expectancy <= 0) {
        ror = 100;
      } else {
        const z = Math.min(0.999999, expectancy / rms);
        ror = Math.min(100, (((1 - z) / (1 + z)) ** riskUnits) * 100);
      }
    }
  }

  return {
    payoff_ratio: b === null ? null : r2(b),
    breakeven_win_rate_pct: breakeven === null ? null : r2(breakeven, 1),
    win_rate_edge_pct: breakeven === null ? null : r2(winRatePct - breakeven, 1),
    kelly_fraction_pct: kelly === null ? null : r2(kelly, 2),
    half_kelly_fraction_pct: kelly === null ? null : r2(kelly / 2, 2),
    risk_of_ruin_pct: ror === null ? null : pct(ror, 2),
    risk_of_ruin_simple_pct: simpleRor === null ? null : pct(simpleRor, 2),
    risk_units: riskUnits,
  };
}
