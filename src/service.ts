import type { ClinicalReview, DeviceContext, ReviewDisposition, SignalFragment } from "./contracts.js";
import {
  assessRisk,
  collectQuality,
  latestInterpretation,
  localWindow,
  primaryTimeZone,
  windowTouches,
  type Episode,
  type EpisodeFragment,
  type EpisodeStatus,
  type LocalWindow,
  type QualityEvidence,
  type RiskAssessment,
  type Role,
} from "./domain.js";
import { isValidTimeZone, parseCapturedAt } from "./time.js";
import type { ContactTask, Store, TimelineEvent } from "./store.js";

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface IngestResult {
  packetId: string;
  episodeId: string;
  deduplicated: boolean;
  attempts: number;
}

export interface EpisodeView {
  episodeId: string;
  patientId: string;
  status: EpisodeStatus;
  mergedInto?: string;
  mergedFrom: string[];
  windowUtc: { start: string; end: string };
  deviceTimezone: string;
  local: LocalWindow;
  quality: QualityEvidence;
  risk: RiskAssessment;
  /** 归并说明：每条片段的窗口与来源，解释“为什么算同一次发作”。 */
  composition: Array<{
    packetId: string;
    kind: string;
    capturedAt: string;
    windowUtc: { start: string; end: string };
    device: DeviceContext;
  }>;
  deviceContexts: DeviceContext[];
  reviews: ClinicalReview[];
  latestInterpretation: ClinicalReview | null;
  createdAt: string;
}

export interface ContactQueueItem {
  taskId: string;
  episodeId: string;
  patientId: string;
  openedBy: string;
  openedAt: string;
  reason: string;
  riskLevel: RiskAssessment["level"];
  riskBasis: string[];
}

const NURSE_DISPOSITIONS: ReadonlySet<ReviewDisposition> = new Set(["artifact", "contact", "escalate"]);
const DOCTOR_DISPOSITIONS: ReadonlySet<ReviewDisposition> = new Set(["correct"]);

export class ReviewService {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- 数据接收 ----------

  /** 接收一条信号片段；按 packetId 幂等，重复数据包不产生新事件。 */
  ingest(input: SignalFragment): IngestResult {
    const fragment = this.validateFragment(input);
    const consent = this.store.consents.get(fragment.patientId);
    if (consent?.status === "revoked") {
      throw new ServiceError(
        "consent-revoked",
        `患者 ${fragment.patientId} 已撤回共享授权，不再接收新数据`,
        409,
      );
    }

    const existing = this.store.packets.get(fragment.packetId);
    if (existing) {
      existing.attempts += 1;
      const owner = this.store.episodes.get(existing.episodeId);
      this.store.append({
        at: this.now().toISOString(),
        patientId: existing.patientId,
        ...(owner ? { episodeId: owner.episodeId } : {}),
        type: "duplicate-packet-ignored",
        detail: { packetId: fragment.packetId, attempts: existing.attempts },
      });
      return {
        packetId: fragment.packetId,
        episodeId: existing.episodeId,
        deduplicated: true,
        attempts: existing.attempts,
      };
    }

    const episode = this.attach(fragment);
    this.store.packets.set(fragment.packetId, {
      packetId: fragment.packetId,
      patientId: fragment.patientId,
      episodeId: episode.episodeId,
      firstIngestedAt: this.now().toISOString(),
      attempts: 1,
    });
    return { packetId: fragment.packetId, episodeId: episode.episodeId, deduplicated: false, attempts: 1 };
  }

  private validateFragment(input: SignalFragment): EpisodeFragment {
    const bad = (msg: string): never => {
      throw new ServiceError("invalid-fragment", msg, 400);
    };
    if (typeof input.packetId !== "string" || input.packetId.trim() === "") bad("packetId 不能为空");
    if (typeof input.patientId !== "string" || input.patientId.trim() === "") bad("patientId 不能为空");
    if (input.kind !== "ppg-summary" && input.kind !== "single-lead-ecg") bad(`未知信号类型: ${String(input.kind)}`);
    if (typeof input.capturedAt !== "string") bad("capturedAt 必须是字符串");
    const parsed = parseCapturedAt(input.capturedAt);
    if (parsed === null) {
      throw new ServiceError("invalid-fragment", `capturedAt 缺少显式时区偏移或无法解析: ${input.capturedAt}`, 400);
    }
    const startMs: number = parsed;
    if (typeof input.durationSeconds !== "number" || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
      bad("durationSeconds 必须是正数");
    }
    if (!Array.isArray(input.qualityFlags) || input.qualityFlags.some((f) => typeof f !== "string")) {
      bad("qualityFlags 必须是字符串数组");
    }
    const device = input.device;
    if (!device || typeof device !== "object") bad("缺少 device 上下文");
    for (const key of ["deviceId", "firmwareVersion", "algorithmVersion", "calibrationVersion", "timezone"] as const) {
      if (typeof device[key] !== "string" || device[key].trim() === "") bad(`device.${key} 不能为空`);
    }
    if (!isValidTimeZone(device.timezone)) bad(`无法识别的设备时区: ${device.timezone}`);
    return {
      packetId: input.packetId,
      patientId: input.patientId,
      kind: input.kind,
      capturedAt: input.capturedAt,
      startMs,
      endMs: startMs + input.durationSeconds * 1000,
      durationSeconds: input.durationSeconds,
      qualityFlags: [...input.qualityFlags],
      device: { ...device },
    };
  }

  /** 把片段挂到发作候选上：重叠或相邻（≤5 分钟）即归并，必要时合并多个既有发作。 */
  private attach(fragment: EpisodeFragment): Episode {
    const candidates = this.store
      .episodesOf(fragment.patientId)
      .filter((e) => e.mergedInto === undefined)
      .filter((e) => windowTouches(e, fragment.startMs, fragment.endMs))
      .sort((a, b) => a.episodeId.localeCompare(b.episodeId));

    const primary = candidates.at(0) ?? this.createEpisode(fragment.patientId);
    const wasClosed = primary.status === "closed-artifact";
    primary.fragments.push(fragment);
    primary.fragments.sort((a, b) => a.startMs - b.startMs || a.packetId.localeCompare(b.packetId));
    primary.startMs = Math.min(primary.startMs, fragment.startMs);
    primary.endMs = Math.max(primary.endMs, fragment.endMs);
    this.store.append({
      at: this.now().toISOString(),
      patientId: primary.patientId,
      episodeId: primary.episodeId,
      type: "fragment-attached",
      detail: { packetId: fragment.packetId, kind: fragment.kind },
    });

    for (const other of candidates.slice(1)) {
      this.mergeInto(primary, other);
    }

    if (wasClosed && primary.status === "closed-artifact") {
      const from = primary.status;
      primary.status = "open";
      this.store.append({
        at: this.now().toISOString(),
        patientId: primary.patientId,
        episodeId: primary.episodeId,
        type: "episode-reopened",
        statusFrom: from,
        statusTo: "open",
        detail: { reason: "新片段落入已按伪迹关闭的发作窗口，自动重新打开待复核" },
      });
    }
    return primary;
  }

  private createEpisode(patientId: string): Episode {
    const episode: Episode = {
      episodeId: this.store.nextEpisodeId(),
      patientId,
      startMs: Number.POSITIVE_INFINITY,
      endMs: Number.NEGATIVE_INFINITY,
      fragments: [],
      status: "open",
      reviews: [],
      createdAt: this.now().toISOString(),
      mergedFrom: [],
    };
    this.store.episodes.set(episode.episodeId, episode);
    this.store.append({
      at: this.now().toISOString(),
      patientId,
      episodeId: episode.episodeId,
      type: "episode-opened",
      statusTo: "open",
      detail: {},
    });
    return episode;
  }

  private mergeInto(primary: Episode, other: Episode): void {
    for (const f of other.fragments) {
      if (!primary.fragments.some((p) => p.packetId === f.packetId)) primary.fragments.push(f);
    }
    primary.fragments.sort((a, b) => a.startMs - b.startMs || a.packetId.localeCompare(b.packetId));
    primary.startMs = Math.min(primary.startMs, other.startMs);
    primary.endMs = Math.max(primary.endMs, other.endMs);
    primary.reviews.push(...other.reviews);
    primary.mergedFrom.push(other.episodeId, ...other.mergedFrom);
    other.mergedInto = primary.episodeId;
    this.store.append({
      at: this.now().toISOString(),
      patientId: primary.patientId,
      episodeId: primary.episodeId,
      type: "episodes-merged",
      detail: { absorbed: other.episodeId, into: primary.episodeId },
    });
  }

  // ---------- 临床复核 ----------

  addReview(input: {
    episodeId: string;
    reviewerId: string;
    role: Role;
    disposition: ReviewDisposition;
    reason: string;
    correctsReviewId?: string;
  }): ClinicalReview {
    const episode = this.requireEpisode(input.episodeId);
    if (episode.mergedInto !== undefined) {
      throw new ServiceError("episode-merged", `发作 ${episode.episodeId} 已归并入 ${episode.mergedInto}，请在目标发作上复核`, 409);
    }
    if (typeof input.reviewerId !== "string" || input.reviewerId.trim() === "") {
      throw new ServiceError("invalid-review", "reviewerId 不能为空", 400);
    }
    if (typeof input.reason !== "string" || input.reason.trim() === "") {
      throw new ServiceError("invalid-review", "复核必须填写依据 reason", 400);
    }

    if (input.role === "nurse" && !NURSE_DISPOSITIONS.has(input.disposition)) {
      throw new ServiceError("forbidden-disposition", "护士只能标记伪迹、发起联系或升级给医生", 403);
    }
    if (input.role === "doctor" && !DOCTOR_DISPOSITIONS.has(input.disposition)) {
      throw new ServiceError("forbidden-disposition", "医生只能通过 correct 追加更正，不能改写或新建处置", 403);
    }
    if (input.role === "auditor") {
      throw new ServiceError("forbidden-disposition", "审计角色只读，不能新增复核", 403);
    }

    if (input.disposition === "correct") {
      if (!input.correctsReviewId) {
        throw new ServiceError("invalid-review", "correct 必须携带 correctsReviewId 指向被更正的复核", 400);
      }
      const target = this.store.reviews.get(input.correctsReviewId);
      if (!target || target.episodeId !== episode.episodeId) {
        throw new ServiceError("invalid-review", `被更正的复核 ${input.correctsReviewId} 不存在于该发作`, 400);
      }
    } else if (input.correctsReviewId !== undefined) {
      throw new ServiceError("invalid-review", "只有 correct 可以携带 correctsReviewId", 400);
    }

    const review: ClinicalReview = {
      reviewId: this.store.nextReviewId(),
      episodeId: episode.episodeId,
      reviewerId: input.reviewerId,
      disposition: input.disposition,
      reason: input.reason,
      recordedAt: this.now().toISOString(),
      ...(input.correctsReviewId !== undefined ? { correctsReviewId: input.correctsReviewId } : {}),
    };
    this.store.reviews.set(review.reviewId, review);
    episode.reviews.push(review);

    switch (input.disposition) {
      case "artifact":
        this.transition(episode, "closed-artifact", "review-added", input.reviewerId, {
          reviewId: review.reviewId,
          disposition: "artifact",
          reason: review.reason,
        });
        break;
      case "contact": {
        const task = this.openContact(episode, input.reviewerId, review.reason);
        if (episode.status === "open" || episode.status === "contacted") {
          this.transition(episode, "contact-pending", "review-added", input.reviewerId, {
            reviewId: review.reviewId,
            disposition: "contact",
            reason: review.reason,
            taskId: task.taskId,
          });
        } else {
          this.store.append({
            at: this.now().toISOString(),
            patientId: episode.patientId,
            episodeId: episode.episodeId,
            type: "review-added",
            actor: input.reviewerId,
            detail: { reviewId: review.reviewId, disposition: "contact", reason: review.reason, taskId: task.taskId },
          });
        }
        break;
      }
      case "escalate": {
        const risk = assessRisk(episode);
        const quality = collectQuality(episode.fragments);
        this.transition(episode, "escalated", "escalated", input.reviewerId, {
          reviewId: review.reviewId,
          reason: review.reason,
          // 升级依据快照：风险分层、质量证据与设备上下文随事件一并固化。
          escalationBasis: {
            riskLevel: risk.level,
            riskBasis: risk.basis,
            quality,
            deviceContexts: episode.fragments.map((f) => f.device),
          },
        });
        break;
      }
      case "correct":
        this.store.append({
          at: this.now().toISOString(),
          patientId: episode.patientId,
          episodeId: episode.episodeId,
          type: "correction-appended",
          actor: input.reviewerId,
          detail: {
            reviewId: review.reviewId,
            correctsReviewId: input.correctsReviewId,
            reason: review.reason,
          },
        });
        break;
    }
    return review;
  }

  private transition(
    episode: Episode,
    to: EpisodeStatus,
    type: "review-added" | "escalated",
    actor: string,
    detail: Record<string, unknown>,
  ): void {
    const from = episode.status;
    episode.status = to;
    this.store.append({
      at: this.now().toISOString(),
      patientId: episode.patientId,
      episodeId: episode.episodeId,
      type,
      actor,
      statusFrom: from,
      statusTo: to,
      detail,
    });
  }

  // ---------- 联系闭环 ----------

  private openContact(episode: Episode, openedBy: string, reason: string): ContactTask {
    const existing = [...this.store.contacts.values()].find(
      (t) => t.episodeId === episode.episodeId && t.status === "open",
    );
    if (existing) return existing;
    const task: ContactTask = {
      taskId: this.store.nextContactId(),
      episodeId: episode.episodeId,
      patientId: episode.patientId,
      openedBy,
      openedAt: this.now().toISOString(),
      reason,
      status: "open",
    };
    this.store.contacts.set(task.taskId, task);
    this.store.append({
      at: this.now().toISOString(),
      patientId: episode.patientId,
      episodeId: episode.episodeId,
      type: "contact-opened",
      actor: openedBy,
      detail: { taskId: task.taskId, reason },
    });
    return task;
  }

  closeContact(input: { taskId: string; closedBy: string; outcome: ContactTask["outcome"]; note?: string }): ContactTask {
    const task = this.store.contacts.get(input.taskId);
    if (!task) throw new ServiceError("not-found", `联系任务 ${input.taskId} 不存在`, 404);
    if (task.status === "closed") throw new ServiceError("already-closed", `联系任务 ${input.taskId} 已闭环`, 409);
    if (input.outcome !== "reached" && input.outcome !== "unreachable" && input.outcome !== "refused") {
      throw new ServiceError("invalid-outcome", "outcome 必须是 reached / unreachable / refused", 400);
    }
    task.status = "closed";
    task.closedBy = input.closedBy;
    task.closedAt = this.now().toISOString();
    task.outcome = input.outcome;
    if (input.note !== undefined) task.note = input.note;

    const episode = this.store.episodes.get(task.episodeId);
    const statusFrom = episode?.status;
    if (episode && episode.status === "contact-pending") {
      episode.status = "contacted";
    }
    const transitioned = episode !== undefined && statusFrom !== undefined && statusFrom !== episode.status;
    this.store.append({
      at: this.now().toISOString(),
      patientId: task.patientId,
      episodeId: task.episodeId,
      type: "contact-closed",
      actor: input.closedBy,
      ...(transitioned && episode ? { statusFrom: statusFrom as EpisodeStatus, statusTo: episode.status } : {}),
      detail: { taskId: task.taskId, outcome: input.outcome, ...(input.note !== undefined ? { note: input.note } : {}) },
    });
    return task;
  }

  contactQueue(): ContactQueueItem[] {
    const rank = { high: 0, moderate: 1, low: 2 } as const;
    return [...this.store.contacts.values()]
      .filter((t) => t.status === "open")
      .map((t) => {
        const episode = this.store.episodes.get(t.episodeId);
        const risk = episode ? assessRisk(episode) : { level: "low" as const, basis: [] };
        return {
          taskId: t.taskId,
          episodeId: t.episodeId,
          patientId: t.patientId,
          openedBy: t.openedBy,
          openedAt: t.openedAt,
          reason: t.reason,
          riskLevel: risk.level,
          riskBasis: risk.basis,
        };
      })
      .sort((a, b) => rank[a.riskLevel] - rank[b.riskLevel] || a.openedAt.localeCompare(b.openedAt));
  }

  // ---------- 授权撤回 ----------

  revokeConsent(input: { patientId: string; revokedBy: string; reason?: string }): void {
    const current = this.store.consents.get(input.patientId);
    if (current?.status === "revoked") {
      throw new ServiceError("already-revoked", `患者 ${input.patientId} 的共享授权已撤回`, 409);
    }
    this.store.consents.set(input.patientId, {
      patientId: input.patientId,
      status: "revoked",
      revokedAt: this.now().toISOString(),
      revokedBy: input.revokedBy,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    this.store.append({
      at: this.now().toISOString(),
      patientId: input.patientId,
      type: "consent-revoked",
      actor: input.revokedBy,
      detail: {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        note: "历史审计保留；临床角色自此不得再读取波形，新数据包将被拒收",
      },
    });
  }

  /** 波形读取门禁：授权撤回后，临床角色（护士/医生）被拒，审计角色保留。 */
  assertWaveformAccess(patientId: string, role: Role): void {
    const consent = this.store.consents.get(patientId);
    if (consent?.status === "revoked" && role !== "auditor") {
      throw new ServiceError(
        "waveform-sealed",
        `患者 ${patientId} 已撤回共享授权，临床角色不得再读取波形；审计轨迹仍可查询`,
        403,
      );
    }
  }

  // ---------- 查询 ----------

  listEpisodes(filter: { patientId?: string; status?: EpisodeStatus }): EpisodeView[] {
    return [...this.store.episodes.values()]
      .filter((e) => (filter.patientId ? e.patientId === filter.patientId : true))
      .filter((e) => (filter.status ? e.status === filter.status : true))
      .map((e) => this.viewOf(e));
  }

  getEpisode(episodeId: string): EpisodeView {
    return this.viewOf(this.requireEpisode(episodeId));
  }

  getFragments(episodeId: string, role: Role): EpisodeFragment[] {
    const episode = this.requireEpisode(episodeId);
    this.assertWaveformAccess(episode.patientId, role);
    return episode.fragments;
  }

  getTimeline(episodeId: string): TimelineEvent[] {
    this.requireEpisode(episodeId);
    return this.store.timelineOf(episodeId);
  }

  getAudit(patientId: string): TimelineEvent[] {
    return this.store.auditOf(patientId);
  }

  private requireEpisode(episodeId: string): Episode {
    const episode = this.store.episodes.get(episodeId);
    if (!episode) throw new ServiceError("not-found", `发作 ${episodeId} 不存在`, 404);
    return episode;
  }

  private viewOf(episode: Episode): EpisodeView {
    const deviceContexts = episode.fragments.map((f) => f.device);
    return {
      episodeId: episode.episodeId,
      patientId: episode.patientId,
      status: episode.status,
      ...(episode.mergedInto !== undefined ? { mergedInto: episode.mergedInto } : {}),
      mergedFrom: [...episode.mergedFrom],
      windowUtc: {
        start: new Date(episode.startMs).toISOString(),
        end: new Date(episode.endMs).toISOString(),
      },
      deviceTimezone: primaryTimeZone(episode),
      local: localWindow(episode),
      quality: collectQuality(episode.fragments),
      risk: assessRisk(episode),
      composition: episode.fragments.map((f) => ({
        packetId: f.packetId,
        kind: f.kind,
        capturedAt: f.capturedAt,
        windowUtc: {
          start: new Date(f.startMs).toISOString(),
          end: new Date(f.endMs).toISOString(),
        },
        device: f.device,
      })),
      deviceContexts,
      reviews: [...episode.reviews],
      latestInterpretation: latestInterpretation(episode.reviews),
      createdAt: episode.createdAt,
    };
  }
}
