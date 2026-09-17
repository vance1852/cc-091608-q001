import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SignalFragment } from "./contracts.js";
import { ReviewService, ServiceError } from "./service.js";
import { Store } from "./store.js";

const DEVICE = {
  deviceId: "watch-01",
  firmwareVersion: "fw-4.2.1",
  algorithmVersion: "afib-algo-2.3.0",
  calibrationVersion: "cal-2026-08",
  timezone: "Asia/Shanghai",
};

function makeService(): ReviewService {
  return new ReviewService(new Store(), () => new Date("2026-09-16T09:00:00+08:00"));
}

function frag(partial: Partial<SignalFragment> & { packetId: string }): SignalFragment {
  return {
    patientId: "patient-a17",
    kind: "ppg-summary",
    capturedAt: "2026-09-15T23:58:20+08:00",
    durationSeconds: 60,
    qualityFlags: [],
    device: { ...DEVICE },
    ...partial,
  };
}

function expectServiceError(fn: () => unknown, code: string, status: number): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ServiceError, `期望 ServiceError，实际: ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return true;
  });
}

describe("数据接收与幂等", () => {
  it("重复 packetId 不产生新事件", () => {
    const svc = makeService();
    const first = svc.ingest(frag({ packetId: "p-001" }));
    const second = svc.ingest(frag({ packetId: "p-001" }));
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.episodeId, first.episodeId);
    assert.equal(second.attempts, 2);
    const episodes = svc.listEpisodes({ patientId: "patient-a17" });
    assert.equal(episodes.length, 1);
    assert.equal(episodes.at(0)?.composition.length, 1);
  });

  it("缺少显式时区偏移的采集时间被拒绝", () => {
    const svc = makeService();
    expectServiceError(
      () => svc.ingest(frag({ packetId: "p-x", capturedAt: "2026-09-15T23:58:20" })),
      "invalid-fragment",
      400,
    );
  });

  it("无法识别的设备时区被拒绝", () => {
    const svc = makeService();
    expectServiceError(
      () => svc.ingest(frag({ packetId: "p-x", device: { ...DEVICE, timezone: "Mars/Olympus" } })),
      "invalid-fragment",
      400,
    );
  });
});

describe("发作归并与跨午夜归属", () => {
  it("跨午夜片段归入起始当地日，心电片段并入同一发作", () => {
    const svc = makeService();
    svc.ingest(frag({ packetId: "p-001", durationSeconds: 190 }));
    svc.ingest(
      frag({
        packetId: "p-002",
        kind: "single-lead-ecg",
        capturedAt: "2026-09-16T00:01:10+08:00",
        durationSeconds: 30,
        qualityFlags: ["motion"],
      }),
    );
    const episodes = svc.listEpisodes({ patientId: "patient-a17" });
    assert.equal(episodes.length, 1);
    const ep = episodes.at(0);
    assert.ok(ep);
    assert.equal(ep.local.crossesLocalMidnight, true);
    assert.equal(ep.local.attributedLocalDate, "2026-09-15");
    assert.equal(ep.local.start.isoLike, "2026-09-15T23:58:20+08:00");
    assert.equal(ep.local.end.isoLike, "2026-09-16T00:01:40+08:00");
    assert.equal(ep.composition.length, 2);
    assert.equal(ep.quality.vigorousMotion, true);
    assert.equal(ep.risk.level, "high");
  });

  it("间隔 ≤5 分钟的提示归并为同一发作，间隔更大则分开", () => {
    const svc = makeService();
    svc.ingest(frag({ packetId: "p-1", capturedAt: "2026-09-15T22:00:00+08:00", durationSeconds: 60 }));
    svc.ingest(frag({ packetId: "p-2", capturedAt: "2026-09-15T22:04:00+08:00", durationSeconds: 60 }));
    svc.ingest(frag({ packetId: "p-3", capturedAt: "2026-09-15T23:00:00+08:00", durationSeconds: 60 }));
    const episodes = svc.listEpisodes({ patientId: "patient-a17" });
    assert.equal(episodes.length, 2);
  });

  it("桥接片段把两个既有发作合并为一个", () => {
    const svc = makeService();
    const a = svc.ingest(frag({ packetId: "p-1", capturedAt: "2026-09-15T22:00:00+08:00", durationSeconds: 60 }));
    const b = svc.ingest(frag({ packetId: "p-2", capturedAt: "2026-09-15T22:20:00+08:00", durationSeconds: 60 }));
    assert.notEqual(a.episodeId, b.episodeId);
    const bridge = svc.ingest(frag({ packetId: "p-3", capturedAt: "2026-09-15T22:02:00+08:00", durationSeconds: 60 * 20 }));
    assert.equal(bridge.episodeId, a.episodeId);
    const episodes = svc.listEpisodes({ patientId: "patient-a17" });
    const active = episodes.filter((e) => e.mergedInto === undefined);
    assert.equal(active.length, 1);
    assert.equal(active.at(0)?.composition.length, 3);
    assert.deepEqual(active.at(0)?.mergedFrom, [b.episodeId]);
  });
});

describe("复核权限与追加更正", () => {
  function escalatedEpisode(svc: ReviewService): string {
    const { episodeId } = svc.ingest(frag({ packetId: "p-1", durationSeconds: 190 }));
    return episodeId;
  }

  it("护士不能 correct，医生不能 escalate", () => {
    const svc = makeService();
    const episodeId = escalatedEpisode(svc);
    expectServiceError(
      () => svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "correct", reason: "x", correctsReviewId: "rev-0001" }),
      "forbidden-disposition",
      403,
    );
    expectServiceError(
      () => svc.addReview({ episodeId, reviewerId: "d1", role: "doctor", disposition: "escalate", reason: "x" }),
      "forbidden-disposition",
      403,
    );
  });

  it("correct 必须指向同一次发作的既有复核", () => {
    const svc = makeService();
    const episodeId = escalatedEpisode(svc);
    expectServiceError(
      () => svc.addReview({ episodeId, reviewerId: "d1", role: "doctor", disposition: "correct", reason: "x" }),
      "invalid-review",
      400,
    );
    expectServiceError(
      () => svc.addReview({ episodeId, reviewerId: "d1", role: "doctor", disposition: "correct", reason: "x", correctsReviewId: "rev-9999" }),
      "invalid-review",
      400,
    );
  });

  it("更正链只追加不改写，当前结论取最新一条 correct", () => {
    const svc = makeService();
    const episodeId = escalatedEpisode(svc);
    const esc = svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "escalate", reason: "请医生判读" });
    const c1 = svc.addReview({ episodeId, reviewerId: "d1", role: "doctor", disposition: "correct", reason: "倾向伪迹", correctsReviewId: esc.reviewId });
    const c2 = svc.addReview({ episodeId, reviewerId: "d1", role: "doctor", disposition: "correct", reason: "复看后确认房颤", correctsReviewId: c1.reviewId });
    const ep = svc.getEpisode(episodeId);
    assert.equal(ep.reviews.length, 3);
    assert.equal(ep.reviews.at(1)?.reason, "倾向伪迹");
    assert.equal(ep.latestInterpretation?.reviewId, c2.reviewId);
  });

  it("标记伪迹关闭发作，新片段落入窗口会重新打开", () => {
    const svc = makeService();
    const { episodeId } = svc.ingest(frag({ packetId: "p-1", durationSeconds: 60, qualityFlags: ["motion"] }));
    svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "artifact", reason: "全程运动伪迹" });
    assert.equal(svc.getEpisode(episodeId).status, "closed-artifact");
    svc.ingest(frag({ packetId: "p-2", capturedAt: "2026-09-15T23:59:00+08:00", durationSeconds: 60 }));
    assert.equal(svc.getEpisode(episodeId).status, "open");
    const types = svc.getTimeline(episodeId).map((e) => e.type);
    assert.ok(types.includes("episode-reopened"));
  });
});

describe("升级依据与联系闭环", () => {
  it("升级事件固化风险依据快照", () => {
    const svc = makeService();
    const { episodeId } = svc.ingest(frag({ packetId: "p-1", durationSeconds: 190 }));
    svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "escalate", reason: "持续疑似发作" });
    const escalated = svc.getTimeline(episodeId).find((e) => e.type === "escalated");
    assert.ok(escalated);
    assert.equal(escalated.statusFrom, "open");
    assert.equal(escalated.statusTo, "escalated");
    const basis = escalated.detail.escalationBasis as { riskLevel: string; riskBasis: string[] };
    assert.equal(basis.riskLevel, "high");
    assert.ok(basis.riskBasis.length > 0);
  });

  it("联系任务从发起到闭环，队列随之清空", () => {
    const svc = makeService();
    const { episodeId } = svc.ingest(frag({ packetId: "p-1" }));
    svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "contact", reason: "电话核实" });
    assert.equal(svc.getEpisode(episodeId).status, "contact-pending");
    const queue = svc.contactQueue();
    assert.equal(queue.length, 1);
    const taskId = queue.at(0)?.taskId ?? "";
    svc.closeContact({ taskId, closedBy: "n1", outcome: "reached", note: "已告知注意事项" });
    assert.equal(svc.contactQueue().length, 0);
    assert.equal(svc.getEpisode(episodeId).status, "contacted");
    expectServiceError(
      () => svc.closeContact({ taskId, closedBy: "n1", outcome: "reached" }),
      "already-closed",
      409,
    );
  });
});

describe("授权撤回", () => {
  it("撤回后临床角色不得读波形，审计保留，新数据被拒收", () => {
    const svc = makeService();
    const { episodeId } = svc.ingest(frag({ packetId: "p-1" }));
    svc.addReview({ episodeId, reviewerId: "n1", role: "nurse", disposition: "escalate", reason: "请医生判读" });
    svc.revokeConsent({ patientId: "patient-a17", revokedBy: "patient-a17", reason: "停止共享" });

    expectServiceError(() => svc.getFragments(episodeId, "nurse"), "waveform-sealed", 403);
    expectServiceError(() => svc.getFragments(episodeId, "doctor"), "waveform-sealed", 403);
    assert.equal(svc.getFragments(episodeId, "auditor").length, 1);
    assert.ok(svc.getAudit("patient-a17").length > 0);
    expectServiceError(
      () => svc.ingest(frag({ packetId: "p-2", capturedAt: "2026-09-16T08:00:00+08:00" })),
      "consent-revoked",
      409,
    );
    expectServiceError(
      () => svc.revokeConsent({ patientId: "patient-a17", revokedBy: "x" }),
      "already-revoked",
      409,
    );
  });
});
