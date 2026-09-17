import type { ClinicalReview } from "./contracts.js";
import type { Episode, EpisodeStatus } from "./domain.js";

/** 时间线事件类型，覆盖发作候选从产生到归档的完整状态变化。 */
export type TimelineEventType =
  | "episode-opened"
  | "fragment-attached"
  | "duplicate-packet-ignored"
  | "episodes-merged"
  | "episode-reopened"
  | "review-added"
  | "contact-opened"
  | "contact-closed"
  | "escalated"
  | "correction-appended"
  | "consent-revoked";

export interface TimelineEvent {
  seq: number;
  at: string;
  patientId: string;
  episodeId?: string;
  type: TimelineEventType;
  actor?: string;
  statusFrom?: EpisodeStatus;
  statusTo?: EpisodeStatus;
  detail: Record<string, unknown>;
}

export interface ContactTask {
  taskId: string;
  episodeId: string;
  patientId: string;
  openedBy: string;
  openedAt: string;
  reason: string;
  status: "open" | "closed";
  closedBy?: string;
  closedAt?: string;
  outcome?: "reached" | "unreachable" | "refused";
  note?: string;
}

export interface ConsentRecord {
  patientId: string;
  status: "active" | "revoked";
  revokedAt?: string;
  revokedBy?: string;
  reason?: string;
}

export interface IngestionRecord {
  packetId: string;
  patientId: string;
  episodeId: string;
  firstIngestedAt: string;
  /** 含首次在内的重复上传次数，用于审计“重复数据包不得制造新事件”。 */
  attempts: number;
}

/**
 * 进程内存储。复核记录与时间线只追加、不修改，
 * 满足“医生的解释只能追加更正”和“历史审计仍保留”的约束。
 */
export class Store {
  readonly episodes = new Map<string, Episode>();
  readonly packets = new Map<string, IngestionRecord>();
  readonly contacts = new Map<string, ContactTask>();
  readonly consents = new Map<string, ConsentRecord>();
  readonly timeline: TimelineEvent[] = [];
  readonly reviews = new Map<string, ClinicalReview>();

  private seq = 0;
  private episodeSeq = 0;
  private reviewSeq = 0;
  private contactSeq = 0;

  nextEpisodeId(): string {
    this.episodeSeq += 1;
    return `ep-${String(this.episodeSeq).padStart(4, "0")}`;
  }

  nextReviewId(): string {
    this.reviewSeq += 1;
    return `rev-${String(this.reviewSeq).padStart(4, "0")}`;
  }

  nextContactId(): string {
    this.contactSeq += 1;
    return `ct-${String(this.contactSeq).padStart(4, "0")}`;
  }

  append(event: Omit<TimelineEvent, "seq">): TimelineEvent {
    this.seq += 1;
    const full: TimelineEvent = { seq: this.seq, ...event };
    this.timeline.push(full);
    return full;
  }

  episodesOf(patientId: string): Episode[] {
    return [...this.episodes.values()].filter((e) => e.patientId === patientId);
  }

  timelineOf(episodeId: string): TimelineEvent[] {
    return this.timeline.filter((e) => e.episodeId === episodeId);
  }

  auditOf(patientId: string): TimelineEvent[] {
    return this.timeline.filter((e) => e.patientId === patientId);
  }

  consentOf(patientId: string): ConsentRecord {
    return this.consents.get(patientId) ?? { patientId, status: "active" };
  }
}
