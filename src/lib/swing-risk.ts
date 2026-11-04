export type SwingPlan = { entry: number; stop: number; target: number; knownAt: number };
export function swingRisk(entry: number, stop: number, target: number, direction: "BUY" | "SELL", equity: number, riskPercent: number, pointValue: number, leverageCap: number, costPerUnit = 0) {
  if (![entry,stop,target,equity,riskPercent,pointValue,leverageCap,costPerUnit].every(Number.isFinite) || entry<=0 || equity<=0 || riskPercent<=0 || riskPercent>100 || pointValue<=0 || leverageCap<=0 || costPerUnit<0 || (direction==="BUY" ? stop>=entry || target<=entry : stop<=entry || target>=entry)) return null;
  const priceRisk=Math.abs(entry-stop), priceReward=Math.abs(target-entry);
  const lossPerUnit=priceRisk*pointValue+costPerUnit, rewardPerUnit=priceReward*pointValue-costPerUnit;
  const budget=equity*riskPercent/100, unitsByRisk=budget/lossPerUnit, unitsByLeverage=equity*leverageCap/(entry*pointValue);
  const units=Math.min(unitsByRisk,unitsByLeverage), loss=units*lossPerUnit, reward=units*rewardPerUnit;
  return {units,unitsByRisk,unitsByLeverage,loss,reward,grossR:priceReward/priceRisk,netR:rewardPerUnit/lossPerUnit,riskPercent:loss/equity*100,rewardPercent:reward/equity*100,leverage:units*entry*pointValue/equity,leverageLimited:unitsByLeverage<unitsByRisk};
}
