// 样例回放：加载 fixtures/night-events.json，演示并自检以下能力：
//   1. 跨午夜事件按设备时区正确归属；
//   2. 相邻 / 重叠提示合并，重复数据包不制造新事件；
//   3. 松动、运动、缺口作为质量依据展示，风险升级逐条给出理由；
//   4. 护士标记伪迹 / 发起联系（未触达不闭环）/ 升级医生，医生只能追加解释；
//   5. 待联系队列随处置推进；
//   6. 患者撤回授权后临床读取被拒绝且留痕，审计仍可读取时间线。
//
// 运行：node --experimental-strip-types src/replay.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  EpisodeCandidate,
  EpisodeTimeline,
  UploadEnvelope,
} from "./contracts.ts";
import { AccessDenied, InvalidTransition, ReviewService, type Requester } from "./service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "fixtures", "night-events.json"), "utf8"),
) as {
  patientId: string;
  device: UploadEnvelope["device"];
  upload: { uploadId: string; uploadedAt: string };
  packets: UploadEnvelope["fragments"];
  extraBatches: UploadEnvelope[];
};

const nurse: Requester = { id: "nurse-lin", role: "nurse" };
const physician: Requester = { id: "dr-zhou", role: "physician" };
const auditor: Requester = { id: "auditor-01", role: "audit" };

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printEpisode(ep: EpisodeCandidate): void {
  console.log(
    `\n[${ep.episodeId}] 患者 ${ep.patientId}  状态=${ep.status}  风险=${ep.risk.level}(${ep.risk.score})`,
  );
  console.log(
    `  本地归属 ${ep.localStartDate} → ${ep.localEndDate}（${ep.timezone}）跨午夜=${ep.crossedMidnight}`,
  );
  console.log(`  UTC ${ep.startCapturedAt} → ${ep.endCapturedAt}`);
  console.log(
    `  合并提示 ${ep.mergedHintCount} 条，去重叠覆盖 ${ep.coveredDurationSeconds}s；` +
      `PPG=[${ep.ppgPacketIds.join(",")}] ECG=[${ep.ecgPacketIds.join(",")}]`,
  );
  console.log(
    `  溯源 设备=${ep.provenance.deviceId} fw=${ep.provenance.firmwareVersion} ` +
      `algo=${ep.provenance.algorithmVersion} cal=${ep.provenance.calibrationVersion}`,
  );
  if (ep.qualityEvidence.length > 0) {
    for (const q of ep.qualityEvidence) {
      console.log(`  质量依据[${q.type}] 包=[${q.sourcePacketIds.join(",")}] ${q.detail}`);
    }
  }
  for (const b of ep.risk.basis) console.log(`   ${b}`);
}

function printTimeline(tl: EpisodeTimeline): void {
  for (const e of tl.entries) {
    const transition =
      e.fromStatus && e.toStatus ? `  [${e.fromStatus} → ${e.toStatus}]` : "";
    console.log(`  ${e.localLabel}  ${e.title}${transition}`);
    if (e.detail) console.log(`      ${e.detail.replaceAll("\n", "\n      ")}`);
  }
}

// ---------- 构建服务并摄入 ----------

const service = new ReviewService();

const mainEnvelope: UploadEnvelope = {
  uploadId: fixture.upload.uploadId,
  patientId: fixture.patientId,
  device: fixture.device,
  uploadedAt: fixture.upload.uploadedAt,
  fragments: fixture.packets,
};

section("摄入：主批次（批内含 1 条重传）");
const firstIngest = service.ingest(mainEnvelope);
console.log(
  `accepted=${firstIngest.accepted.length} duplicates=[${firstIngest.duplicatePacketIds.join(",")}] ` +
    `conflicts=[${firstIngest.conflictingPacketIds.join(",")}]`,
);
check("批内重复 p-001 被识别为幂等重复", firstIngest.duplicatePacketIds.join() === "p-001");
check("主批次实际接受 6 个唯一数据包", firstIngest.accepted.length === 6);

section("摄入：同一 uploadId 重试（整批幂等）");
const retryIngest = service.ingest(mainEnvelope);
check("重试不新增数据包", retryIngest.accepted.length === 6);
check("重试仍返回 p-001 重复", retryIngest.duplicatePacketIds.join() === "p-001");

section("摄入：另一批次只重传 p-001，外加新 ECG（跨批次重传）");
const retransmit: UploadEnvelope = {
  uploadId: "u-20260916-a17-retry",
  patientId: fixture.patientId,
  device: fixture.device,
  uploadedAt: "2026-09-15T16:20:00Z",
  fragments: [
    fixture.packets[0]!,
    {
      packetId: "p-007",
      kind: "single-lead-ecg",
      capturedAt: "2026-09-16T00:00:30+08:00",
      durationSeconds: 30,
      qualityFlags: [],
    },
  ],
};
const retry2 = service.ingest(retransmit);
check("跨批次重传 p-001 不制造新事件", retry2.accepted.length === 1 && retry2.duplicatePacketIds[0] === "p-001");
check("新 ECG p-007 被接受", retry2.accepted[0]?.packetId === "p-007");

section("摄入：同一 packetId 携带不同载荷（必须拒绝，不能静默覆盖）");
const tampered: UploadEnvelope = {
  uploadId: "u-20260916-a17-tampered",
  patientId: fixture.patientId,
  device: fixture.device,
  uploadedAt: "2026-09-15T16:21:00Z",
  fragments: [
    {
      packetId: "p-001",
      kind: "ppg-summary",
      capturedAt: "2026-09-15T23:59:59+08:00", // 时间被篡改
      durationSeconds: 190,
      qualityFlags: [],
    },
  ],
};
const conflictResult = service.ingest(tampered);
check("冲突载荷进入 conflictingPacketIds", conflictResult.conflictingPacketIds[0] === "p-001");
check("冲突载荷不被接受", conflictResult.accepted.length === 0);

section("摄入：其他患者夜间批次");
for (const batch of fixture.extraBatches) {
  const r = service.ingest(batch);
  console.log(`  ${batch.uploadId}（${batch.patientId}）accepted=${r.accepted.length}`);
}

section("发作候选与风险解释");
const episodes = service.listForClinical(nurse);
episodes.forEach(printEpisode);

const a17First = episodes.find((e) => e.episodeId === "ep:patient-a17:p-001")!;
const a17Motion = episodes.find((e) => e.episodeId === "ep:patient-a17:p-005")!;
const b02 = episodes.find((e) => e.episodeId.startsWith("ep:patient-b02"))!;
const c03 = episodes.find((e) => e.episodeId.startsWith("ep:patient-c03"))!;

check("a17 主发作跨午夜", a17First.crossedMidnight === true);
check("a17 主发作本地起日 = 2026-09-15", a17First.localStartDate === "2026-09-15");
check("a17 主发作本地止日 = 2026-09-16", a17First.localEndDate === "2026-09-16");
check("a17 主发作合并 3 条提示", a17First.mergedHintCount === 3, `实际 ${a17First.mergedHintCount}`);
check("a17 主发作挂载 2 段按需 ECG（p-002 运动 + p-007 干净）", a17First.ecgPacketIds.join() === "p-002,p-007");
check("a17 主发作保留松动依据", a17First.qualityEvidence.some((q) => q.type === "loose-strap"));
check("a17 主发作保留运动依据", a17First.qualityEvidence.some((q) => q.type === "exercise"));
check("a17 主发作风险 urgent（长持续 + 干净 ECG）", a17First.risk.level === "urgent", `score=${a17First.risk.score}`);
check("a17 凌晨运动簇为 screening", a17Motion.risk.level === "screening", `score=${a17Motion.risk.score}`);
check("a17 凌晨运动簇带信号缺口依据", a17Motion.qualityEvidence.some((q) => q.type === "signal-gap"));
check("b02 长发作 urgent", b02.risk.level === "urgent", `score=${b02.risk.score}`);
check("c03 为 watch（缺口减分）", c03.risk.level === "watch", `score=${c03.risk.score}`);
check("c03 两段相邻提示被合并为 1 个候选", c03.mergedHintCount === 2);
check("溯源保留算法/固件/校准版本", a17First.provenance.algorithmVersion === "af-pgx-3.1");

// ---------- 待联系队列 ----------

section("待联系队列（周一上班时）");
let queue = service.contactQueue(nurse);
console.log(`待首次联系 ${queue.pending.length}：${queue.pending.map((e) => `${e.episodeId}(${e.risk.score})`).join(", ")}`);
console.log(`联系进行中 ${queue.inProgress.length}`);
check("队列按风险降序：两个 urgent 在前，且同分按开始时间早者优先", queue.pending[0]?.episodeId === a17First.episodeId);
check("b02 紧随其后", queue.pending[1]?.episodeId === b02.episodeId);
check("watch / screening 不排在 urgent 之前", queue.pending.slice(0, 2).every((e) => e.risk.level === "urgent"));
check("screening 伪迹簇也在队列中等待人工判断", queue.pending.some((e) => e.episodeId === a17Motion.episodeId));

// ---------- b02：先未触达，再触达闭环 ----------

section("联系闭环：b02 首次未触达");
const call1 = service.recordContact(
  nurse,
  b02.episodeId,
  "夜间长时段提示，电话核实",
  { channel: "phone", reached: false, outcome: "无人接听，短信提醒回电", closedLoop: false, at: "2026-09-15T18:05:00Z" },
  "2026-09-15T18:05:00Z",
);
queue = service.contactQueue(nurse);
check("未触达后状态 awaiting-contact", service.listForClinical(nurse).find((e) => e.episodeId === b02.episodeId)!.status === "awaiting-contact");
check("未触达发作进入进行中队列", queue.inProgress.some((e) => e.episodeId === b02.episodeId));
let blocked = false;
try {
  service.recordContact(
    nurse,
    b02.episodeId,
    "非法闭环尝试",
    { channel: "phone", reached: false, outcome: "x", closedLoop: true, at: "2026-09-15T18:06:00Z" },
    "2026-09-15T18:06:00Z",
  );
} catch (e) {
  blocked = e instanceof InvalidTransition;
}
check("系统拒绝未触达却闭环", blocked);

section("联系闭环：b02 二次电话触达并完成随访");
service.recordContact(
  nurse,
  b02.episodeId,
  "患者回电，已指导当天加做 ECG 并门诊复查",
  { channel: "phone", reached: true, outcome: "已预约周三门诊，指导暂停剧烈活动", closedLoop: true, at: "2026-09-15T19:10:00Z" },
  "2026-09-15T19:10:00Z",
);
check(
  "触达闭环后 closed-contact",
  service.listForClinical(nurse).find((e) => e.episodeId === b02.episodeId)!.status === "closed-contact",
);

// ---------- a17 主发作：升级医生，医生追加解释 ----------

section("升级：a17 主发作升级医生并附依据");
const esc = service.escalate(
  nurse,
  a17First.episodeId,
  "跨午夜长持续（340s 去重叠）且有干净单导联 ECG；虽有运动/松动标记仍需医生判读",
  "2026-09-15T18:20:00Z",
);
check(
  "升级后状态 escalated",
  service.listForClinical(nurse).find((e) => e.episodeId === a17First.episodeId)!.status === "escalated",
);
check("护士不能再对已升级发作做处置", (() => {
  try {
    service.markArtifact(nurse, a17First.episodeId, "x", "2026-09-15T18:21:00Z");
    return false;
  } catch (e) {
    return e instanceof InvalidTransition;
  }
})());

section("医生追加解释（只能追加更正，不覆盖升级记录）");
service.physicianCorrect(
  physician,
  a17First.episodeId,
  esc.reviewId,
  "复核 p-007 单导联 ECG：窦性心动过速，未见 f 波；PPG 不齐与运动时段吻合，判定为运动相关伪节律，不诊断房颤。建议一周后 Holter 复查。",
  "结合干净 ECG 与质量标记判读",
  "2026-09-15T18:40:00Z",
);
const detailAfter = service.episodeDetail(nurse, a17First.episodeId);
check("医生解释后状态 explained", detailAfter.episode.status === "explained");
check("升级记录仍保留（追加而不覆盖）", detailAfter.reviews.some((r) => r.reviewId === esc.reviewId));
check("更正链指向升级记录", detailAfter.reviews.find((r) => r.disposition === "correct")?.correctsReviewId === esc.reviewId);

section("a17 完整状态时间线");
printTimeline(detailAfter.timeline);

// ---------- a17 凌晨运动簇：标记伪迹 ----------

section("伪迹：a17 凌晨运动簇标记为伪迹");
service.markArtifact(
  nurse,
  a17Motion.episodeId,
  "两条提示均在剧烈运动时段且伴 signal-gap，无 ECG 佐证，判定运动伪迹",
  "2026-09-15T18:25:00Z",
);
check(
  "伪迹标记后状态 artifact",
  service.listForClinical(nurse).find((e) => e.episodeId === a17Motion.episodeId)!.status === "artifact",
);

section("处置后待联系队列");
queue = service.contactQueue(nurse);
console.log(`待首次联系 ${queue.pending.length}：${queue.pending.map((e) => e.episodeId).join(", ") || "（空）"}`);
console.log(`联系进行中 ${queue.inProgress.length}`);
check("仅剩 c03 待联系", queue.pending.length === 1 && queue.pending[0]!.episodeId === c03.episodeId);

// ---------- 撤回授权 ----------

section("授权：c03 患者撤回共享授权");
service.revokeConsent("patient-c03", "患者在 App 中撤销健康数据共享", "2026-09-15T20:00:00Z");
queue = service.contactQueue(nurse);
check("撤回后该患者从临床队列消失", queue.pending.length === 0 && queue.inProgress.length === 0);
check("撤回后不出现在护士列表", !service.listForClinical(nurse).some((e) => e.patientId === "patient-c03"));

let deniedRead = false;
try {
  service.episodeDetail(nurse, c03.episodeId);
} catch (e) {
  deniedRead = e instanceof AccessDenied;
}
check("护士读取 c03 波形被拒绝", deniedRead);

let deniedAction = false;
try {
  service.escalate(nurse, c03.episodeId, "尝试处置", "2026-09-15T20:05:00Z");
} catch (e) {
  deniedAction = e instanceof AccessDenied;
}
check("撤回后临床处置也被冻结", deniedAction);

let physicianDenied = false;
try {
  service.episodeDetail(physician, c03.episodeId);
} catch (e) {
  physicianDenied = e instanceof AccessDenied;
}
check("医生同样不能读取", physicianDenied);

section("审计视角：历史保留，时间线仍可回放");
const auditTl = service.auditTimeline(auditor, c03.episodeId);
check("审计仍可读取撤回患者的时间线", auditTl.entries.length > 0);
const allListed = service.listAll();
check("管理视角可见 c03 且标注 consentRevoked", allListed.some((e) => e.patientId === "patient-c03" && e.consentRevoked));

const auditLog = service.auditLog(auditor);
const denyEntries = auditLog.filter((a) => a.denied);
console.log(`审计条目 ${auditLog.length} 条，其中拒绝访问 ${denyEntries.length} 条：`);
for (const d of denyEntries) {
  console.log(`  ${d.at} ${d.actorRole}:${d.actorId} ${d.action} episode=${d.episodeId ?? ""} 原因=${d.denialReason}`);
}
check("两次临床拒绝均留痕", denyEntries.length >= 3);
check("摄入审计记录了重复数据包", auditLog.some((a) => a.action === "ingest" && a.detail?.includes("p-001")));
check("撤回授权本身在审计日志中", auditLog.some((a) => a.action === "consent-revoked"));

// ---------- 结果 ----------

section("回放结论");
if (failures > 0) {
  console.error(`\n❌ 自检失败 ${failures} 项`);
  process.exit(1);
}
console.log("\n✅ 全部自检通过：跨午夜归属、幂等去重、质量依据、风险升级、联系闭环、追加更正与授权门控均符合预期。");
