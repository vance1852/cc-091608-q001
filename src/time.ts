/**
 * 时区工具：把 UTC 瞬间换算到设备所在时区的本地日历时间。
 * 跨午夜归属完全依赖设备时区，而不是服务器时区。
 */

export interface LocalParts {
  /** 形如 2026-09-15T23:58:20+08:00 */
  isoLike: string;
  /** 本地日历日，形如 2026-09-15 */
  date: string;
  /** 本地时刻，形如 23:58:20 */
  time: string;
  /** 该瞬间在设备时区的 UTC 偏移，形如 +08:00 */
  offset: string;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

/** 校验是否为可识别的 IANA 时区名。 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** 把 epoch 毫秒格式化为设备时区的本地时间部件。 */
export function toLocalParts(epochMs: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(epochMs);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  const minute = pick("minute");
  const second = pick("second");
  const rawOffset = pick("timeZoneName"); // GMT+8 / GMT-3:30 / GMT
  const offset = normalizeOffset(rawOffset);
  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}:${second}`;
  return { isoLike: `${date}T${time}${offset}`, date, time, offset };
}

function normalizeOffset(raw: string): string {
  if (raw === "GMT" || raw === "") return "+00:00";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!m) return raw;
  const sign = m[1] ?? "+";
  const hh = (m[2] ?? "0").padStart(2, "0");
  const mm = m[3] ?? "00";
  return `${sign}${hh}:${mm}`;
}

/** 解析带显式偏移的 ISO-8601 时间串；缺少 Z 或 ±hh:mm 偏移时拒绝。 */
export function parseCapturedAt(raw: string): number | null {
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}
