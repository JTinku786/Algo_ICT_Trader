"use client";

import { OrderChart } from "../components/order-chart";

export function SlackChartClient({ signalHash, ticker }: { signalHash: string; ticker: string }) {
  return (
    <OrderChart
      order={{ order_id: signalHash, symbol: ticker, strategy_id: "S03" }}
      endpoint="/api/realtime-analytics/order-chart"
      identifierParam="signal_hash"
      identifier={signalHash}
      targetNo="1"
      height={650}
      onClose={() => undefined}
    />
  );
}
