"use client";

import { ChevronDown } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/** Shared presentation pieces for the live and historical Account Management views. */

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export function money(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : INR.format(value);
}

export function signedMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${value > 0 ? "+" : ""}${INR.format(value)}`;
}

export function qty(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-IN");
}

export function price(value: number | null | undefined) {
  return value === null || value === undefined
    ? "—"
    : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export function fmtTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });
}

export function relativeAge(value: string | null | undefined) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function monthLabel(month: string) {
  const [year, value] = month.split("-").map(Number);
  if (!year || !value) return month;
  return new Date(Date.UTC(year, value - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shiftMonth(month: string, delta: number) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthOptions(current: string, values: string[]) {
  return [...new Set([current, ...values])]
    .filter((value) => /^\d{4}-\d{2}$/.test(value))
    .sort()
    .reverse();
}

export type Tone = "blue" | "green" | "gold" | "red" | "muted";

const TONE_TEXT: Record<Tone, string> = {
  blue: "text-[#8edfff]",
  green: "text-[#62d894]",
  gold: "text-[#f2c873]",
  red: "text-[#ff8b91]",
  muted: "text-[#93a1b6]",
};

export function pnlTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || value === 0) return "muted";
  return value > 0 ? "green" : "red";
}

export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label>
      <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-wide text-[#657187]">{label}</span>
      <span className="relative block">
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full appearance-none rounded-md border border-white/10 bg-[#080b10] px-3 pr-9 text-xs font-semibold text-[#d6deec] outline-none focus:border-[#d9a441]/60"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-[#657187]" />
      </span>
    </label>
  );
}

export function SummaryCard({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note: string;
  tone: Tone;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#101620] p-4">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-[#657187]">
        <Icon className={cx("size-4", TONE_TEXT[tone])} />
        {label}
      </div>
      <div className={cx("mt-3 font-mono text-2xl font-bold", TONE_TEXT[tone])}>{value}</div>
      <div className="mt-1 text-[10px] text-[#657187]">{note}</div>
    </div>
  );
}

export function Panel({
  icon: Icon,
  title,
  note,
  children,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("overflow-hidden rounded-lg border border-white/10 bg-[#101620]", className)}>
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <Icon className="size-4 text-[#d9a441]" />
        <h2 className="font-semibold text-white">{title}</h2>
        {note ? <span className="ml-auto font-mono text-[10px] text-[#657187]">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function StatusPill({ value }: { value: string }) {
  const lower = value.toLowerCase();
  const tone =
    lower.includes("complete") || lower.includes("verified") || lower === "active" || lower.includes("executed") || lower.includes("success")
      ? "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]"
      : lower.includes("reject") || lower.includes("fail") || lower.includes("error")
        ? "border-[#e5484d]/30 bg-[#e5484d]/10 text-[#ff8b91]"
        : lower.includes("open") || lower.includes("pending") || lower.includes("partial")
          ? "border-[#d9a441]/30 bg-[#d9a441]/10 text-[#f2c873]"
          : "border-white/10 bg-white/5 text-[#93a1b6]";
  return (
    <span className={cx("inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase", tone)}>
      {value.replaceAll("_", " ")}
    </span>
  );
}

export function SideCell({ side }: { side: string }) {
  const upper = (side || "").toUpperCase();
  return (
    <span className={cx("font-semibold", upper === "BUY" ? "text-[#62d894]" : upper === "SELL" ? "text-[#ff8b91]" : "text-[#93a1b6]")}>
      {upper || "—"}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  const algo = source === "algo";
  return (
    <span
      className={cx(
        "inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase",
        algo ? "border-[#4ea7ff]/30 bg-[#4ea7ff]/10 text-[#8edfff]" : "border-white/10 bg-white/5 text-[#93a1b6]",
      )}
    >
      {algo ? "Algo" : source === "manual" ? "Manual" : "Unknown"}
    </span>
  );
}

export function FeedBadge({ feed }: { feed: string }) {
  // Where the row came from. "Broker" means the broker API returned it;
  // "Rebuilt" means it was reconstructed from the algo's own execution audit
  // trail, because Angel One and Groww publish no historical endpoint.
  const live = feed === "broker_api";
  const label = live ? "Broker" : feed === "derived_trades" ? "Derived" : "Rebuilt";
  const title = live
    ? "Returned by the broker API"
    : feed === "derived_trades"
      ? "Computed from broker-returned fills"
      : "Reconstructed from the algo execution audit trail";
  return (
    <span
      title={title}
      className={cx(
        "inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase",
        live
          ? "border-[#2fbf71]/30 bg-[#2fbf71]/10 text-[#62d894]"
          : "border-white/10 bg-white/5 text-[#93a1b6]",
      )}
    >
      {label}
    </span>
  );
}

export function DataTable({ headers, children, minWidth = 900 }: { headers: string[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" style={{ minWidth }}>
        <thead className="bg-[#0b0f16] text-[10px] uppercase text-[#657187]">
          <tr>
            {headers.map((label) => (
              <th key={label} className="px-4 py-3 font-semibold">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyRow({ span, message }: { span: number; message: string }) {
  return (
    <tr>
      <td colSpan={span} className="px-4 py-10 text-center text-[11px] text-[#657187]">
        {message}
      </td>
    </tr>
  );
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-white/5", className ?? "h-36")} />;
}
