// 复核服务：在摄入与发作聚类之上叠加临床工作流。
//
// 边界约定：
// - 设备算法的“疑似房颤”只决定风险分层输入，诊断结论只能由医生以追加更正形式写入；
// - 复核记录只追加，不修改、不删除；医生解释通过 correctsReviewId 形成更正链；
// - 患者撤回共享授权后，临床角色对该患者的读取与处置全部拒绝（拒绝也留审计），
//   审计角色仍可读取历史审计与状态时间线；审计日志无删除接口；
// - 联系未触达 / 未闭环不得标记为完成，闭环条件由 ContactResult.closedLoop 显式给出。

import type {
  ActorRole,
  AuditEntry,
  ClinicalReview,
  ConsentState,
  ContactQueue,
  ContactResult,
  EpisodeCandidate,
  EpisodeStatus,
  EpisodeTimeline,
  TimelineEntry,
  TimelineEntryType,
  UploadEnvelope,
} from "./contracts.ts";
import { PacketStore, type IngestResult } from "./ingest.ts";
import { buildEpisodes } from "./episodes.ts";
import { localLabel, parseCapturedAt, toIsoUtc } from "./time.ts";

export class AccessDenied extends Error {
  readonly actorId: string;
  readonly actorRole: ActorRole;
  constructor(actorId: string, actorRole: ActorRole, reason: string) {
    super(reason);
    this.name = "AccessDenied";
    this.actorId = actorId;
    this.actorRole = actorRole;
  }
}

export class InvalidTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransition";
  }
}

export interface Requester {
  id: string;
  role: ActorRole;
}

export interface EpisodeDetail {
  episode: EpisodeCandidate;
  fragments: Array<{
    packetId: string;
    kind: string;
    capturedAt: string;
    localCapturedAt: string;
    durationSeconds: number;
    qualityFlags: string[];
    uploadId: string;
    uploadedAt: string;
    device: EpisodeCandidate["provenance"];
  }>;
  reviews: ClinicalReview[];
  timeline: EpisodeTimeline;
  consent: ConsentState;
}

interface StatusChange {
  from: EpisodeStatus;
  to: EpisodeStatus;
  reviewId: string;
  atMs: number;
}

const DISPOSITION_LABEL: Record<ClinicalReview["disposition"], string> = {
  artifact: "标记伪迹",
  contact: "发起联系",
  escalate: "升级医生",
  correct: "医生追加解释 / 更正",
};

export class ReviewService {
  private readonly packets = new PacketStore();
  private readonly reviews = new Map<string, ClinicalReview>(); // reviewId -> review
  private readonly reviewsByEpisode = new Map<string, string[]>();
  private readonly statusByEpisode = new Map<string, EpisodeStatus>();
  private readonly changesByEpisode = new Map<string, StatusChange[]>();
  private readonly consents = new Map<string, ConsentState>();
  private readonly audit: AuditEntry[] = [];
  private reviewSeq = 0;
  private auditSeq = 0;

  // ---------- 摄入 ----------

  ingest(envelope: UploadEnvelope, actor: Requester = { id: "device-gateway", role: "system" }): IngestResult {
    const result = this.packets.ingest(envelope);
    this.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: "ingest",
      patientId: envelope.patientId,
      detail:
        `upload=${envelope.uploadId} accepted=${result.accepted.length} ` +
        `duplicates=[${result.duplicatePacketIds.join(",")}] ` +
        `conflicts=[${result.conflictingPacketIds.join(",")}]`,
    });
    if (result.conflictingPacketIds.length > 0) {
      this.log({
        actorId: actor.id,
        actorRole: actor.role,
        action: "ingest-conflict-rejected",
        patientId: envelope.patientId,
        detail: `packetId(s) reused with different payload: ${result.conflictingPacketIds.join(",")}`,
      });
    }
    return result;
  }

  // ---------- 授权 ----------

  grantConsent(patientId: string, at: string, actorId = patientId): ConsentState {
    if (this.consents.has(patientId) && this.consents.get(patientId)!.sharingEnabled) {
      return this.consents.get(patientId)!;
    }
    const state: ConsentState = { patientId, sharingEnabled: true, grantedAt: at };
    this.consents.set(patientId, state);
    this.log({
      actorId,
      actorRole: "patient",
      action: "consent-granted",
      patientId,
    });
    return state;
  }

  revokeConsent(patientId: string, reason: string, at: string, actorId = patientId): ConsentState {
    const prior = this.consents.get(patientId);
    const state: ConsentState = { patientId, sharingEnabled: false, revokedAt: at, revokeReason: reason };
    if (prior?.grantedAt !== undefined) state.grantedAt = prior.grantedAt;
    this.consents.set(patientId, state);
    this.log({
      actorId,
      actorRole: "patient",
      action: "consent-revoked",
      patientId,
      detail: reason,
    });
    return state;
  }

  consentOf(patientId: string): ConsentState {
    return (
      this.consents.get(patientId) ?? { patientId, sharingEnabled: true }
    );
  }

  // ---------- 读模型 ----------

  /** 重新派生发作候选并叠加当前状态；episodeId 由首条提示的 packetId 确定性生成。 */
  private episodes(): EpisodeCandidate[] {
    const derived = buildEpisodes(this.packets);
    for (const ep of derived) {
      const status = this.statusByEpisode.get(ep.episodeId);
      if (status) ep.status = status;
    }
    return derived;
  }

  private requireEpisode(episodeId: string): EpisodeCandidate {
    const ep = this.episodes().find((e) => e.episodeId === episodeId);
    if (!ep) throw new InvalidTransition(`episode not found: ${episodeId}`);
    return ep;
  }

  private assertClinicalReadAllowed(actor: Requester, ep: EpisodeCandidate): void {
    if (actor.role !== "nurse" && actor.role !== "physician") {
      throw new AccessDenied(actor.id, actor.role, "只有临床角色可以读取发作明细");
    }
    if (!this.consentOf(ep.patientId).sharingEnabled) {
      this.deny(
        actor,
        "read-episode",
        ep,
        "患者已撤回共享授权：临床角色不得读取波形，历史审计仍保留",
      );
      throw new AccessDenied(
        actor.id,
        actor.role,
        `患者 ${ep.patientId} 已撤回共享授权，临床访问被拒绝`,
      );
    }
  }

  /** 护士工作台视角：撤回授权的患者整体消失，不进入任何队列。 */
  listForClinical(actor: Requester): EpisodeCandidate[] {
    if (actor.role !== "nurse" && actor.role !== "physician") {
      throw new AccessDenied(actor.id, actor.role, "只有临床角色可以列出发作");
    }
    return this.episodes().filter((e) => this.consentOf(e.patientId).sharingEnabled);
  }

  /** 审计 / 管理视角：含已撤回患者，并显式标注。 */
  listAll(): Array<EpisodeCandidate & { consentRevoked: boolean }> {
    return this.episodes().map((e) => ({
      ...e,
      consentRevoked: !this.consentOf(e.patientId).sharingEnabled,
    }));
  }

  contactQueue(actor: Requester): ContactQueue {
    if (actor.role !== "nurse") {
      throw new AccessDenied(actor.id, actor.role, "只有随访护士可以获取待联系队列");
    }
    const rank = (e: EpisodeCandidate) => -e.risk.score * 1e13 + parseCapturedAt(e.startCapturedAt);
    const visible = this.listForClinical(actor);
    const pending = visible
      .filter((e) => e.status === "open")
      .sort((a, b) => rank(a) - rank(b));
    const inProgress = visible
      .filter((e) => e.status === "awaiting-contact")
      .sort((a, b) => rank(a) - rank(b));
    return { pending, inProgress };
  }

  episodeDetail(actor: Requester, episodeId: string): EpisodeDetail {
    const ep = this.requireEpisode(episodeId);
    this.assertClinicalReadAllowed(actor, ep);

    const stored = this.packets
      .patientFragments(ep.patientId)
      .filter((p) => ep.memberPacketIds.includes(p.fragment.packetId));
    const fragments = stored.map((p) => ({
      packetId: p.fragment.packetId,
      kind: p.fragment.kind,
      capturedAt: p.fragment.capturedAt,
      localCapturedAt: localLabel(
        parseCapturedAt(p.fragment.capturedAt),
        p.fragment.device.timezone,
      ),
      durationSeconds: p.fragment.durationSeconds,
      qualityFlags: [...p.fragment.qualityFlags],
      uploadId: p.uploadId,
      uploadedAt: toIsoUtc(p.uploadedAtMs),
      device: {
        deviceId: p.fragment.device.deviceId,
        firmwareVersion: p.fragment.device.firmwareVersion,
        algorithmVersion: p.fragment.device.algorithmVersion,
        calibrationVersion: p.fragment.device.calibrationVersion,
        timezone: p.fragment.device.timezone,
      },
    }));

    return {
      episode: ep,
      fragments,
      reviews: this.reviewList(episodeId),
      timeline: this.timelineOf(ep),
      consent: this.consentOf(ep.patientId),
    };
  }

  /** 审计角色专用：授权撤回后仍可读取状态时间线与复核链，但每次读取留痕。 */
  auditTimeline(actor: Requester, episodeId: string): EpisodeTimeline {
    if (actor.role !== "audit") {
      throw new AccessDenied(actor.id, actor.role, "该接口仅审计角色可用");
    }
    const ep = this.requireEpisode(episodeId);
    this.log({
      actorId: actor.id,
      actorRole: "audit",
      action: "audit-read-timeline",
      patientId: ep.patientId,
      episodeId,
    });
    return this.timelineOf(ep);
  }

  private reviewList(episodeId: string): ClinicalReview[] {
    return (this.reviewsByEpisode.get(episodeId) ?? [])
      .map((id) => this.reviews.get(id)!)
      .sort((a, b) => parseCapturedAt(a.recordedAt) - parseCapturedAt(b.recordedAt));
  }

  private timelineOf(ep: EpisodeCandidate): EpisodeTimeline {
    const entries: TimelineEntry[] = [];
    const startMs = parseCapturedAt(ep.startCapturedAt);
    entries.push({
      at: ep.startCapturedAt,
      localLabel: localLabel(startMs, ep.timezone),
      type: "candidate-opened",
      title: `合并 ${ep.mergedHintCount} 条相邻 / 重叠提示形成发作候选`,
      detail: `风险 ${ep.risk.level}（${ep.risk.score} 分），去重叠覆盖 ${ep.coveredDurationSeconds} 秒`,
    });

    for (const packetId of ep.memberPacketIds) {
      const stored = this.packets.byId.get(packetId);
      if (!stored) continue;
      const f = stored.fragment;
      const atMs = parseCapturedAt(f.capturedAt);
      const isEcg = f.kind === "single-lead-ecg";
      entries.push({
        at: f.capturedAt,
        localLabel: localLabel(atMs, f.device.timezone),
        type: "signal",
        packetId: f.packetId,
        title: isEcg
          ? `按需单导联 ECG ${f.durationSeconds} 秒`
          : `PPG 疑似提示 ${f.durationSeconds} 秒`,
        detail:
          f.qualityFlags.length > 0 ? `质量标记：${f.qualityFlags.join(", ")}` : "无质量标记",
      });
    }

    for (const review of this.reviewList(ep.episodeId)) {
      const change = this.changesByEpisode
        .get(ep.episodeId)
        ?.find((c) => c.reviewId === review.reviewId);
      const detailParts = [review.reason];
      if (review.contactResult) {
        detailParts.push(
          `联系渠道=${review.contactResult.channel} 触达=${review.contactResult.reached ? "是" : "否"} ` +
            `闭环=${review.contactResult.closedLoop ? "是" : "否"}：${review.contactResult.outcome}`,
        );
      }
      if (review.interpretation) detailParts.push(`医生解释：${review.interpretation}`);
      if (review.correctsReviewId) detailParts.push(`更正记录：${review.correctsReviewId}`);
      const entry: TimelineEntry = {
        at: review.recordedAt,
        localLabel: localLabel(parseCapturedAt(review.recordedAt), ep.timezone),
        type: "review",
        reviewId: review.reviewId,
        title: `${DISPOSITION_LABEL[review.disposition]}（${review.reviewerId}）`,
        detail: detailParts.join("\n"),
      };
      if (change) {
        entry.fromStatus = change.from;
        entry.toStatus = change.to;
      }
      entries.push(entry);
    }

    const order: Record<TimelineEntryType, number> = {
      "candidate-opened": 0,
      signal: 1,
      upload: 2,
      review: 3,
      consent: 4,
    };
    entries.sort((a, b) => {
      const d = parseCapturedAt(a.at) - parseCapturedAt(b.at);
      return d !== 0 ? d : order[a.type] - order[b.type];
    });
    return { episode: ep, entries };
  }

  // ---------- 临床处置 ----------

  markArtifact(actor: Requester, episodeId: string, reason: string, at: string): ClinicalReview {
    this.requireNurse(actor);
    const ep = this.requireEpisode(episodeId);
    this.assertClinicalActionAllowed(actor, ep);
    if (ep.status === "artifact" || ep.status === "escalated" || ep.status === "explained") {
      throw new InvalidTransition(
        `发作 ${episodeId} 当前状态 ${ep.status}，不能由护士直接标记伪迹`,
      );
    }
    return this.appendReview(actor, ep, "artifact", reason, at, {}, "artifact");
  }

  recordContact(
    actor: Requester,
    episodeId: string,
    reason: string,
    contact: ContactResult,
    at: string,
  ): ClinicalReview {
    this.requireNurse(actor);
    const ep = this.requireEpisode(episodeId);
    this.assertClinicalActionAllowed(actor, ep);
    if (ep.status === "artifact" || ep.status === "escalated" || ep.status === "explained") {
      throw new InvalidTransition(`发作 ${episodeId} 当前状态 ${ep.status}，不再进入联系流程`);
    }
    if (contact.closedLoop && !contact.reached) {
      throw new InvalidTransition("未触达患者不允许闭环");
    }
    if (Number.isNaN(Date.parse(contact.at))) {
      throw new Error(`invalid contact.at: ${contact.at}`);
    }
    const to: EpisodeStatus = contact.closedLoop ? "closed-contact" : "awaiting-contact";
    return this.appendReview(actor, ep, "contact", reason, at, { contactResult: contact }, to);
  }

  escalate(actor: Requester, episodeId: string, reason: string, at: string): ClinicalReview {
    this.requireNurse(actor);
    const ep = this.requireEpisode(episodeId);
    this.assertClinicalActionAllowed(actor, ep);
    if (ep.status === "escalated" || ep.status === "explained") {
      throw new InvalidTransition(`发作 ${episodeId} 已在医生处理中（${ep.status}）`);
    }
    return this.appendReview(actor, ep, "escalate", reason, at, {}, "escalated");
  }

  physicianCorrect(
    actor: Requester,
    episodeId: string,
    correctsReviewId: string,
    interpretation: string,
    reason: string,
    at: string,
  ): ClinicalReview {
    if (actor.role !== "physician") {
      throw new AccessDenied(actor.id, actor.role, "只有医生可以追加解释");
    }
    const ep = this.requireEpisode(episodeId);
    this.assertClinicalActionAllowed(actor, ep);
    const target = this.reviews.get(correctsReviewId);
    if (!target || target.episodeId !== episodeId) {
      throw new InvalidTransition(
        `correctsReviewId 必须指向本发作的既有复核记录：${correctsReviewId}`,
      );
    }
    if (!interpretation.trim()) {
      throw new InvalidTransition("医生解释不能为空（解释只能追加，不能留空覆盖）");
    }
    // 医生解释始终追加；无论当前状态如何，记录后状态归为 explained。
    return this.appendReview(
      actor,
      ep,
      "correct",
      reason,
      at,
      { correctsReviewId, interpretation },
      "explained",
    );
  }

  // ---------- 审计 ----------

  auditLog(actor: Requester): AuditEntry[] {
    if (actor.role !== "audit") {
      throw new AccessDenied(actor.id, actor.role, "只有审计角色可以导出审计日志");
    }
    return [...this.audit];
  }

  // ---------- 内部 ----------

  private requireNurse(actor: Requester): void {
    if (actor.role !== "nurse") {
      throw new AccessDenied(actor.id, actor.role, "只有随访护士可以执行该操作");
    }
  }

  private assertClinicalActionAllowed(actor: Requester, ep: EpisodeCandidate): void {
    if (!this.consentOf(ep.patientId).sharingEnabled) {
      this.deny(actor, "clinical-action", ep, "患者已撤回共享授权，临床处置被冻结");
      throw new AccessDenied(
        actor.id,
        actor.role,
        `患者 ${ep.patientId} 已撤回共享授权，处置被拒绝`,
      );
    }
  }

  private appendReview(
    actor: Requester,
    ep: EpisodeCandidate,
    disposition: ClinicalReview["disposition"],
    reason: string,
    at: string,
    extra: Partial<ClinicalReview>,
    to: EpisodeStatus,
  ): ClinicalReview {
    if (Number.isNaN(Date.parse(at))) throw new Error(`invalid recordedAt: ${at}`);
    const reviewId = `rev-${++this.reviewSeq}`;
    const review: ClinicalReview = {
      reviewId,
      episodeId: ep.episodeId,
      reviewerId: actor.id,
      disposition,
      reason,
      recordedAt: at,
      ...extra,
    };
    this.reviews.set(reviewId, review);
    const list = this.reviewsByEpisode.get(ep.episodeId) ?? [];
    list.push(reviewId);
    this.reviewsByEpisode.set(ep.episodeId, list);

    const from = this.statusByEpisode.get(ep.episodeId) ?? "open";
    this.statusByEpisode.set(ep.episodeId, to);
    const changes = this.changesByEpisode.get(ep.episodeId) ?? [];
    changes.push({ from, to, reviewId, atMs: Date.parse(at) });
    this.changesByEpisode.set(ep.episodeId, changes);

    this.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: `review:${disposition}`,
      patientId: ep.patientId,
      episodeId: ep.episodeId,
      detail: `${from} -> ${to}；${reason}`,
    });
    return review;
  }

  private deny(
    actor: Requester,
    action: string,
    ep: EpisodeCandidate,
    reason: string,
  ): void {
    this.log({
      actorId: actor.id,
      actorRole: actor.role,
      action: `denied:${action}`,
      patientId: ep.patientId,
      episodeId: ep.episodeId,
      denied: true,
      denialReason: reason,
    });
  }

  private log(entry: {
    actorId: string;
    actorRole: ActorRole;
    action: string;
    patientId?: string;
    episodeId?: string;
    detail?: string;
    denied?: boolean;
    denialReason?: string;
  }): void {
    this.audit.push({
      auditId: `aud-${++this.auditSeq}`,
      at: toIsoUtc(Date.now()),
      ...entry,
    });
  }
}
