export type LogicalViewport = { from: number; to: number };
export type AnchoredViewport = { anchor: number; offsetFrom: number; offsetTo: number; times: number[]; anchorIndex: number };
export function anchorViewport(times: number[], range: LogicalViewport): AnchoredViewport | null {
  if (!times.length || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= range.from) return null;
  const index=Math.max(0,Math.min(times.length-1,Math.floor(range.from)));
  return {anchor:times[index],offsetFrom:range.from-index,offsetTo:range.to-index,times:[...times],anchorIndex:index};
}
export function restoreViewport(times: number[], saved: AnchoredViewport): LogicalViewport | null {
  let index=times.indexOf(saved.anchor);
  if(index<0) {
    const oldIndexes=new Map(saved.times.map((time,i)=>[time,i]));
    const commonIndex=times.findIndex(time=>oldIndexes.has(time));
    if(commonIndex<0)return null;
    index=commonIndex-oldIndexes.get(times[commonIndex])!+saved.anchorIndex;
  }
  return {from:index+saved.offsetFrom,to:index+saved.offsetTo};
}
export function viewportChanged(a:LogicalViewport,b:LogicalViewport) {
  return Math.abs(a.from-b.from)>0.001 || Math.abs(a.to-b.to)>0.001;
}
