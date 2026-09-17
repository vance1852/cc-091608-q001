import type { ClinicalReview, DeviceContext, SignalKind } from "./contracts.js";
import { toLocalParts, type LocalParts } from "./time.js";

/** 相邻提示归并到同一发作候选的最大间隔（5 分钟）。 */
export const MERGE_GAP_MS = 5 * 60 * 1000;

export type Role = "nurse" | "doctor" | "auditor";

export type EpisodeStatus =
  | "open"
  | "contact-pending"
  | "contacted"
  | "escalated"
  | "closed-artifact";

export type RiskLevel = "low" | "moderate" | "high";

/** 归一化后的质量依据：佩戴松动 / 剧烈运动 / 信号缺口。 */
export interface QualityEvidence {
  looseFit: boolean;
  vigorousMotion: boolean;
  signalGap: boolean;
  /** 未能归类的原始标记，原样保留。 */
  otherFlags: string[];
  /** 所有片段原始标记的并集，便于追溯。 */
  rawFlags: string[];
}

export interface EpisodeFragment {
  packetId: string;
  patientId: string;
  kind: SignalKind;
  /** 设备上报的原始采集时间串，逐字保留。 */
  capturedAt: string;
  startMs: number;
  endMs: number;
  durationSeconds: number;
  qualityFlags: string[];
  /** 每条片段各自的设备上下文（固件/算法/校准/时区），互不覆盖。 */
  device: DeviceContext;
}

export interface Episode {
  episodeId: string;
  patientId: string;
  startMs: number;
  endMs: number;
  fragments: EpisodeFragment[];
  status: EpisodeStatus;
  reviews: ClinicalReview[];
  createdAt: string;
  /** 被本发作吸收掉的 episodeId（归并审计）。 */
  mergedFrom: string[];
  /** 若本发作被归并进其他发作，记录目标 episodeId。 */
  mergedInto?: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  /** 逐条可解释的风险依据，直接面向护士与医生展示。 */
  basis: string[];
}

export interface LocalWindow {
  start: LocalParts;
  end: LocalParts;
  crossesLocalMidnight: boolean;
  /** 归属日：发作起始瞬间所在的设备当地日历日。 */
  attributedLocalDate: string;
}

const LOOSE_FIT_FLAGS = new Set(["loose-fit", "loose_fit", "loosefit", "poor-contact", "off-wrist"]);
const MOTION_FLAGS = new Set(["motion", "vigorous-motion", "exercise", "high-motion"]);
const GAP_FLAGS = new Set(["signal-gap", "gap", "dropout", "missing-samples"]);

/** 汇总全部片段的质量标记，归类为三类质量依据。 */
export function collectQuality(fragments: EpisodeFragment[]): QualityEvidence {
  const raw = new Set<string>();
  const other = new Set<string>();
  let looseFit = false;
  let vigorousMotion = false;
  let signalGap = false;
  for (const f of fragments) {
    for (const flag of f.qualityFlags) {
      const key = flag.trim().toLowerCase();
      raw.add(flag);
      if (LOOSE_FIT_FLAGS.has(key)) looseFit = true;
      else if (MOTION_FLAGS.has(key)) vigorousMotion = true;
      else if (GAP_FLAGS.has(key)) signalGap = true;
      else other.add(flag);
    }
  }
  return {
    looseFit,
    vigorousMotion,
    signalGap,
    otherFlags: [...other].sort(),
    rawFlags: [...raw].sort(),
  };
}

/** 判断一个片段窗口是否与发作窗口重叠或相邻（间隔 ≤ MERGE_GAP_MS）。 */
export function windowTouches(
  episode: { startMs: number; endMs: number },
  startMs: number,
  endMs: number,
): boolean {
  return startMs <= episode.endMs + MERGE_GAP_MS && episode.startMs <= endMs + MERGE_GAP_MS;
}

/** 计算发作的设备本地窗口与跨午夜归属。 */
export function localWindow(episode: Episode): LocalWindow {
  const timeZone = primaryTimeZone(episode);
  const start = toLocalParts(episode.startMs, timeZone);
  const end = toLocalParts(episode.endMs, timeZone);
  return {
    start,
    end,
    crossesLocalMidnight: start.date !== end.date,
    attributedLocalDate: start.date,
  };
}

/** 发作时区以首条片段的设备时区为准；各片段原始上下文仍各自保留。 */
export function primaryTimeZone(episode: Episode): string {
  const first = episode.fragments.at(0);
  return first ? first.device.timezone : "UTC";
}

/**
 * 可解释的风险分层：只基于已保存的事实（疑似时长、是否附心电、质量标记），
 * 输出每一条依据，绝不把设备算法结论直接当成诊断。
 */
export function assessRisk(episode: Episode): RiskAssessment {
  const ppg = episode.fragments.filter((f) => f.kind === "ppg-summary");
  const ecg = episode.fragments.filter((f) => f.kind === "single-lead-ecg");
  const suspectedSeconds = ppg.reduce((sum, f) => sum + f.durationSeconds, 0);
  const quality = collectQuality(episode.fragments);
  const win = localWindow(episode);

  const basis: string[] = [];
  basis.push(
    `设备算法在 ${win.start.isoLike} 至 ${win.end.isoLike}（设备时区）内累计上报 ${ppg.length} 段疑似房颤提示，共 ${suspectedSeconds} 秒`,
  );
  if (win.crossesLocalMidnight) {
    basis.push(`发作跨越设备当地午夜，归属 ${win.attributedLocalDate}，结束于 ${win.end.date}`);
  }
  if (ecg.length > 0) {
    basis.push(`已附 ${ecg.length} 段单导联心电，需医生判读后方可确认`);
  }
  if (quality.vigorousMotion) basis.push("存在剧烈运动标记，对应片段可信度下降");
  if (quality.looseFit) basis.push("存在佩戴松动标记，对应片段可信度下降");
  if (quality.signalGap) basis.push("存在信号缺口，发作边界可能不完整");

  let level: RiskLevel = "low";
  if (suspectedSeconds >= 30) level = "moderate";
  if (suspectedSeconds >= 120) level = "high";
  if (ecg.length > 0 && suspectedSeconds >= 60) level = "high";

  const allPpgArtifact =
    ppg.length > 0 &&
    ppg.every((f) =>
      f.qualityFlags.some((flag) => {
        const key = flag.trim().toLowerCase();
        return LOOSE_FIT_FLAGS.has(key) || MOTION_FLAGS.has(key);
      }),
    );
  if (allPpgArtifact && ecg.length === 0) {
    level = "low";
    basis.push("全部疑似提示均伴随伪迹标记且无心电佐证，倾向伪迹");
  }

  return { level, basis };
}

/** 医生更正链的当前结论：沿 correctsReviewId 链取最新一条 correct 复核。 */
export function latestInterpretation(reviews: ClinicalReview[]): ClinicalReview | null {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    const review = reviews[i];
    if (review && review.disposition === "correct") return review;
  }
  return null;
}
