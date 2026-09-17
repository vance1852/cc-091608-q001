// 发作候选构建：
// 1) 只有 PPG 疑似提示参与“发作”聚类；按需 ECG 只作为核对证据挂到重叠窗口；
// 2) 相邻（间隔 ≤ ADJACENCY_TOLERANCE_MS）或重叠的提示合并成一个可解释候选；
// 3) 佩戴松动、剧烈运动、信号缺口汇总为质量依据；
// 4) 风险分层完全由可枚举的加减分理由推导，设备算法结论不等于诊断。

import type {
  EpisodeCandidate,
  EpisodeProvenance,
  QualityEvidence,
  RiskAssessment,
  SignalFragment,
} from "./contracts.ts";
import type { StoredPacket } from "./ingest.ts";
import {
  intervalEndMs,
  localDate,
  overlapsOrAdjacent,
  parseCapturedAt,
  toIsoUtc,
} from "./time.ts";

/** 两条提示最多相隔多久还算“同一次发作”。 */
export const ADJACENCY_TOLERANCE_MS = 120_000;
/** 成员窗口之间超过该长度的无信号间隔才单独列为缺口证据。 */
export const GAP_REPORT_MS = 60_000;

export interface EpisodeSource {
  allPackets(): StoredPacket[];
}

interface Interval {
  startMs: number;
  endMs: number;
  packet: StoredPacket;
}

function toInterval(p: StoredPacket): Interval {
  const startMs = parseCapturedAt(p.fragment.capturedAt);
  return { startMs, endMs: intervalEndMs(startMs, p.fragment.durationSeconds), packet: p };
}

/** 对 PPG 提示做有序合并，返回若干 [起, 止] 簇（UTC ms）。 */
function clusterPpgHints(intervals: Interval[]): Array<[number, number]> {
  const ppg = intervals
    .filter((i) => i.packet.fragment.kind === "ppg-summary")
    .sort((a, b) => a.startMs - b.startMs);
  const clusters: Array<[number, number]> = [];
  for (const hint of ppg) {
    const last = clusters[clusters.length - 1];
    if (last && hint.startMs <= last[1] + ADJACENCY_TOLERANCE_MS) {
      last[1] = Math.max(last[1], hint.endMs);
    } else {
      clusters.push([hint.startMs, hint.endMs]);
    }
  }
  return clusters;
}

/** 提示合并后的累计覆盖时长（重叠部分只算一次，秒）。 */
function unionDurationSeconds(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let total = 0;
  let curStart: number | null = null;
  let curEnd = 0;
  for (const iv of sorted) {
    if (curStart === null) {
      curStart = iv.startMs;
      curEnd = iv.endMs;
    } else if (iv.startMs <= curEnd) {
      curEnd = Math.max(curEnd, iv.endMs);
    } else {
      total += curEnd - curStart;
      curStart = iv.startMs;
      curEnd = iv.endMs;
    }
  }
  if (curStart !== null) total += curEnd - curStart;
  return Math.round(total / 1000);
}

function contextOf(f: SignalFragment): EpisodeProvenance {
  return {
    deviceId: f.device.deviceId,
    firmwareVersion: f.device.firmwareVersion,
    algorithmVersion: f.device.algorithmVersion,
    calibrationVersion: f.device.calibrationVersion,
    timezone: f.device.timezone,
  };
}

function uniqueContexts(members: Interval[]): EpisodeProvenance[] {
  const seen = new Map<string, EpisodeProvenance>();
  for (const m of members) {
    const ctx = contextOf(m.packet.fragment);
    seen.set(JSON.stringify(ctx), ctx);
  }
  return [...seen.values()];
}

const LOOSE_TOKENS = ["loose", "strap", "loose-strap", "wearable-loose"];
const MOTION_TOKENS = ["exercise", "motion", "intense-motion", "intense-exercise"];

function hasToken(flags: string[], tokens: string[]): boolean {
  return flags.some((f) => tokens.includes(f));
}

function evidenceFromPackets(
  type: QualityEvidence["type"],
  packets: StoredPacket[],
  detail: string,
): QualityEvidence | null {
  if (packets.length === 0) return null;
  const ranges = packets.map((p): [number, number] => {
    const s = parseCapturedAt(p.fragment.capturedAt);
    return [s, intervalEndMs(s, p.fragment.durationSeconds)];
  });
  return {
    type,
    rawFlags: [...new Set(packets.flatMap((p) => p.fragment.qualityFlags))].sort(),
    sourcePacketIds: [...new Set(packets.map((p) => p.fragment.packetId))].sort(),
    startsAt: toIsoUtc(Math.min(...ranges.map((r) => r[0]))),
    endsAt: toIsoUtc(Math.max(...ranges.map((r) => r[1]))),
    detail,
  };
}

function buildQualityEvidence(members: Interval[]): QualityEvidence[] {
  const ordered = [...members].sort((a, b) => a.startMs - b.startMs);
  const loose: StoredPacket[] = [];
  const exercise: StoredPacket[] = [];
  const gapFlagged: StoredPacket[] = [];
  for (const m of ordered) {
    const flags = m.packet.fragment.qualityFlags;
    if (hasToken(flags, LOOSE_TOKENS)) loose.push(m.packet);
    if (hasToken(flags, MOTION_TOKENS)) exercise.push(m.packet);
    if (flags.includes("signal-gap")) gapFlagged.push(m.packet);
  }

  // 相邻成员窗口之间的无信号区间。
  const gapRanges: Array<[number, number]> = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const cur = ordered[i]!;
    const gapMs = cur.startMs - prev.endMs;
    if (gapMs > GAP_REPORT_MS) gapRanges.push([prev.endMs, cur.startMs]);
  }

  const gapEvidence = evidenceFromPackets(
    "signal-gap",
    gapFlagged,
    "设备上报信号缺口；无信号区间内不能推断是否持续发作，持续时长需保守解读。",
  );
  if (gapRanges.length > 0) {
    const gapPacketIds = new Set(gapEvidence?.sourcePacketIds ?? []);
    const merged: QualityEvidence = {
      type: "signal-gap",
      rawFlags: gapEvidence?.rawFlags ?? [],
      sourcePacketIds: [...gapPacketIds].sort(),
      startsAt: toIsoUtc(
        Math.min(...gapRanges.map((r) => r[0]), gapEvidence ? Date.parse(gapEvidence.startsAt) : Infinity),
      ),
      endsAt: toIsoUtc(
        Math.max(...gapRanges.map((r) => r[1]), gapEvidence ? Date.parse(gapEvidence.endsAt) : -Infinity),
      ),
      detail:
        "发作窗口内存在无信号区间（成员片段间隔 >60 秒，或设备上报 signal-gap）；不能据此推断该期间持续发作。",
    };
    return [
      evidenceFromPackets(
        "loose-strap",
        loose,
        "设备上报佩戴松动；该窗口脉波形态不可靠，提示可能由接触不良造成。",
      ),
      evidenceFromPackets(
        "exercise",
        exercise,
        "设备上报运动 / 剧烈活动；运动伪迹可模拟节律不齐，需结合 ECG 核对。",
      ),
      merged,
    ].filter((e): e is QualityEvidence => e !== null);
  }

  return [
    evidenceFromPackets(
      "loose-strap",
      loose,
      "设备上报佩戴松动；该窗口脉波形态不可靠，提示可能由接触不良造成。",
    ),
    evidenceFromPackets(
      "exercise",
      exercise,
      "设备上报运动 / 剧烈活动；运动伪迹可模拟节律不齐，需结合 ECG 核对。",
    ),
    gapEvidence,
  ].filter((e): e is QualityEvidence => e !== null);
}

function assessRisk(
  ppgCount: number,
  coveredSeconds: number,
  ecgs: Interval[],
  evidence: QualityEvidence[],
  allPpgFlagged: boolean,
): RiskAssessment {
  let score = 0;
  const basis: string[] = [];
  const add = (points: number, text: string) => {
    score += points;
    basis.push(`${points >= 0 ? "+" : ""}${points} ${text}`);
  };

  add(1, "设备算法给出疑似房颤提示（仅为筛查信号，不构成诊断）");
  if (coveredSeconds >= 30) add(1, `去重叠后疑似覆盖 ${coveredSeconds} 秒，达到 ≥30 秒临床关注时长`);
  if (coveredSeconds >= 120) add(1, "累计疑似覆盖 ≥2 分钟，发作负担较高");
  if (coveredSeconds >= 300) add(1, "累计疑似覆盖 ≥5 分钟，持续性提示更强");
  if (ppgCount >= 3) add(1, `合并 ${ppgCount} 条相邻 / 重叠提示，夜间反复出现`);

  const cleanEcg = ecgs.filter(
    (e) => !hasToken(e.packet.fragment.qualityFlags, MOTION_TOKENS),
  );
  const motionEcg = ecgs.filter((e) =>
    hasToken(e.packet.fragment.qualityFlags, MOTION_TOKENS),
  );
  if (cleanEcg.length > 0) {
    add(2, `窗口内有 ${cleanEcg.length} 段无运动标记的单导联 ECG 可供医生核对`);
  }
  if (motionEcg.length > 0) {
    add(1, `另有 ${motionEcg.length} 段 ECG 带运动标记，证据力下降，仅作参考`);
  }

  if (evidence.some((e) => e.type === "loose-strap")) {
    add(-1, "窗口存在佩戴松动依据，降低提示可信度");
  }
  if (evidence.some((e) => e.type === "exercise")) {
    add(-1, "窗口存在剧烈运动 / 运动伪迹依据，降低提示可信度");
  }
  if (evidence.some((e) => e.type === "signal-gap")) {
    add(-1, "窗口存在信号缺口，持续时长与发作判断需保守");
  }
  if (allPpgFlagged) {
    add(-2, "全部疑似提示均伴随松动或运动标记，整段证据力不足");
  }

  return {
    level: score >= 4 ? "urgent" : score >= 1 ? "watch" : "screening",
    score,
    basis,
  };
}

export function buildEpisodes(store: EpisodeSource): EpisodeCandidate[] {
  const packets = store.allPackets();
  const patientIds = [...new Set(packets.map((p) => p.fragment.patientId))].sort();
  const episodes: EpisodeCandidate[] = [];

  for (const patientId of patientIds) {
    const intervals = packets
      .filter((p) => p.fragment.patientId === patientId)
      .map(toInterval);
    const clusters = clusterPpgHints(intervals);

    clusters.forEach(([cStart, cEnd]) => {
      // 挂载与簇窗口重叠（或在容差内相邻）的全部成员片段。
      const members = intervals.filter(
        (i) =>
          overlapsOrAdjacent(i.startMs, i.endMs, cStart, cEnd, ADJACENCY_TOLERANCE_MS),
      );
      const ppg = members
        .filter((i) => i.packet.fragment.kind === "ppg-summary")
        .sort((a, b) => a.startMs - b.startMs);
      const ecg = members.filter((i) => i.packet.fragment.kind === "single-lead-ecg");
      const evidence = buildQualityEvidence(members);
      const allPpgFlagged =
        ppg.length > 0 &&
        ppg.every((i) =>
          hasToken(i.packet.fragment.qualityFlags, [...LOOSE_TOKENS, ...MOTION_TOKENS]),
        );

      const coveredSeconds = unionDurationSeconds(ppg);
      const risk = assessRisk(ppg.length, coveredSeconds, ecg, evidence, allPpgFlagged);

      const ordered = [...members].sort(
        (a, b) =>
          a.startMs - b.startMs ||
          a.packet.fragment.packetId.localeCompare(b.packet.fragment.packetId),
      );
      const anchor = ppg[0] ?? ordered[0]!;
      const tz = anchor.packet.fragment.device.timezone;
      const firstObservedMs = Math.min(...members.map((m) => m.packet.uploadedAtMs));

      episodes.push({
        episodeId: `ep:${patientId}:${anchor.packet.fragment.packetId}`,
        patientId,
        localStartDate: localDate(cStart, tz),
        localEndDate: localDate(cEnd, tz),
        timezone: tz,
        crossedMidnight: localDate(cStart, tz) !== localDate(cEnd, tz),
        startCapturedAt: toIsoUtc(cStart),
        endCapturedAt: toIsoUtc(cEnd),
        coveredDurationSeconds: coveredSeconds,
        mergedHintCount: ppg.length,
        memberPacketIds: ordered.map((i) => i.packet.fragment.packetId),
        ppgPacketIds: ppg.map((i) => i.packet.fragment.packetId),
        ecgPacketIds: ecg.map((i) => i.packet.fragment.packetId),
        qualityEvidence: evidence,
        risk,
        provenance: contextOf(anchor.packet.fragment),
        sourceContexts: uniqueContexts(ordered),
        status: "open",
        firstObservedAt: toIsoUtc(firstObservedMs),
      });
    });
  }

  return episodes.sort((a, b) =>
    a.startCapturedAt === b.startCapturedAt
      ? a.episodeId.localeCompare(b.episodeId)
      : a.startCapturedAt.localeCompare(b.startCapturedAt),
  );
}
