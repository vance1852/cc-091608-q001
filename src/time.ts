// 时间处理：原始采集时间一律保留带偏移的 ISO 字符串；
// 所有比较与合并在 UTC 毫秒轴上进行；本地日期仅用于展示与跨午夜归属。

const SUPPORTED_TZ: ReadonlySet<string> = new Set(
  // Node 22 内置完整 ICU 时区数据。
  (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf?.("timeZone") ?? [],
);

export function assertTimezone(timezone: string): void {
  if (SUPPORTED_TZ.size === 0) {
    // 极端情况下拿不到时区表，退化为让 Intl 自己校验。
    try {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      return;
    } catch {
      throw new Error(`unsupported timezone: ${timezone}`);
    }
  }
  if (!SUPPORTED_TZ.has(timezone)) {
    throw new Error(`unsupported timezone: ${timezone}`);
  }
}

/** 解析带偏移的采集时间；不接受“无时区”的裸字符串，避免被服务器本地时区污染。 */
export function parseCapturedAt(capturedAt: string): number {
  const t = Date.parse(capturedAt);
  if (Number.isNaN(t)) {
    throw new Error(`invalid capturedAt timestamp: ${capturedAt}`);
  }
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(capturedAt.trim())) {
    throw new Error(`capturedAt must carry an explicit UTC offset: ${capturedAt}`);
  }
  return t;
}

function zonedParts(epochMs: number, timezone: string) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === "24" ? "00" : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** 设备时区下的本地日历日期 YYYY-MM-DD（用于跨午夜归属）。 */
export function localDate(epochMs: number, timezone: string): string {
  const p = zonedParts(epochMs, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 设备时区下的本地时间标签，仅用于展示。 */
export function localLabel(epochMs: number, timezone: string): string {
  const p = zonedParts(epochMs, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function toIsoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function intervalEndMs(startMs: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error(`invalid durationSeconds: ${durationSeconds}`);
  }
  return startMs + Math.round(durationSeconds * 1000);
}

/**
 * 两个区间是否属于“同一次发作”：
 * 重叠，或间隔不超过 gapToleranceMs（相邻提示也合并，允许夹一个短 ECG/缺口）。
 */
export function overlapsOrAdjacent(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
  gapToleranceMs: number,
): boolean {
  return bStart <= aEnd + gapToleranceMs && aStart <= bEnd + gapToleranceMs;
}
