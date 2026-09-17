# 房颤预警复核服务

该项目保存腕戴设备上传的脉搏波与单导联心电资料，为心内科随访团队提供统一的数据边界。设备时间、算法版本、固件版本和校准信息属于原始采集上下文，不能在后续处理时丢失。

`src/contracts.ts` 定义设备、信号片段和临床复核记录。`fixtures/night-events.json` 是脱敏的跨午夜采集样例，其中包含重复上传、运动伪迹和补充心电片段。

项目采用 Node.js 22 与 TypeScript，执行 `npm install` 后可用 `npm test` 完成严格类型检查并运行领域测试。

## 设计要点

- **设备结论不是诊断**：每条 PPG 摘要只记为“疑似提示”，发作候选的风险分层逐条给出依据（疑似时长、是否附心电、质量标记），最终结论只能由医生以更正链形式追加。
- **归并可解释**：同一患者的提示按窗口重叠或间隔 ≤5 分钟归并为发作候选；每条片段的原始采集时间、设备时区、固件/算法/校准版本逐段保留，归并构成可在接口中查看。
- **跨午夜归属**：发作归属起始瞬间所在的设备当地日历日（`attributedLocalDate`），跨午夜时显式标记 `crossesLocalMidnight`，UTC 与设备本地窗口同时给出。
- **幂等接收**：`packetId` 全局去重，重复数据包只累加审计计数，不产生新事件、不改变既有发作。
- **质量依据**：佩戴松动、剧烈运动、信号缺口从原始 `qualityFlags` 归一化展示，无法归类的标记原样保留。
- **角色边界**：护士可标记伪迹 / 发起联系 / 升级医生；医生只能通过 `correct` 追加更正（必须携带 `correctsReviewId`）；复核记录只追加、不修改、不删除。
- **联系闭环**：发起联系自动生成待联系任务，`GET /contact-queue` 按风险排序，关闭任务需记录结果（reached / unreachable / refused）。
- **授权撤回**：患者撤回共享授权后，历史审计全部保留，但临床角色（护士/医生）读取波形级数据返回 403，审计角色不受影响，新数据包被拒收（409）。

## 运行

```bash
npm install
npm test          # 类型检查 + 构建 + node:test 领域测试
npm run replay    # 通过 HTTP 接口回放 fixtures/night-events.json 并演示完整复核流程
npm start         # 启动服务（默认 :8080，PORT 环境变量可改）
```

`npm run replay` 会依次展示：重复包幂等、跨午夜归属、质量依据、升级依据快照、待联系队列、联系闭环、完整状态时间线，以及授权撤回后的访问控制。

## HTTP 接口

角色通过 `x-role: nurse | doctor | auditor` 请求头声明（缺省按最严格的 nurse 处理）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/signals` | 上送信号片段（`SignalFragment`），幂等；201 新片段 / 200 重复包 |
| GET | `/episodes?patientId=&status=` | 发作候选列表，含风险依据、质量证据、归并构成 |
| GET | `/episodes/:id` | 单个发作候选详情 |
| GET | `/episodes/:id/fragments` | 波形级片段数据；授权撤回后临床角色 403 |
| GET | `/episodes/:id/timeline` | 完整状态时间线（含状态迁移与升级依据快照） |
| POST | `/episodes/:id/reviews` | 新增复核：`{reviewerId, disposition, reason, correctsReviewId?}` |
| POST | `/episodes/:id/contact/close` | 关闭联系任务：`{taskId, closedBy, outcome, note?}` |
| GET | `/contact-queue` | 待联系队列，按风险等级排序 |
| POST | `/patients/:id/consent/revoke` | 撤回共享授权：`{revokedBy, reason?}` |
| GET | `/patients/:id/audit` | 患者维度完整审计轨迹 |

错误统一返回 `{"error": {"code", "message"}}`，常见 code：`invalid-fragment`（400）、`forbidden-disposition`（403）、`waveform-sealed`（403）、`consent-revoked`（409）、`episode-merged`（409）、`already-closed`（409）、`not-found`（404）。

## 目录结构

- `src/contracts.ts` —— 既有领域契约（设备、信号片段、复核记录），未改动
- `src/domain.ts` —— 发作模型、归并窗口、质量归一化、可解释风险分层
- `src/time.ts` —— 设备时区换算与采集时间解析（强制显式偏移）
- `src/store.ts` —— 进程内存储与只追加的时间线事件日志
- `src/service.ts` —— 业务规则：幂等接收、归并、复核权限、联系闭环、授权门禁
- `src/server.ts` —— 基于 `node:http` 的接口层
- `src/replay.ts` —— 样例回放脚本
- `src/service.test.ts` —— 领域测试（node:test）

存储目前为进程内实现，接口与领域层不依赖具体持久化方案，后续可替换为数据库而不改变契约。
