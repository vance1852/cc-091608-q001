export type SignalKind = "ppg-summary" | "single-lead-ecg";
export type ReviewDisposition = "artifact" | "contact" | "escalate" | "correct";

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

export interface ClinicalReview {
  reviewId: string;
  episodeId: string;
  reviewerId: string;
  disposition: ReviewDisposition;
  reason: string;
  recordedAt: string;
  correctsReviewId?: string;
}
