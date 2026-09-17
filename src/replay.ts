/**
 * 样例回放：把 fixtures/night-events.json 通过 HTTP 接口灌入服务，
 * 然后走一遍“护士复核 → 升级医生 → 医生追加更正 → 联系闭环 → 撤回授权”的完整流程，
 * 打印跨午夜归属、升级依据、待联系队列与完整状态时间线。
 *
 * 运行：npm run build && npm run replay
 */
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { ReviewService } from "./service.js";
import { createReviewServer } from "./server.js";
import { Store } from "./store.js";

const FIXTURE_URL = new URL("../fixtures/night-events.json", import.meta.url);

/** 样例数据未携带设备上下文，回放时按 +08:00 偏移补齐演示设备信息。 */
const DEMO_DEVICE = {
  deviceId: "watch-demo-01",
  firmwareVersion: "fw-4.2.1",
  algorithmVersion: "afib-algo-2.3.0",
  calibrationVersion: "cal-2026-08",
  timezone: "Asia/Shanghai",
};

interface FixtureLine {
  patientId: string;
  packets: Array<{
    packetId: string;
    kind: string;
    capturedAt: string;
    durationSeconds: number;
    qualityFlags: string[];
  }>;
}

let baseUrl = "";

async function api(
  method: string,
  path: string,
  options: { role?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.role !== undefined ? { "x-role": options.role } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

function section(title: string): void {
  console.log(`\n${"=".repeat(64)}\n${title}\n${"=".repeat(64)}`);
}

function show(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const server = createReviewServer(new ReviewService(new Store()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    const raw = await readFile(FIXTURE_URL, "utf8");
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as FixtureLine);

    section("1. 接收数据包（重复包幂等，不产生新事件）");
    for (const line of lines) {
      for (const packet of line.packets) {
        const fragment = { ...packet, patientId: line.patientId, device: DEMO_DEVICE };
        const { status, json } = await api("POST", "/signals", { body: fragment });
        const r = json as { packetId: string; episodeId: string; deduplicated: boolean; attempts: number };
        console.log(
          `POST /signals ${r.packetId} -> HTTP ${status} ` +
            (r.deduplicated ? `重复包，已忽略（第 ${r.attempts} 次上送）` : `新片段，进入 ${r.episodeId}`),
        );
      }
    }

    const patientId = lines.at(0)?.patientId ?? "";
    const episodesRes = await api("GET", `/episodes?patientId=${patientId}`);
    const episodes = (episodesRes.json as { episodes: Array<Record<string, unknown>> }).episodes;
    const episode = episodes.at(0);
    if (!episode) throw new Error("回放失败：没有生成任何发作候选");
    const episodeId = episode.episodeId as string;

    section("2. 发作候选：跨午夜归属 / 质量依据 / 风险分层");
    for (const ep of episodes) {
      const local = ep.local as { start: { isoLike: string }; end: { isoLike: string }; crossesLocalMidnight: boolean; attributedLocalDate: string };
      console.log(`发作 ${ep.episodeId}  状态=${ep.status}  风险=${(ep.risk as { level: string }).level}`);
      console.log(`  UTC 窗口:       ${(ep.windowUtc as { start: string }).start} ~ ${(ep.windowUtc as { end: string }).end}`);
      console.log(`  设备本地窗口:   ${local.start.isoLike} ~ ${local.end.isoLike}（时区 ${ep.deviceTimezone}）`);
      console.log(`  跨午夜:         ${local.crossesLocalMidnight ? `是，归属 ${local.attributedLocalDate}` : "否"}`);
      const quality = ep.quality as { looseFit: boolean; vigorousMotion: boolean; signalGap: boolean; rawFlags: string[] };
      console.log(
        `  质量依据:       佩戴松动=${quality.looseFit} 剧烈运动=${quality.vigorousMotion} 信号缺口=${quality.signalGap} 原始标记=[${quality.rawFlags.join(", ")}]`,
      );
      console.log(`  归并构成:       ${(ep.composition as Array<{ packetId: string; kind: string }>).map((c) => `${c.packetId}(${c.kind})`).join(" + ")}`);
      for (const basis of (ep.risk as { basis: string[] }).basis) console.log(`  风险依据:       - ${basis}`);
    }

    section("3. 护士发起联系 -> 待联系队列");
    const contactReview = await api("POST", `/episodes/${episodeId}/reviews`, {
      role: "nurse",
      body: { reviewerId: "nurse-wang", disposition: "contact", reason: "夜间密集疑似房颤提示，需电话核实患者症状与服药情况" },
    });
    show(contactReview.json);
    const queue = await api("GET", "/contact-queue");
    console.log("待联系队列：");
    show(queue.json);

    section("4. 护士升级给医生（升级依据随事件固化）");
    const escalate = await api("POST", `/episodes/${episodeId}/reviews`, {
      role: "nurse",
      body: {
        reviewerId: "nurse-wang",
        disposition: "escalate",
        reason: "疑似发作持续约 190 秒且已有单导联心电，运动标记仅出现在心电片段，不能解释 PPG 全程，需医生判读",
      },
    });
    show(escalate.json);
    const escalateReviewId = (escalate.json as { reviewId: string }).reviewId;

    section("5. 医生判读：只能以 correct 追加更正，历史不可改写");
    const correct = await api("POST", `/episodes/${episodeId}/reviews`, {
      role: "doctor",
      body: {
        reviewerId: "dr-chen",
        disposition: "correct",
        correctsReviewId: escalateReviewId,
        reason: "单导联心电可见绝对不齐的 RR 间期与颤动波，确认为房颤发作；PPG 段运动伪迹不影响该结论",
      },
    });
    show(correct.json);
    const doctorAsNurse = await api("POST", `/episodes/${episodeId}/reviews`, {
      role: "doctor",
      body: { reviewerId: "dr-chen", disposition: "escalate", reason: "医生尝试直接改写处置（应被拒绝）" },
    });
    console.log(`医生尝试 escalate -> HTTP ${doctorAsNurse.status}（预期 403）`);
    show(doctorAsNurse.json);

    section("6. 联系闭环");
    const taskId = ((queue.json as { queue: Array<{ taskId: string }> }).queue.at(0) ?? {}).taskId ?? "";
    const closed = await api("POST", `/episodes/${episodeId}/contact/close`, {
      role: "nurse",
      body: { taskId, closedBy: "nurse-wang", outcome: "reached", note: "患者诉夜间心悸，已遵医嘱加服药物，明晨门诊复查" },
    });
    show(closed.json);
    const queueAfter = await api("GET", "/contact-queue");
    console.log(`闭环后待联系队列长度: ${(queueAfter.json as { queue: unknown[] }).queue.length}`);

    section("7. 完整状态时间线");
    const timeline = await api("GET", `/episodes/${episodeId}/timeline`);
    for (const ev of (timeline.json as { timeline: Array<Record<string, unknown>> }).timeline) {
      const transition = ev.statusTo !== undefined ? `  [${String(ev.statusFrom ?? "-")} -> ${String(ev.statusTo)}]` : "";
      console.log(`#${String(ev.seq).padStart(2, "0")} ${ev.at} ${ev.type}${transition} ${JSON.stringify(ev.detail)}`);
    }

    section("8. 患者撤回共享授权：审计保留，临床角色不得再读波形");
    await api("POST", `/patients/${patientId}/consent/revoke`, {
      body: { revokedBy: "patient-a17", reason: "患者要求停止数据共享" },
    });
    const nurseRead = await api("GET", `/episodes/${episodeId}/fragments`, { role: "nurse" });
    console.log(`护士读取波形 -> HTTP ${nurseRead.status}（预期 403）`);
    show(nurseRead.json);
    const doctorRead = await api("GET", `/episodes/${episodeId}/fragments`, { role: "doctor" });
    console.log(`医生读取波形 -> HTTP ${doctorRead.status}（预期 403）`);
    const auditorRead = await api("GET", `/episodes/${episodeId}/fragments`, { role: "auditor" });
    console.log(`审计角色读取波形 -> HTTP ${auditorRead.status}（预期 200，保留 ${(auditorRead.json as { fragments: unknown[] }).fragments.length} 条片段）`);
    const auditTrail = await api("GET", `/patients/${patientId}/audit`, { role: "nurse" });
    console.log(`护士读取历史审计 -> HTTP ${auditTrail.status}（预期 200，审计不随授权撤回删除）`);
    const ingestAfter = await api("POST", "/signals", {
      body: {
        packetId: "p-003",
        patientId,
        kind: "ppg-summary",
        capturedAt: "2026-09-16T08:00:00+08:00",
        durationSeconds: 60,
        qualityFlags: [],
        device: DEMO_DEVICE,
      },
    });
    console.log(`撤回后继续上送数据 -> HTTP ${ingestAfter.status}（预期 409）`);
    show(ingestAfter.json);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
