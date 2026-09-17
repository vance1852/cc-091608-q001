// 领域契约：设备上传、信号片段、发作候选、临床复核、授权与审计。
// 设备算法输出只作为“疑似提示”进入复核流程，不构成诊断；
// 诊断性结论只能由临床角色通过复核记录追加。

export type SignalKind = "ppg-summary" | "single-lead-ecg";
export type ReviewDisposition = "artifact" | "contact" | "escalate" | "correct";

/** 佩戴 / 采集质量标记（描述信号质量，不是节律诊断结论）。 */
export type QualityFlag =
  | "loose-strap"
  | "motion"
  | "exercise"
  | "signal-gap"
  // 设备固件可能下发尚未在此枚举中的新标记，仍需原样保留。
  | (string & {});

export type RiskLevel = "screening" | "watch" | "urgent";

export type EpisodeStatus =
  // 尚未有任何处置，进入待联系队列
  | "open"
  // 已发起联系，尚未闭环
  | "awaiting-contact"
  // 联系已触达并完成闭环
  | "closed-contact"
  // 护士判定为伪迹
  | "artifact"
  // 已升级医生
  | "escalated"
  // 医生已追加解释（裁定终态，但原始记录不被覆盖）
  | "explained";

export type ActorRole = "nurse" | "physician" | "audit" | "patient" | "system";

export interface DeviceContext {
  deviceId: string;
  firmwareVersion: string;
  algorithmVersion: string;
  calibrationVersion: string;
  timezone: string;
}

export interface SignalFragment {
  packetId: string;
  patientId: string;
  kind: SignalKind;
  capturedAt: string;
  durationSeconds: number;
  qualityFlags: string[];
  device: DeviceContext;
}

/** 单次上传信封：设备上下文随整批数据盖戳，片段只保留原始采集字段。 */
export interface UploadEnvelope {
  uploadId: string;
  patientId: string;
  device: DeviceContext;
  /** 服务端接收时间（UTC ISO-8601）。 */
  uploadedAt: string;
  fragments: UploadFragmentInput[];
}

export interface UploadFragmentInput {
  packetId: string;
  kind: SignalKind;
  /** 原始采集时间，必须带 UTC 偏移，服务端不得改写成接收时间。 */
  capturedAt: string;
  durationSeconds: number;
  qualityFlags?: QualityFlag[];
}

export interface ContactResult {
  channel: "phone" | "message" | "clinic";
  reached: boolean;
  outcome: string;
  /** 仅当 reached=true 且随访事项确认完成时才允许闭环。 */
  closedLoop: boolean;
  at: string;
}

export interface ClinicalReview {
  reviewId: string;
  episodeId: string;
  reviewerId: string;
  disposition: ReviewDisposition;
  reason: string;
  recordedAt: string;
  /** disposition=correct 时必填：被更正的既有复核记录。 */
  correctsReviewId?: string;
  /** disposition=contact 时的联系结果（未触达也必须留痕）。 */
  contactResult?: ContactResult;
  /** disposition=correct 时医生追加的解释，只能追加，不覆盖历史。 */
  interpretation?: string;
}

export type QualityBasisType = "loose-strap" | "exercise" | "signal-gap";

export interface QualityEvidence {
  type: QualityBasisType;
  /** 设备上报的原始标记，逗号分隔，便于回溯。 */
  rawFlags: string[];
  sourcePacketIds: string[];
  /** 证据覆盖区间（UTC ISO）。 */
  startsAt: string;
  endsAt: string;
  detail: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  /** 每一条加 / 减分理由，保证升级依据可解释。 */
  basis: string[];
}

export interface EpisodeProvenance {
  deviceId: string;
  firmwareVersion: string;
  algorithmVersion: string;
  calibrationVersion: string;
  timezone: string;
}

export interface EpisodeCandidate {
  episodeId: string;
  patientId: string;
  /** 跨午夜时使用设备本地时区给出起止日期归属。 */
  localStartDate: string;
  localEndDate: string;
  timezone: string;
  crossedMidnight: boolean;
  startCapturedAt: string;
  endCapturedAt: string;
  /** 提示合并后的累计疑似覆盖时长（去重叠，秒）。 */
  coveredDurationSeconds: number;
  mergedHintCount: number;
  memberPacketIds: string[];
  ppgPacketIds: string[];
  ecgPacketIds: string[];
  qualityEvidence: QualityEvidence[];
  risk: RiskAssessment;
  provenance: EpisodeProvenance;
  /** 该候选涉及的全部设备上下文（发作跨固件升级时不止一个），provenance 取最早 PPG 来源。 */
  sourceContexts: EpisodeProvenance[];
  status: EpisodeStatus;
  /** 首次被服务端观察到的时间（该候选最早片段的上传时间）。 */
  firstObservedAt: string;
}

export type TimelineEntryType =
  | "candidate-opened"
  | "signal"
  | "upload"
  | "review"
  | "consent";

export interface TimelineEntry {
  at: string;
  /** 用设备时区渲染的本地时间，仅用于展示。 */
  localLabel: string;
  type: TimelineEntryType;
  title: string;
  detail?: string;
  packetId?: string;
  reviewId?: string;
  fromStatus?: EpisodeStatus;
  toStatus?: EpisodeStatus;
}

export interface EpisodeTimeline {
  episode: EpisodeCandidate;
  entries: TimelineEntry[];
}

export interface ContactQueue {
  /** 尚未发起首次联系，按风险降序。 */
  pending: EpisodeCandidate[];
  /** 已联系但未闭环，需要继续跟进。 */
  inProgress: EpisodeCandidate[];
}

export interface ConsentState {
  patientId: string;
  sharingEnabled: boolean;
  grantedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

export interface AuditEntry {
  auditId: string;
  at: string;
  actorId: string;
  actorRole: ActorRole;
  action: string;
  patientId?: string;
  episodeId?: string;
  detail?: string;
  denied?: boolean;
  denialReason?: string;
}
