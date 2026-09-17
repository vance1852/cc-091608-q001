import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReviewDisposition, SignalFragment } from "./contracts.js";
import type { EpisodeStatus, Role } from "./domain.js";
import { ReviewService, ServiceError } from "./service.js";

const ROLES: ReadonlySet<string> = new Set(["nurse", "doctor", "auditor"]);
const DISPOSITIONS: ReadonlySet<string> = new Set(["artifact", "contact", "escalate", "correct"]);
const STATUSES: ReadonlySet<string> = new Set(["open", "contact-pending", "contacted", "escalated", "closed-artifact"]);

function roleOf(req: IncomingMessage): Role {
  const raw = req.headers["x-role"];
  const value = Array.isArray(raw) ? raw.at(0) : raw;
  // 缺省按最严格的临床角色处理，避免未声明身份时放大权限。
  if (value === undefined) return "nurse";
  if (!ROLES.has(value)) throw new ServiceError("invalid-role", `未知角色: ${value}`, 400);
  return value as Role;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceError("invalid-json", "请求体不是合法 JSON", 400);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ServiceError("invalid-body", "请求体必须是 JSON 对象", 400);
  }
  return value as Record<string, unknown>;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ServiceError("invalid-body", `字段 ${key} 必须是非空字符串`, 400);
  }
  return value;
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ServiceError("invalid-body", `字段 ${key} 必须是字符串`, 400);
  return value;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ServiceError) {
    send(res, err.status, { error: { code: err.code, message: err.message } });
  } else {
    send(res, 500, { error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
  }
}

/** 创建 HTTP 服务；返回的 Server 尚未 listen，便于测试与回放脚本使用随机端口。 */
export function createReviewServer(service: ReviewService): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";
      const seg = path.split("/").filter(Boolean);

      if (method === "GET" && path === "/health") {
        send(res, 200, { ok: true });
        return;
      }

      // POST /signals —— 设备网关上送信号片段（幂等）
      if (method === "POST" && path === "/signals") {
        const body = asRecord(await readJson(req));
        const result = service.ingest(body as unknown as SignalFragment);
        send(res, result.deduplicated ? 200 : 201, result);
        return;
      }

      // GET /episodes?patientId=&status=
      if (method === "GET" && path === "/episodes") {
        const patientId = url.searchParams.get("patientId") ?? undefined;
        const statusRaw = url.searchParams.get("status") ?? undefined;
        if (statusRaw !== undefined && !STATUSES.has(statusRaw)) {
          throw new ServiceError("invalid-query", `未知状态: ${statusRaw}`, 400);
        }
        const episodes = service.listEpisodes({
          ...(patientId !== undefined ? { patientId } : {}),
          ...(statusRaw !== undefined ? { status: statusRaw as EpisodeStatus } : {}),
        });
        send(res, 200, { episodes });
        return;
      }

      // GET /contact-queue —— 待联系队列（按风险排序）
      if (method === "GET" && path === "/contact-queue") {
        send(res, 200, { queue: service.contactQueue() });
        return;
      }

      if (seg.at(0) === "episodes" && seg.length >= 2) {
        const episodeId = seg[1] ?? "";
        const tail = seg.slice(2).join("/");

        if (method === "GET" && tail === "") {
          send(res, 200, service.getEpisode(episodeId));
          return;
        }
        // GET /episodes/:id/fragments —— 波形级数据，受授权撤回门禁约束
        if (method === "GET" && tail === "fragments") {
          send(res, 200, { fragments: service.getFragments(episodeId, roleOf(req)) });
          return;
        }
        if (method === "GET" && tail === "timeline") {
          send(res, 200, { timeline: service.getTimeline(episodeId) });
          return;
        }
        // POST /episodes/:id/reviews —— 护士处置 / 医生追加更正
        if (method === "POST" && tail === "reviews") {
          const body = asRecord(await readJson(req));
          const disposition = str(body, "disposition");
          if (!DISPOSITIONS.has(disposition)) {
            throw new ServiceError("invalid-body", `未知处置类型: ${disposition}`, 400);
          }
          const review = service.addReview({
            episodeId,
            reviewerId: str(body, "reviewerId"),
            role: roleOf(req),
            disposition: disposition as ReviewDisposition,
            reason: str(body, "reason"),
            ...(optStr(body, "correctsReviewId") !== undefined
              ? { correctsReviewId: optStr(body, "correctsReviewId") as string }
              : {}),
          });
          send(res, 201, review);
          return;
        }
        // POST /episodes/:id/contact/close —— 关闭联系任务，形成闭环
        if (method === "POST" && tail === "contact/close") {
          const body = asRecord(await readJson(req));
          const task = service.closeContact({
            taskId: str(body, "taskId"),
            closedBy: str(body, "closedBy"),
            outcome: str(body, "outcome") as "reached" | "unreachable" | "refused",
            ...(optStr(body, "note") !== undefined ? { note: optStr(body, "note") as string } : {}),
          });
          send(res, 200, task);
          return;
        }
      }

      if (seg.at(0) === "patients" && seg.length === 3) {
        const patientId = seg[1] ?? "";
        if (method === "GET" && seg[2] === "audit") {
          send(res, 200, { audit: service.getAudit(patientId) });
          return;
        }
      }
      if (seg.at(0) === "patients" && seg.length === 4 && seg[2] === "consent" && seg[3] === "revoke") {
        if (method === "POST") {
          const body = asRecord(await readJson(req));
          service.revokeConsent({
            patientId: seg[1] ?? "",
            revokedBy: str(body, "revokedBy"),
            ...(optStr(body, "reason") !== undefined ? { reason: optStr(body, "reason") as string } : {}),
          });
          send(res, 200, { patientId: seg[1], status: "revoked" });
          return;
        }
      }

      send(res, 404, { error: { code: "not-found", message: `${method} ${path} 不存在` } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { Store } = await import("./store.js");
  const port = Number(process.env.PORT ?? 8080);
  const server = createReviewServer(new ReviewService(new Store()));
  server.listen(port, () => {
    console.log(`房颤预警复核服务已启动: http://localhost:${port}`);
  });
}
