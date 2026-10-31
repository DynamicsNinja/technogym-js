import { TechnogymError } from "../errors.js";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Normalises a `YYYY-MM-DD` string or a `Date` to `YYYY-MM-DD`. A `Date` uses its LOCAL calendar
 * day, because sessions are partitioned by the gym's day and "today" means the caller's today.
 */
export function toIsoDate(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TechnogymError("Invalid Date");
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const m = ISO_DATE.exec(value);
  if (!m) throw new TechnogymError(`Invalid date "${value}"; expected YYYY-MM-DD`);
  // Date.UTC rolls 2026-13-01 over to 2027-01-01; a round trip that changes the text is invalid.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.toISOString().slice(0, 10) !== value) throw new TechnogymError(`Invalid date "${value}"`);
  return value;
}

/** `YYYY-MM-DD` to the API's `yyyyMMdd` partition key. */
export function toPartitionKey(value: string | Date): string {
  return toIsoDate(value).replaceAll("-", "");
}

/** The API's `yyyyMMdd` partition key to `YYYY-MM-DD`; anything else is returned as text. */
export function fromPartitionKey(value: unknown): string {
  const s = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/** `date` moved by `days` calendar days, as `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
