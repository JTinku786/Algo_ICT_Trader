// Planned reward:risk buckets = |target_1 - entry| / |entry - stop|, known at entry.
// Lower bound inclusive, upper bound exclusive (a planned 1.0 sits in "1-2").
export const PLANNED_RR_BUCKETS = [
  { id: "0-0.786", label: "0 – 0.786R", min: 0, max: 0.786 },
  { id: "0.786-1", label: "0.786 – 1R", min: 0.786, max: 1 },
  { id: "1-2", label: "1 – 2R", min: 1, max: 2 },
  { id: "2-3", label: "2 – 3R", min: 2, max: 3 },
  { id: "3-4", label: "3 – 4R", min: 3, max: 4 },
  { id: "4+", label: "4R +", min: 4, max: Infinity },
] as const;

export const PLANNED_RR_BUCKET_IDS: string[] = PLANNED_RR_BUCKETS.map((bucket) => bucket.id);

export function plannedRrBucketLabel(id: string) {
  return PLANNED_RR_BUCKETS.find((bucket) => bucket.id === id)?.label ?? id;
}

export function plannedRrBucketId(plannedRr: number | null | undefined) {
  if (plannedRr === null || plannedRr === undefined || !Number.isFinite(plannedRr) || plannedRr < 0) return null;
  return PLANNED_RR_BUCKETS.find((bucket) => plannedRr >= bucket.min && plannedRr < bucket.max)?.id ?? null;
}

/** null = no filter (ALL); [] = nothing selected (NONE). */
export function parsePlannedRrSelection(raw: string | null | undefined): string[] | null {
  if (!raw || raw.trim().toUpperCase() === "ALL") return null;
  if (raw.trim().toUpperCase() === "NONE") return [];
  const valid = new Set(PLANNED_RR_BUCKET_IDS);
  return raw.split(",").map((value) => value.trim()).filter((value) => valid.has(value));
}
