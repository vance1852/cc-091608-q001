// 摄入：信封校验、设备上下文盖章、按 packetId 幂等去重。
// 重复数据包（含跨批次重传）只记录审计线索，绝不产生新的信号窗口或事件。

import type { SignalFragment, UploadEnvelope } from "./contracts.ts";
import { assertTimezone, intervalEndMs, parseCapturedAt } from "./time.ts";

export interface StoredPacket {
  fragment: SignalFragment;
  uploadId: string;
  uploadedAtMs: number;
}

export interface IngestResult {
  accepted: SignalFragment[];
  /** 与首次到达的载荷完全一致的重复 packetId。 */
  duplicatePacketIds: string[];
  /** 同一 packetId 但内容冲突，整包拒绝（不会静默当作重复吞掉）。 */
  conflictingPacketIds: string[];
}

export function validateEnvelope(envelope: UploadEnvelope): void {
  if (!envelope.uploadId) throw new Error("envelope.uploadId is required");
  if (!envelope.patientId) throw new Error("envelope.patientId is required");
  const d = envelope.device;
  if (!d?.deviceId) throw new Error("envelope.device.deviceId is required");
  for (const [key, value] of [
    ["firmwareVersion", d.firmwareVersion],
    ["algorithmVersion", d.algorithmVersion],
    ["calibrationVersion", d.calibrationVersion],
    ["timezone", d.timezone],
  ] as const) {
    if (!value) throw new Error(`envelope.device.${key} is required`);
  }
  assertTimezone(d.timezone);
  if (Number.isNaN(Date.parse(envelope.uploadedAt))) {
    throw new Error(`invalid envelope.uploadedAt: ${envelope.uploadedAt}`);
  }
  if (!Array.isArray(envelope.fragments) || envelope.fragments.length === 0) {
    throw new Error("envelope.fragments must be a non-empty array");
  }
  for (const f of envelope.fragments) {
    if (!f.packetId) throw new Error("fragment.packetId is required");
    // 批内允许出现重复 packetId（设备重传）：首次接受，其余按幂等重复处理，不报错。
    parseCapturedAt(f.capturedAt);
    intervalEndMs(parseCapturedAt(f.capturedAt), f.durationSeconds);
    if (f.kind !== "ppg-summary" && f.kind !== "single-lead-ecg") {
      throw new Error(`unsupported fragment kind: ${String(f.kind)}`);
    }
  }
}

/** 结构比对：重复包必须与首次载荷逐字段一致，否则视为冲突。 */
export function samePayload(a: SignalFragment, b: SignalFragment): boolean {
  return (
    a.packetId === b.packetId &&
    a.patientId === b.patientId &&
    a.kind === b.kind &&
    a.capturedAt === b.capturedAt &&
    a.durationSeconds === b.durationSeconds &&
    a.qualityFlags.length === b.qualityFlags.length &&
    a.qualityFlags.every((flag, i) => flag === b.qualityFlags[i]) &&
    JSON.stringify(a.device) === JSON.stringify(b.device)
  );
}

export class PacketStore {
  readonly byId = new Map<string, StoredPacket>();
  /** uploadId -> 每个 packetId 的处置，供时间线与审计回放。 */
  readonly uploads: Readonly<UploadEnvelope>[] = [];
  readonly uploadReceipts = new Map<
    string,
    { accepted: string[]; duplicates: string[]; conflicts: string[]; uploadedAtMs: number }
  >();

  ingest(envelope: UploadEnvelope): IngestResult {
    validateEnvelope(envelope);
    if (this.uploadReceipts.has(envelope.uploadId)) {
      // 同一上传批次重试：整批幂等，原样返回收据。
      const prior = this.uploadReceipts.get(envelope.uploadId)!;
      return {
        accepted: prior.accepted
          .map((id) => this.byId.get(id)?.fragment)
          .filter((x): x is SignalFragment => x !== undefined),
        duplicatePacketIds: [...prior.duplicates],
        conflictingPacketIds: [...prior.conflicts],
      };
    }

    const accepted: SignalFragment[] = [];
    const duplicatePacketIds: string[] = [];
    const conflictingPacketIds: string[] = [];

    for (const input of envelope.fragments) {
      const fragment: SignalFragment = {
        packetId: input.packetId,
        patientId: envelope.patientId,
        kind: input.kind,
        capturedAt: input.capturedAt,
        durationSeconds: input.durationSeconds,
        qualityFlags: [...(input.qualityFlags ?? [])],
        device: envelope.device,
      };
      const existing = this.byId.get(fragment.packetId);
      if (existing) {
        if (samePayload(existing.fragment, fragment)) {
          duplicatePacketIds.push(fragment.packetId);
        } else {
          conflictingPacketIds.push(fragment.packetId);
        }
        continue;
      }
      this.byId.set(fragment.packetId, {
        fragment,
        uploadId: envelope.uploadId,
        uploadedAtMs: Date.parse(envelope.uploadedAt),
      });
      accepted.push(fragment);
    }

    this.uploads.push(envelope);
    this.uploadReceipts.set(envelope.uploadId, {
      accepted: accepted.map((f) => f.packetId),
      duplicates: duplicatePacketIds,
      conflicts: conflictingPacketIds,
      uploadedAtMs: Date.parse(envelope.uploadedAt),
    });

    return { accepted, duplicatePacketIds, conflictingPacketIds };
  }

  allPackets(): StoredPacket[] {
    return [...this.byId.values()];
  }

  patientFragments(patientId: string): StoredPacket[] {
    return [...this.byId.values()]
      .filter((p) => p.fragment.patientId === patientId)
      .sort(
        (a, b) =>
          parseCapturedAt(a.fragment.capturedAt) -
            parseCapturedAt(b.fragment.capturedAt) ||
          a.fragment.packetId.localeCompare(b.fragment.packetId),
      );
  }
}
