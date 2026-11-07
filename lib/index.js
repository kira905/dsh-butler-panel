// dsh-butler-panel / lib/index.js（服务端）
// 路由：
//   GET  /api/dsh-butler/state            —— 只读聚合总览（含 v0.2.0 健康监控：自动归档 + 升级体检）
//   GET  /api/dsh-butler/report?file=xxx  —— 管家报告全文（白名单文件名，防路径穿越）
//   POST /api/dsh-butler/ignore           —— {kind:'session'|'task', id, ignore:boolean} 写忽略清单
//   POST /api/dsh-butler/card             —— {sessionId} 一键把疑似中断会话转成任务看板待办卡
//   v0.4.0（P5 写入守门人）：
//   POST /api/dsh-butler/audit-pass       —— 审计工具发凭证（{path, contentHash, forceReason?, actorSession?}）
//   GET/POST /api/dsh-butler/audit-off    —— 读 / 写「暂停写入审计」逃生舱开关
//   GET  /api/dsh-butler/audit-state      —— 守门人状态 + 干预统计（分级校准数据，0 token）
//   v0.6.0（规则 R4「开关是活的」/ kill switch L2 模块级熔断）：
//   GET  /api/dsh-butler/modules          —— 模块开关全景（只读：describeModules + checkModuleAllowed）
//   POST /api/dsh-butler/modules/set      —— {id, enabled, why} 关/开单个模块（why 必填，走 setModuleEnabled）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { API_PREFIX, buildState, collectHealth, listMemories, collectRestartHealth, collectRestartAudit, requestRestart, resolvePanelTarget, collectAuditStats, ignoreFilePath } from './state.js';
import { registerAuditGuard, reportGuardMount } from './audit-guard.js';
import { importButlerLib, importToolLib, workspaceRoot, butlerRoot, butlerFile } from './butler-root.mjs';
const { makeClassifier, normalizePath } = await importButlerLib('protected-paths.mjs');
// 【P1「会动手」· 2026-09-28】手动动作统一闸门（注册表 + dryRun 预览 + 子集守卫 + TOCTOU + actor 矩阵
//   + 审计哈希链）。**动作实现全部在共享底座里**（`tools\dsh-butler\lib\manual-actions.mjs`），
//   本插件只做一次转发 —— 不在插件里另写一套（否则 CLI/会话调用与面板调用必然漂移）。
const { runManualAction, describeManualActions, MANUAL_ACTIONS_VERSION, makeBoardClient } = await importButlerLib('manual-actions.mjs');
import { collectModules, setModuleEnabledViaApi } from './modules-route.mjs';
// v0.9.1（2026-10-09 · 卡「冲刺600·批4-1」）：坑升级候选只读采集（面板「🐋 管家」Tab 一段）
import { collectP4Candidates } from './p4-candidates.mjs';
// 【卡 A1 · v1.1 分片 + 进程内缓存】主机侧分片 API（片定义/解析/投影/采集）与 TTL+单飞缓存。
//   ⚠️ 新文件已同步进 deploy.mjs 的实体拷贝清单（漏了 = 插件实体缺文件起不来）。
import { parseParts, buildShardPayload, shardCacheKey } from './shards.mjs';
import { createBudget, cacheStats, SHARD_BUDGET_MS, invalidateCache } from './state-cache.mjs';
// 【V3.0.0 功能面 · 判据 15 缺口补 · 2026-10-26】面板运行期开关（一个键 = `ops-autonomy-limits.json#panelSwitches`，
//   5 s 缓存、fail-open 判开）。本卡用途：A-1 给「首屏 SWR + 开机/周期预热」一个真关回口。
//   ⚠️ 新文件必须同步进 deploy.mjs 的实体拷贝清单（漏了 = 插件实体缺文件起不来）。
import { panelSwitchOn, readPanelSwitches } from './panel-switches.mjs';
// 【卡 0 · B6②】带超时的 JSON fetch（1.2s 超时 + AbortController，可注入 → 超时路径可单测）。
//   ⚠️ 新文件已同步进 deploy.mjs 的实体拷贝清单（漏了 = 插件实体缺文件起不来）。
import { fetchJsonWithTimeout, DEFAULT_TIMEOUT_MS } from './fetch-json-timeout.mjs';
// 【2026-09-22 换线】0.1.5 主包把 /api 端点改成路径段形态并加了 cookie 鉴权门 ⇒ 旧
// `POST /api/session.list` 失效（无 cookie 401 / 带 cookie 404）。统一走真源适配层
// （tools\lib\dsh-host-rpc.mjs：cookie 自签 + 端点斜杠化 + args 包装 + 旧主包自动回落）。
// 用 file:/// 绝对路径与既有先例同形（见上方 protected-paths.mjs 那行）。
const { hostRpc } = await importToolLib('dsh-host-rpc.mjs');
// 宿主适配层副本（唯一源 tools\lib\host-adapter.mjs；P1 收敛 2026-09-15）——inject 声明的服务名走这里（R4）
import { SVC } from './host-adapter.mjs';
// ─────────────────────────────────────────────────────────────────────────────
// 【施工卡 ①-3 · P-6】C⁺ 高危险写口的「服务端确认令牌」（控制室口径包 §3.6）
//   三条 C⁺：`/restart` force · `/audit-pass` · `/audit-off` —— 前端二次确认**不够**，
//   服务端必须能验证「主人确实点过确认」⇒ 一次性令牌（TTL 120s，用后失效）。
//   ⚠️ 安全目标如实：防**误触 / 重复提交 / 忘记带理由**，**不防**本机恶意进程与跨站页面
//      （E9 实测 webserver 零鉴权、无 Origin 校验）⇒ 一律不得表述成"安全边界"。
//   机件复用（E8）：形态取 `AuditTokenStore`，但**另开实例 + 键前缀 `confirm:`** ——
//      绝不与写凭证共用同一个 Map（否则确认令牌会被写门当凭证消费掉）。
//   签发路径（本卡内二选一 · 选 a）：**复用现有 C⁺ 端点加 `mode:'confirm'`**，不新增任何写口
//      （与 ①包 §13 Non-goals「不新增 / 不删除写口」一致；E9 已证另开端点在零鉴权下无安全收益）。
import { ConfirmTokenStore, CONFIRM_ACTIONS, CONFIRM_CODES, CONFIRM_TTL_MS } from './confirm-token.mjs';
// 令牌库内核：优先用 butler lib 的真 `AuditTokenStore`；取不到 → confirm-token 的内置等价实现降级
//   （与 audit-guard「挂载失败绝不拖垮面板」同口径：绝不因为 lib 不可用就炸掉整个插件）。
let ConfirmTokenInner = null;
// 【卡「冲刺600 · audit-off 限时」· 2026-10-09】同一入口再取三个 TTL 守卫导出：
//   `normalizeAuditOffTtl`（归一化）+ 两个常量（口径 §7.3② 的 30min 上限 / 缺省值，唯一真源在 butler lib）。
//   取不到（lib 不可用）⇒ 面板**拒绝暂停**（fail-closed：宁可暂时停不掉，也不放一个"永不过期"的洞）。
let normalizeAuditOffTtl = null;
let AUDIT_OFF_MAX_MS = null;
let AUDIT_OFF_DEFAULT_MS = null;
try {
  const _at = await importButlerLib('audit-token.mjs');
  // 占位桩也是 function：必须用 butlerUnavailable 标记区分，否则下面 `new X()` 会在模块顶层炸掉。
  ConfirmTokenInner = (typeof _at.AuditTokenStore === 'function' && !_at.AuditTokenStore.butlerUnavailable)
    ? _at.AuditTokenStore : null;
  normalizeAuditOffTtl = typeof _at.normalizeAuditOffTtl === 'function' ? _at.normalizeAuditOffTtl : null;
  AUDIT_OFF_MAX_MS = Number.isFinite(_at.AUDIT_OFF_MAX_MS) ? _at.AUDIT_OFF_MAX_MS : null;
  AUDIT_OFF_DEFAULT_MS = Number.isFinite(_at.AUDIT_OFF_DEFAULT_MS) ? _at.AUDIT_OFF_DEFAULT_MS : null;
} catch { ConfirmTokenInner = null; }
/** 进程内单一确认令牌库实例（键前缀 `confirm:`，与写凭证隔离）。 */
let confirmTokens;
try {
  confirmTokens = ConfirmTokenInner
    ? new ConfirmTokenStore({ inner: new ConfirmTokenInner({ ttlMs: CONFIRM_TTL_MS }) })
    : new ConfirmTokenStore();
} catch {
  // 内层库接不上 ⇒ 退到 confirm-token.mjs 自带等价实现（绝不让插件在加载期就挂）
  confirmTokens = new ConfirmTokenStore();
}
// 审计流水（面板写口留痕的唯一出口；取不到 → 记日志但不阻断主流程）
let appendAuditFn = null;
try {
  ({ appendAudit: appendAuditFn } = await importButlerLib('audit.mjs'));
} catch { appendAuditFn = null; }
/**
 * 写一条面板审计行（`panel-*` / `confirm-token-rejected` 命名空间）。
 * 口径与 `audit-guard.js:169` 一致：**审计失败只记日志、绝不阻断主流程**（返回 ok:false 供测试断言）。
 */
function auditPanel(entry) {
  if (!appendAuditFn) return { ok: false, error: 'audit-lib-unavailable' };
  try {
    return appendAuditFn(entry, { home: dshHome(), silent: true });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
// RMW 锁 + 原子写的唯一入口（butler lib store.mjs）——`/ignore` 写入不再手搓 readFile+writeFileSync
let storeMod = null;
try { storeMod = await importButlerLib('store.mjs'); } catch { storeMod = null; }

export const inject = [SVC.webServer];
export const name = 'dsh-butler-panel';

// 【A 补 · 首屏 SWR 的配套 · 2026-10-21】开机预热的两个常量。
//   PREWARM_DELAY_MS：插件起来后多久焐缓存。15~20 s 是题面给的窗口，取中段 18 s ——
//     早于这个区间会跟 boot 抢资源（主包加载插件/建索引 + 生态面板冷价 1.6~1.7 s 都在前十几秒）；
//     晚于这个区间则赶不上主人重启后"一眼就想看面板"的那一下。
//   PREWARM_PARTS：与首屏第一个请求同一组片（探针 `--parts "core,feed"`）⇒ 命中同一条缓存键。
const PREWARM_DELAY_MS = 18_000;
const PREWARM_PARTS = ['core', 'feed'];
// 【2026-10-26 · 卡「面板首屏冷窗治本」· 周期预热】默认 12 分钟。
//   参数链 900 s（`STATE_STALE_MAX_MS` 硬上限）> **720 s（本值）** > 300 s（`STATE_CACHE_TTL_MS` TTL）。
//   三条理由逐条见下面预热段注释：① 超 900 s 条目照样被惰性删掉、等于没治；② 低于 300 s 那轮
//   `peekCache` 直接命中、空转不算（"更勤"不等于"更暖"）；③ TTL 本身**不许动**（主人拍的是 SWR）。
//   关回：env 显式 0（等价改前）/ `DSH_BUTLER_PANEL_NO_PREWARM=1`（一次性 + 周期全关）。
const PREWARM_INTERVAL_DEFAULT_MS = 720_000;
/**
 * 解析周期预热间隔（env `DSH_BUTLER_PANEL_PREWARM_INTERVAL_MS`）：
 *   · 不设 / 空白        ⇒ 720_000（默认 12 分钟）
 *   · 显式 `"0"`          ⇒ 返回 0，调用方据此**不建 interval** ⇒ 与改前行为逐字等价
 *   · 非法（NaN / 负数）  ⇒ 回落 720_000，并回一句 warn 交给调用方打（**本函数绝不抛**）
 * @returns {{ms:number, warn:string|null}}
 */
function resolvePrewarmIntervalMs() {
  const raw = process.env.DSH_BUTLER_PANEL_PREWARM_INTERVAL_MS;
  if (raw === undefined || raw === null) return { ms: PREWARM_INTERVAL_DEFAULT_MS, warn: null };
  const text = String(raw).trim();
  if (!text) return { ms: PREWARM_INTERVAL_DEFAULT_MS, warn: null };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) {
    return {
      ms: PREWARM_INTERVAL_DEFAULT_MS,
      warn: `[butler-panel] DSH_BUTLER_PANEL_PREWARM_INTERVAL_MS=${JSON.stringify(raw)} 非法（要 ≥0 的毫秒数）⇒ 回落默认 ${PREWARM_INTERVAL_DEFAULT_MS} ms`,
    };
  }
  return { ms: Math.floor(n), warn: null };
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer'
};
// 路径口径（2026-09-14 环境边界修复）：DSH 数据根 = BUTLER_DSH_HOME > DSH_HOME > ~/.dsh
//   （与 tools/lib/dsh-home.mjs 同源；此处内联一行以便插件实体独立可跑）。
//   报告目录沿用既有先例 $BUTLER_REPORT_DIR > <workspace>\docs\管家报告；
//   workspace 推导=测试实例 <root>\.dsh → <root>，未配置时回落 <用户主目录>/DSH。
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
// 工作区根：$DSH_WORKSPACE > 由 home 推导（仅当 home 被 env 重定向成 <root>\.dsh 形态）> <用户主目录>/DSH
// （判据是"env 显式指向非默认 home"，不是路径层数——生产 home 也是 3 层）
function dshWorkspace() {
  const override = process.env.DSH_WORKSPACE;
  if (override && override.trim()) return path.resolve(override.trim());
  const redirected = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (redirected && redirected.trim()) {
    const home = path.resolve(redirected.trim());
    const def = path.join(os.homedir(), '.dsh');
    if (home.toLowerCase() !== path.resolve(def).toLowerCase() && path.basename(home).toLowerCase() === '.dsh') {
      return path.resolve(path.dirname(home));
    }
  }
  return path.join(os.homedir(), 'DSH');
}
// 本机 web 基址（面板自调用：主包 RPC / 看板 Host API）。
// 【卡 A1】测试实例（DSH_HOME 指向非默认 home）跑在 3090，生产 3080 —— 硬编码 3080 会让
//   测试实例的面板去打生产 dsh（语义串台，R8 环境边界的反向断言会抓）。$DSH_WEB_URL 可覆盖。
function localWebBase() {
  const env = (process.env.DSH_WEB_URL ?? '').trim();
  const redirected = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  let isTest = false;
  if (redirected && redirected.trim()) {
    const home = path.resolve(redirected.trim());
    const def = path.join(os.homedir(), '.dsh');
    isTest = home.toLowerCase() !== path.resolve(def).toLowerCase();
  }
  if (isTest) {
    // 测试实例必须打自己（3090），**绝不认继承来的生产 DSH_WEB_URL**：
    // 2026-09-14 实测 —— DSH 给子进程注入了 `DSH_WEB_URL=http://127.0.0.1:3080`，
    // 测试实例若照单全收，面板/RPC 会去读**生产**数据（环境边界静默失效，
    // 表现为"测试环境里看到生产的会话数/看板卡"）。$DSH_TEST_WEB_URL 可显式覆盖。
    const explicitTest = (process.env.DSH_TEST_WEB_URL ?? '').trim();
    if (explicitTest) return explicitTest.replace(/\/+$/, '');
    if (/:309\d(\/|$)/.test(env)) return env.replace(/\/+$/, '');
    return 'http://localhost:3090';
  }
  return (env || 'http://localhost:3080').replace(/\/+$/, '');
}
const REPORT_DIR = (() => {
  const override = process.env.BUTLER_REPORT_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dshWorkspace(), 'docs', '管家报告');
})();
// 【2c · S4 前置 · 2026-10-19】忽略清单路径**不再本文件另定义**（原先是与 state.js 重复的一份裸 join）：
//   读 / 写共用 state.js#ignoreFilePath()（唯一口径，内部走 resolveStatePath）。
const NO_STORE = { 'cache-control': 'no-store' };
// ---------------------------------------------------------------------------
// 【V2-B · §3.8 交互铁律】「知道了 / 标误报」的**唯一写口** = butler-watch CLI
//   ⛔ 面板**绝不直接写** `butler-watch-state.json`：① 那是 ~162 KB 大文件，进程内读改写会与
//      每 5 分钟的写者（p2-watch job）互相覆盖 ② 直写不留 `p2-ack` 审计痕迹（P2 的 ack 语义、
//      §3.8 的"写动作可追溯"都要求走权威入口）。CLI 自带原子写 + 审计。
//   参数用**数组**形式 spawn（不经 shell）→ 天然免疫命令注入；token 另有字符白名单。
// ---------------------------------------------------------------------------
const WATCH_CLI = process.env.DSH_BUTLER_WATCH_CLI
  || butlerFile('dsh-butler-watch.mjs');
const WATCH_CLI_TIMEOUT_MS = Number(process.env.DSH_BUTLER_WATCH_TIMEOUT_MS ?? 20_000) || 20_000;
/** 事件 id / ack token 白名单（另允许字面量 `all`，由 CLI 语义决定）。 */
const ACK_TOKEN_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** 跑一次 butler-watch CLI；返回 `{ok, out}` 或 `{ok:false, error}`（绝不抛）。 */
function runWatchCli(args) {
  try {
    const r = spawnSync(process.execPath, [WATCH_CLI, ...args], {
      encoding: 'utf8', timeout: WATCH_CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error) return { ok: false, error: String(r.error.message ?? r.error), out: '' };
    const out = String(r.stdout ?? '') + String(r.stderr ?? '');
    if (r.status !== 0) return { ok: false, error: `CLI 退出码 ${r.status}：${out.trim().slice(0, 200)}`, out };
    return { ok: true, out };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), out: '' };
  }
}
// 报告文件白名单（日报 [可带设备后缀] / 周报-周一起始日）
const REPORT_NAME_RE = /^(?:\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9_.-]+)?|周报-\d{4}-\d{2}-\d{2}|external-\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9_.-]+)?)\.md$/;
// task-board 建卡：本机 Host HTTP API（账本权威方），workspaceId 复用现有卡
const TB_ACTION_URL = 'http://localhost:3080/api/task-board/action';
const TB_STATE_URL = 'http://localhost:3080/api/task-board/state';
// 看板工作区 id 兜底：env DSH_BUTLER_BOARD_WS；未配置则只能靠"看板里已有卡"反查，
// 反查不到 → 转卡动作 fail-closed 并给出明确提示（绝不悄悄往错的工作区建卡）。
const TB_FALLBACK_WS = (process.env.DSH_BUTLER_BOARD_WS ?? '').trim();

function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, ...headers });
  res.end(payload);
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 128 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
// 写忽略清单【①-3 · ①-7】：改用 butler lib 的 `store.updateJson`（**原子写 + RMW 锁**）。
//   改前（①包 §2.1 第 2 项实测）：`fs.writeFileSync` 直写 = ① 非原子（被拦/断电 → 半截 JSON）
//   ② 读-改-写无锁 ⇒ 与并发的另一次 ignore 互相覆盖（丢更新）。
//   store 不可用（butler lib 缺失/被升级冲掉）时**拒绝写入**（fail-closed），绝不回退非原子写。
function mutateIgnore(kind, id, ignore) {
  if (!storeMod || typeof storeMod.updateJson !== 'function') {
    return { ok: false, error: 'butler-store-unavailable', data: null };
  }
  try {
    // 【2c · S4 前置】写目标与读侧同一个解析器（legacy/dual 期仍落旧名，S4 后自动落新名）
    const next = storeMod.updateJson(ignoreFilePath(), (cur) => {
      const base = cur && Array.isArray(cur.sessions) && Array.isArray(cur.tasks)
        ? { ...cur, sessions: cur.sessions.filter((x) => typeof x === 'string'), tasks: cur.tasks.filter((x) => typeof x === 'string') }
        : { sessions: [], tasks: [] };
      const list = kind === 'task' ? base.tasks : base.sessions;
      const idx = list.indexOf(id);
      if (ignore && idx === -1) list.push(id);
      if (!ignore && idx !== -1) list.splice(idx, 1);
      return base;
    }, { home: dshHome(), defaultValue: { sessions: [], tasks: [] } });
    return { ok: true, data: next, error: null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), data: null };
  }
}
// 转看板卡：查现有 workspaceId（兜底固定值）→ task-board create
// 【①-3 · ①-7】在途卡状态（`/card` 去重的判据域）：done/failed/archived 不阻断。
const INFLIGHT_STATUSES = Object.freeze(['backlog', 'todo', 'running', 'review']);
/**
 * 查「同 sessionId 是否已有在途卡」（①包 §3.1 `/card` 行 + §6 表 4 的幂等缺口）。
 * 判据 = Host 权威账本（GET /state）里 `description` 含该 sessionId 且状态在途的卡。
 * **读不到账本 ⇒ 返回 ok:false**（调用方必须拒绝建卡：判"不可用"而不是判"没重复"）。
 */
async function findInflightCards(sessionId) {
  let res;
  try {
    res = await fetch(TB_STATE_URL, { headers: { origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' }, cache: 'no-store' });
  } catch (e) {
    return { ok: false, error: `task-board state 不可达：${e?.message ?? e}` };
  }
  if (!res.ok) return { ok: false, error: `task-board state HTTP ${res.status}` };
  const st = await res.json().catch(() => null);
  if (!st || !Array.isArray(st.tasks)) return { ok: false, error: 'task-board state 结构不符' };
  const hits = st.tasks.filter((t) => t && !t.archivedAt
    && INFLIGHT_STATUSES.includes(t.status)
    && typeof t.description === 'string' && t.description.includes(sessionId));
  return { ok: true, hits };
}
async function createBoardCard({ sessionId, title, group, lastActiveLabel }) {
  const wsReq = await fetch(TB_STATE_URL, { headers: { origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' }, cache: 'no-store' });
  let ws = TB_FALLBACK_WS;
  if (wsReq.ok) {
    try {
      const st = await wsReq.json();
      const anyTask = st?.tasks?.find?.((t) => t?.workspaceId);
      if (anyTask?.workspaceId) ws = anyTask.workspaceId;
    } catch { /* fallback */ }
  }
  if (!ws) throw new Error('看板工作区未知：请设环境变量 DSH_BUTLER_BOARD_WS=<工作区 id>；或先让看板里存在至少一张带 workspaceId 的卡');
  const cardTitle = (title && title.trim()) ? `[续] ${title.trim().slice(0, 40)}` : `会话 ${sessionId.slice(0, 8)} 续做`;
  const desc = `大管家一键转卡：疑似中断会话 ${sessionId}（工作区 ${group}${lastActiveLabel ? '，最后活动 ' + lastActiveLabel : ''}）。` + (title ? `会话标题：${title}。` : '');
  const prompt = `来自大管家「疑似中断会话」转卡。目标：接续会话 ${sessionId}（在 DSH 侧边栏会话列表可搜到该 id，工作区 ${group}）并把它遗留的工作推进/收尾。若 GUI 中该会话已无法打开，按卡片 description 的人工信息尽力续做并说明。完成标准：遗留任务处理完毕（做完或明确结论），结算时写清做了什么、是否需主人确认。`;
  // 【①-3】显式留 id 并回给调用方（审计要能指向具体卡；原先 inline randomUUID 无法回溯）
  const cardId = randomUUID();
  const body = JSON.stringify({
    requestId: randomUUID(),
    action: {
      kind: 'create',
      id: cardId,
      input: {
        title: cardTitle,
        description: desc,
        prompt,
        workspaceId: ws,
        permission: 'workspace-write'
      }
    }
  });
  const res = await fetch(TB_ACTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' },
    body,
    cache: 'no-store'
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.ok === false) throw new Error((j?.error ?? j?.message ?? ('HTTP ' + res.status)));
  return { title: cardTitle, revision: j?.revision, cardId };
}

// 主包权威标题：POST /api/session.list（client-request 通道）→ projections.values.title。
// 实证（2026-09-08）：LLM 自动生成/主人改名的标题存主包 projection（54/56 会话有），
// zstd 事件里 session/title 不全（自动标题不写事件）→ 标题一律以主包投影为准，scan 降级兜底。
// 短缓存（8s）：避免高频 RPC；失败静默降级（空 Map → 调用方回落 scan 标题）。
// 【卡 0 · B6②（2026-09-14 修）】原先**无超时、无 AbortController**：主包 RPC 卡住（dsh 重启中 / 假死）
//   时面板 GET /state 会跟着挂住，首屏永远出不来。现在走 fetchJsonWithTimeout（默认 1.2s）：
//   · 超时/失败 → **保留 scan 标题**（返回上一次成功的 Map，可能为空 Map），绝不抛错、绝不拖住首屏；
//   · 失败也刷新缓存时间戳（失败冷却）→ 同一 TTL 窗口内不再每个请求各等一次超时。
//   ⚠️ 该 RPC 地址是面板所在 dsh 自己（localhost:3080）；测试实例/换端口场景仍按既有约定。
const MAIN_TITLE_TTL_MS = 8000;
/** 标题 RPC 超时（B6②：≤1.2s，超时即降级）。 */
export const MAIN_TITLE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
// 【卡 A1】同一份 RPC 结果服务两个消费者：① 会话标题覆盖（既有）② core 片 `board.review` 的
//   双判据第二半（执行会话 running 状态）。**零额外 RPC**：原来只取标题，现在同时留下会话索引；
//   `fetchMainTitleMap` 的返回值（Map）与降级语义（失败保留上次结果 + 失败冷却）逐字不变。
let mainSessionCache = { at: 0, titles: new Map(), sessions: [], lastFail: null };
/**
 * 取主包会话索引：`sessionId → 标题` + `[{sessionId, running, title}]`。
 * 降级：RPC 超时/失败 → 保留上一次成功的索引（可能为空）+ 刷新时间戳（失败冷却），绝不抛错。
 * @param {{timeoutMs?:number, fetchImpl?:Function}} [opts] 单测可注入（超时/fetch 实现）
 */
export async function fetchMainSessionIndex(opts = {}) {
  const nowMs = Date.now();
  if (nowMs - mainSessionCache.at < MAIN_TITLE_TTL_MS) return mainSessionCache;
  // 【2026-09-22 换线】旧 `POST /api/session.list` 在 0.1.5 上已失效 → 走适配层（新端点
  // `/api/session/list` + `payload:{args:{_request}}` + cookie 自签；旧主包自动回落点号端点）。
  // 结果形态适配回 fetchJsonWithTimeout 的 `{ok, json, status, reason}`，下游零改动。
  let r;
  try {
    const out = await hostRpc(localWebBase(), 'session.list', {}, {
      timeoutMs: opts.timeoutMs ?? MAIN_TITLE_TIMEOUT_MS,
      ...(typeof opts.fetchImpl === 'function' ? { fetchImpl: opts.fetchImpl } : {}),
    });
    r = out.body?.result === undefined
      ? { ok: false, status: out.status, reason: out.body?.result?.error?.code ?? `HTTP ${out.status}` }
      : { ok: true, status: out.status, json: out.body };
  } catch (e) {
    r = { ok: false, status: 0, reason: e?.message ?? String(e) };
  }
  if (!r.ok) {
    // 降级：保留上次成功的索引，并刷新时间戳（失败冷却）
    mainSessionCache = { at: Date.now(), titles: mainSessionCache.titles, sessions: mainSessionCache.sessions, lastFail: r.reason ?? 'unknown' };
    return mainSessionCache;
  }
  const items = r.json?.result?.value?.items;
  const titles = new Map();
  const sessions = [];
  if (Array.isArray(items)) {
    for (const it of items) {
      const raw = String(it?.sessionId ?? it?.id ?? '');
      const id = raw.replace(/^session-/, '');
      const t = it?.projections?.values?.title;
      if (id && typeof t === 'string' && t.trim()) titles.set(id, t.trim());
      if (raw) sessions.push({ sessionId: raw, running: it?.running === true, title: typeof t === 'string' ? t.trim() : '' });
    }
  }
  mainSessionCache = { at: Date.now(), titles, sessions, lastFail: null };
  return mainSessionCache;
}
/**
 * 取主包权威标题 Map（sessionId → title）——**签名与返回值不变**（旧调用方零感知，
 * 内部改走 fetchMainSessionIndex 的同一份 RPC 缓存）。
 * @param {{timeoutMs?:number, fetchImpl?:Function}} [opts] 单测可注入（超时/fetch 实现）
 */
export async function fetchMainTitleMap(opts = {}) {
  const r = await fetchMainSessionIndex(opts);
  return r.titles instanceof Map ? r.titles : new Map();
}
// 用主包标题覆盖 scan 标题（主包有则必胜）
function applyMainTitles(items, map) {
  for (const x of items ?? []) {
    const t = x?.fullId ? map.get(x.fullId) : '';
    if (t) x.title = t;
  }
  return items;
}
function apply(ctx) {
  // ---- P5 写入守门人（抗升级：挂载失败绝不拖垮面板）----
  // 【卡「冲刺600·补面板残余」· gap-1-07 · 2026-10-10】§3.6.4 失败策略表：**fail-open 但必须能被检测到** ——
  //   挂载失败时除了不打崩面板，还要 ①落既有告警通道（`~/.dsh/butler-alert.log`，level=error，
  //   固定串「守门人不在岗」）②被日报看见（日报红项源 `audit-guard` 按「最后一条报到」判红）。
  let guard = null;
  try {
    guard = registerAuditGuard(ctx, { logger: ctx.logger });
  } catch (error) {
    try { ctx.logger?.warn?.(`[butler-audit] 守门人挂载失败（面板继续，审计降级为不可用）：${error?.message ?? error}`); } catch { /* ignore */ }
    try { reportGuardMount({ ok: false, stage: 'mount', error, logger: ctx.logger }); } catch { /* 绝不拖垮面板 */ }
  }
  // 【R-068 补口 · 2026-10-16】保护区判定 = **每次判定现建** classifier —— **禁退回模块级常量**。
  //   为什么必须每请求现建（运行时开关语义）：`makeClassifier()` 在**创建时**读一次运行时开关
  //   （`~/.dsh/butler-autonomy.json` 的 `protectedPaths.include` / `exclude` / `modules['p5-protected-paths']`），
  //   之后闭包**冻结**。原实现 `const classifyTarget = makeClassifier({ home: dshHome() })` 在插件加载期
  //   建一次 ⇒ 运行时清单变更对面板**永不生效（只随重启刷新）**；而写前拦截侧
  //   （`dsh-butler\lib\audit-guard.mjs` 的 `resolveProtected()`）**每次判定新建**
  //   ⇒ 形成「audit-guard 拦得住、面板领不到凭证」的不对称。
  //   实测（R-068 · 2026-10-16）：把闸门本体写进 `protectedPaths.include` 后，audit-guard ≤3s 真拦下来，
  //   但本端点 `/audit-pass` 返回 `{ok:false, code:'NOT_PROTECTED'}`（§3.3 / §10.2）。
  //   现口径**与 audit-guard 同源**：每请求现建 ⇒ 开关 ≤3s 热生效（mtime 变即失效 3s 时窗缓存），零重启。
  //   ⚠️ 改回常量 = 复现 R-068；回归锚 = `_test\test-audit-pass-classify-live.mjs`（段 A 冻结对照 + 段 B 端到端）。
  const classifyTarget = (p) => makeClassifier({ home: dshHome() })(p);
  ctx.effect(() => {
    const disposers = [];
    const register = (opts) => disposers.push(ctx.webServer.register(opts));
    try {
      // ---- GET /state（聚合总览）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/state`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          try {
            // ── 分片路径（卡 A1 · v1.1 修订块 B2）：`?parts=core[,health,feed,assets,metrics,contract]`
            //    缓存 = 进程内 TTL(300s) + 单飞（B1 方案甲，取代落盘快照：零新增 job/锁/状态文件）。
            //    未知片名 **忽略 + 记 meta.unknownParts，不 4xx**（R1）。
            const q = new URL(req.url, 'http://localhost').searchParams;
            const selection = parseParts(q.get('parts'));
            if (!selection.isFull) {
              // 【V2-B】`&refresh=1` = 强制实时重算（前端「刷新」按钮）：先丢旧缓存再算，
              //   算完由 single-flight 写回新值。不加这个，刷新按钮在 TTL(300s) 内只会命中旧缓存
              //   —— 主人点刷新看不到变化 = 假刷新（交互契约 §6.5）。
              const forceRefresh = q.get('refresh') === '1';
              if (forceRefresh) invalidateCache(null);
              const budget = createBudget(SHARD_BUDGET_MS);
              // 【卡 面板③·取数 · S2】会话索引改成**按需**：不再每请求前置 await。
              //   实测 `session.list` median 610.4 ms / 314 KB，且它唯一的下游是「双判据第二半」——
              //   待验收卡为 0 时根本不需要（2026-10-21 现跑 = 0 张）⇒ 省掉整段串行等待。
              //   需要时由 core 片（collectBoardReview）按卡数决定是否调这个 thunk；**「零额外 RPC」口径不变**。
              const sessionsIndex = selection.requested.includes('core')
                ? () => fetchMainSessionIndex({ timeoutMs: Math.max(200, Math.min(MAIN_TITLE_TIMEOUT_MS, budget.remaining())) })
                  .then((idx) => (Array.isArray(idx.sessions) ? idx.sessions : null))
                  .catch(() => null)
                : null;
              const payload = await buildShardPayload(selection, {
                budget,
                // 【V3.0.0 · 判据 15 缺口 A-1 · 2026-10-26】首屏 SWR 的运行期开关（缺键/非法 ⇒ 判开 = 改前行为）。
                //   显式布尔：`shards.mjs` 的判据是 `opts.swr !== false`（不传 = 开），这里把键值翻成一个布尔传下去。
                swr: panelSwitchOn('swr'),
                // 【V2-C】`guard` 实例注入 audit 片（P5 守门人运行时统计：挂载状态/待用凭证/逃生舱）
                deps: { baseUrl: localWebBase(), sessionsIndex, guard },
                // 【A 补 · 首屏 SWR · 2026-10-21】后台重算失败只留一行痕，**绝不抛给请求方**
                //   （旧值继续服务到硬上限 15min；请求方拿到的仍是 `stale:true` 的旧 payload）。
                onRefreshError: (e, key) => {
                  try { ctx.logger?.warn?.(`[butler-panel] 首屏后台重算失败（继续服务旧值）：key=${key} reason=${e?.message ?? e}`); } catch { /* 留痕失败也不许影响请求 */ }
                },
              });
              writeJson(res, 200, payload, NO_STORE);
              return;
            }
            // ── 无参 = 旧行为全量（兼容契约；B9 的 4+3+1 个消费方逐字不变）
            const state = await buildState();
            // v0.2.0 健康监控（只读）：自动归档状态 + 升级体检汇总，各自降级不拖垮整体
            try {
              state.health = await collectHealth();
            } catch (e) {
              state.health = { archive: { ok: false }, upgrades: { ok: false, error: String(e?.message ?? e) } };
            }
            // 会话标题以主包投影为准（LLM 自动标题/改名不在 zstd 事件里，scan 会读旧/读不到）
            try {
              const map = await fetchMainTitleMap();
              state.sessions.interrupted = applyMainTitles(state.sessions.interrupted ?? [], map);
            } catch { /* 降级：保留 scan 标题 */ }
            // v0.4.0（P5）：写入守门人状态 + 干预统计（分级校准数据，0 token）
            try {
              state.audit = { stats: collectAuditStats(), guard: guard ? guard.stats() : null };
            } catch (e) {
              state.audit = { stats: { ok: false, error: String(e?.message ?? e) }, guard: null };
            }
            // 【卡 A1】只加两个小标注（不删不改任何既有字段）：本次是全量真算，不是分片缓存。
            state.meta = {
              ...(state.meta ?? {}),
              parts: ['full'],
              unknownParts: selection.unknown,
              // 【V3.0.0 · 判据 15 缺口 A-2 · 2026-10-26】面板运行期开关值（前端据此一处 if 决定 SLI 段渲不渲染）。
              //   与分片路径同源同口径；无参路径也给，保证"哪个路径打开的页面都能读到同一个值"。
              panelSwitches: readPanelSwitches().values,
              cache: { key: 'full', hit: false, coalesced: false, note: '无参 = 旧行为全量真算（兼容契约；分片缓存只服务 ?parts= 路径）' }
            };
            writeJson(res, 200, state, NO_STORE);
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
          }
        }
      });
      // ---- GET /memories?limit=&offset=（记忆全量分页，记忆 Tab 页）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/memories`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          try {
            const q = new URL(req.url, 'http://localhost').searchParams;
            const limit = parseInt(q.get('limit') ?? '50', 10);
            const offset = parseInt(q.get('offset') ?? '0', 10);
            const data = listMemories({ limit: Number.isFinite(limit) ? limit : 50, offset: Number.isFinite(offset) ? offset : 0 });
            if (!data.ok) return writeJson(res, 500, { ok: false, error: data.error ?? 'memory-unavailable' }, NO_STORE);
            writeJson(res, 200, data, NO_STORE);
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
          }
        }
      });
      // ---- GET /report?file=（报告全文，白名单）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/report`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          try {
            const q = new URL(req.url, 'http://localhost').searchParams;
            const name = q.get('file') ?? '';
            if (!REPORT_NAME_RE.test(name)) return writeJson(res, 400, { ok: false, error: 'bad-file-name' }, NO_STORE);
            const file = path.join(REPORT_DIR, name);
            if (!file.startsWith(REPORT_DIR)) return writeJson(res, 400, { ok: false, error: 'bad-path' }, NO_STORE);
            const txt = fs.readFileSync(file, 'utf8');
            writeJson(res, 200, { ok: true, name, text: txt }, NO_STORE);
          } catch (e) {
            const code = e?.code === 'ENOENT' ? 404 : 500;
            writeJson(res, code, { ok: false, error: code === 404 ? 'not-found' : String(e?.message ?? e) }, NO_STORE);
          }
        }
      });
      // ---- /restart（GET 重启统筹状态 + 审计流水，只读；POST 排队/强制重启）----
      // webserver 路由按 (kind, path) 去重、不含 HTTP method，同一路径只能注册一次；
      // GET/POST 原为两个 exact 注册 → duplicate route，此处合并为单 handler 按 method 分发。
      register({
        kind: 'exact',
        path: `${API_PREFIX}/restart`,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            try {
              const status = await collectRestartHealth();
              const audit = collectRestartAudit(20);
              writeJson(res, 200, { ok: true, status, audit }, NO_STORE);
            } catch (error) {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
            }
          } else if (req.method === 'POST') {
            try {
              const body = await readBody(req);
              // ---- 【①-3 · P-6】签发路径（选 a：复用本端点加 mode:'confirm'，不新增写口）----
              //   只读地取一次「预计活跃数」+ 签发一次性确认令牌；**不改任何状态、不写请求文件**。
              //   取数路径 = `resolvePanelTarget().activeCount`（面板 POST 内现成，①包 §3.2 轮五 E3 改正）；
              //   ⚠️ **不得**用 `GET /restart` 的 `queue.activeCount` —— force 场景该块结构性为 null（E3/E4）。
              //   取不到（`activeCount:null`）⇒ 前端必须渲染「活跃数未知」，**不得渲染 0**。
              if (body?.mode === 'confirm') {
                const t = await resolvePanelTarget(body?.sessionId ?? null);
                const activeCount = Number.isFinite(t?.activeCount) ? t.activeCount : null;
                const issued = confirmTokens.issue(CONFIRM_ACTIONS.RESTART_FORCE, {
                  expectedActive: activeCount, expectedSource: t?.source ?? null, at: Date.now(),
                });
                auditPanel({
                  type: 'panel-confirm-issued', action: CONFIRM_ACTIONS.RESTART_FORCE, via: 'panel',
                  expectedActive: activeCount, expectedSource: t?.source ?? null, expiresAt: issued.expiresAt,
                });
                return writeJson(res, 200, {
                  ok: true, token: issued.token, expiresAt: issued.expiresAt, ttlMs: issued.ttlMs,
                  activeCount, activeCountKnown: activeCount !== null, activeCountSource: t?.source ?? null,
                  notifyTarget: t,
                }, NO_STORE);
              }
              const mode = body?.mode === 'force' ? 'force' : 'queue';
              // ---- 【G33·加急档·A3】档位透传（入口层 · 方案 §3.3 触发方式 / §4 载体表）----
              //   规则（与 CLI `--priority` 同口径）：`priority` 只接受 `normal` | `urgent`；
              //   **强制档只由 `mode:'force'` 表达**（它要一次性确认令牌 + 人工担责，与"分层等待"不是一回事）；
              //   非法值 **400 明拒**（不静默归一 —— 否则会出现"点了加急、实际按常规排队"的静默误解）。
              const priorityRaw = typeof body?.priority === 'string' ? body.priority.trim().toLowerCase() : '';
              if (priorityRaw && priorityRaw !== 'normal' && priorityRaw !== 'urgent') {
                if (priorityRaw === 'force' && mode !== 'force') {
                  return writeJson(res, 400, {
                    ok: false, code: 'force-needs-mode-force',
                    error: '强制档只由 mode:"force" 表达（且需一次性确认令牌）：请改用「立即强制重启」。',
                    hint: 'POST {mode:"confirm"} → 确认框 → POST {mode:"force", confirmToken}',
                  }, NO_STORE);
                }
                return writeJson(res, 400, {
                  ok: false, code: 'invalid-priority',
                  error: `无效的 priority：${priorityRaw}（只接受 normal|urgent；强制档用 mode:"force"）`,
                }, NO_STORE);
              }
              const priority = priorityRaw || (mode === 'force' ? 'force' : 'normal');
              const reason = typeof body?.reason === 'string' && body.reason.trim()
                ? body.reason.trim().slice(0, 200)
                : (mode === 'force' ? '面板立即强制重启' : (priority === 'urgent' ? '面板加急重启' : '面板排队重启'));
              // ---- 【①-3 · P-6】C⁺ 服务端强制：force 必须带一次性确认令牌 ----
              //   无令牌 / 令牌无效 / 已用过 / 过期 ⇒ 403 + 审计拒绝记录（**不静默**，①包 §3.6）。
              let expected = null;
              if (mode === 'force') {
                const c = confirmTokens.consume(CONFIRM_ACTIONS.RESTART_FORCE, body?.confirmToken);
                if (!c.ok) {
                  auditPanel({
                    type: 'confirm-token-rejected', action: CONFIRM_ACTIONS.RESTART_FORCE, via: 'panel',
                    code: c.code, mode, reason,
                  });
                  return writeJson(res, 403, {
                    ok: false, code: c.code ?? CONFIRM_CODES.INVALID,
                    error: '强制重启缺少有效的一次性确认令牌：界面须先 POST {mode:"confirm"} 取令牌 → 主人确认 → 带 confirmToken 提交。无令牌一律拒绝（本机制防误触/重复提交，不防恶意进程）。',
                    hint: 'POST {mode:"confirm"} → 确认框 → POST {mode:"force", confirmToken}',
                  }, NO_STORE);
                }
                expected = c.entry?.actor ?? null;
              }
              // 通知目标认定（2026-09-11 卡 [S*·重启通知]）：前端拿不到「当前打开的会话」，
              // 由 Host 认定「此刻唯一回合未收尾的会话」；0 个或 ≥2 个 → 无目标（宁可不发）。
              const notifyTarget = await resolvePanelTarget(body?.sessionId ?? null);
              const r = await requestRestart({
                mode, reason, sessionId: notifyTarget.sessionId, kind: 'panel',
                // 【G33·加急档·A3】档位随请求落盘（权威源 = 请求对象 `priority`）
                priority,
                expectedActive: mode === 'force' ? (expected?.expectedActive ?? null) : null,
                expectedSource: mode === 'force' ? (expected?.expectedSource ?? null) : null,
              });
              const status = await collectRestartHealth();
              writeJson(res, 200, {
                ok: true, mode, priority: r.priority, priorityRequested: r.priorityRequested, priorityIgnored: r.priorityIgnored,
                request: r.request, notifyTarget, pending: status?.requests?.pending ?? null,
                queue: status?.queue ?? null, heartbeat: status?.heartbeat ?? null,
              }, NO_STORE);
            } catch (error) {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
            }
          } else {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          }
        }
      });
      // ---- POST /ignore（忽略/恢复会话与卡）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/ignore`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          const body = await readBody(req);
          const kind = body?.kind === 'task' ? 'task' : 'session';
          const id = typeof body?.id === 'string' && body.id.trim() ? body.id.trim().slice(0, 64) : '';
          if (!id) return writeJson(res, 400, { ok: false, error: 'missing-id' }, NO_STORE);
          const r = mutateIgnore(kind, id, body.ignore !== false);
          if (!r.ok) {
            // 【①-3】失败**不静默**：审计留一行 + 响应带原因（原实现只回 write-failed，事后无从追）
            auditPanel({ type: 'panel-ignore', via: 'panel', kind, id, ignore: body.ignore !== false, result: 'write-failed', error: r.error });
            return writeJson(res, 500, { ok: false, error: 'write-failed', detail: r.error }, NO_STORE);
          }
          const next = r.data;
          // 【①-3 · ①-7】留痕：忽略/恢复是 B 级写口，原先**无痕**（①包 §2.1 第 2 项）
          auditPanel({ type: 'panel-ignore', via: 'panel', kind, id, ignore: body.ignore !== false, ignored: { sessions: next.sessions.length, tasks: next.tasks.length } });
          writeJson(res, 200, { ok: true, kind, id, ignore: body.ignore !== false, ignored: { sessions: next.sessions.length, tasks: next.tasks.length } }, NO_STORE);
        }
      });
      // ---- POST /ack（「知道了」—— 走 butler-watch CLI 唯一写口）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/ack`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          const body = await readBody(req);
          const token = typeof body?.token === 'string' ? body.token.trim() : '';
          // 2026-09-14：优先按**事件 id** ack —— 一次清光同 id 的全部延迟副本。
          //   背景：事件超 4h 未确认会「升级重推」，副本各自带 token 攒在 deferred 里，而面板同一
          //   id 只显示一条 ⇒ 只按 token ack 就是"点一条、冒一条"（实测主人连点 2 次才见到底）。
          //   id 与 token 同白名单；未带 id（旧客户端）时行为不变，仍按 token 精确 ack。
          const eventId = typeof body?.id === 'string' ? body.id.trim() : '';
          const target = eventId && ACK_TOKEN_RE.test(eventId) ? eventId : token;
          if (!ACK_TOKEN_RE.test(target)) {
            return writeJson(res, 400, { ok: false, error: 'invalid-token', hint: 'token/id 仅允许 [A-Za-z0-9_-]{1,80}（或字面量 all）' }, NO_STORE);
          }
          const r = runWatchCli(['--ack', target, '--home', dshHome()]);
          if (!r.ok) return writeJson(res, 500, { ok: false, error: r.error, hint: 'CLI 未执行成功；未 ack 状态未变' }, NO_STORE);
          // 写后立刻失效分片缓存：否则 TTL(300s) 内首屏仍是旧的未 ack 列表（主人会以为按钮没生效）
          invalidateCache(null);
          writeJson(res, 200, { ok: true, token, ackTarget: target, output: String(r.out ?? '').trim().slice(0, 600), cacheInvalidated: true }, NO_STORE);
        }
      });
      // ---- POST /false-positive（「标误报」—— 同样走 CLI 唯一写口）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/false-positive`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          const body = await readBody(req);
          const token = typeof body?.token === 'string' ? body.token.trim() : '';
          if (!ACK_TOKEN_RE.test(token)) {
            return writeJson(res, 400, { ok: false, error: 'invalid-token', hint: 'token 仅允许 [A-Za-z0-9_-]{1,80}' }, NO_STORE);
          }
          const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : '';
          const args = ['--false-positive', token];
          if (note) args.push('--note', note);
          args.push('--home', dshHome());
          const r = runWatchCli(args);
          if (!r.ok) return writeJson(res, 500, { ok: false, error: r.error, hint: 'CLI 未执行成功；误报标记未写入' }, NO_STORE);
          invalidateCache(null);
          writeJson(res, 200, { ok: true, token, note: note || null, output: String(r.out ?? '').trim().slice(0, 600), cacheInvalidated: true }, NO_STORE);
        }
      });
      // ---- POST /card（一键转看板卡）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/card`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          const body = await readBody(req);
          const sessionId = typeof body?.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : '';
          if (!sessionId) return writeJson(res, 400, { ok: false, error: 'missing-sessionId' }, NO_STORE);
          try {
            // ---- 【①-3 · ①-7】去重（①包 §3.1 `/card` 行 · §6 表 4）：同会话已有**在途卡**则拒建 ----
            //   （原实现 requestId 用 randomUUID ⇒ 同会话点两次 = 两张重复卡）
            const dup = await findInflightCards(sessionId);
            if (!dup.ok) {
              auditPanel({ type: 'panel-card', via: 'panel', sessionId, result: 'unavailable', error: dup.error });
              return writeJson(res, 503, {
                ok: false, code: 'BOARD_UNAVAILABLE',
                error: `无法查重（${dup.error}）：为避免重复建卡，本次拒绝建卡，请稍后重试。`,
              }, NO_STORE);
            }
            if (dup.hits.length > 0) {
              auditPanel({ type: 'panel-card', via: 'panel', sessionId, result: 'rejected-duplicate', cards: dup.hits.map((t) => t.id) });
              return writeJson(res, 409, {
                ok: false, code: 'DUPLICATE_INFLIGHT',
                error: `该会话已有在途卡「${dup.hits[0].title ?? dup.hits[0].id}」（${dup.hits[0].status}）：不重复建卡。`,
                cards: dup.hits.map((t) => ({ id: t.id, title: t.title, status: t.status })),
              }, NO_STORE);
            }
            const st = await buildState();
            const hit = (st.sessions?.interrupted ?? []).find((x) => x.fullId === sessionId || x.id === sessionId);
            const meta = hit
              ? { sessionId: hit.fullId ?? hit.id, title: hit.title ?? '', group: hit.group, lastActiveLabel: hit.lastActiveLabel }
              : { sessionId, title: '', group: '?', lastActiveLabel: '' };
            // 标题以主包投影为准（LLM 自动标题/改名不在 zstd 事件里，scan 会读旧/读不到）
            try {
              const map = await fetchMainTitleMap();
              const mainT = map.get(meta.sessionId.replace(/^session-/, '')) ?? '';
              if (mainT) meta.title = mainT;
            } catch { /* 降级：保留 scan 标题 */ }
            const result = await createBoardCard(meta);
            // 【①-3】留痕：建卡是 C 级写口（真会话会跑），原先**无痕**
            auditPanel({ type: 'panel-card', via: 'panel', sessionId, result: 'created', cardId: result.cardId, title: result.title, revision: result.revision });
            writeJson(res, 200, { ok: true, ...result }, NO_STORE);
          } catch (error) {
            auditPanel({ type: 'panel-card', via: 'panel', sessionId, result: 'failed', error: String(error?.message ?? error) });
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
          }
        }
      });
      // ---- P5：POST /audit-pass（审计通过 → 发凭证）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/audit-pass`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          if (!guard) return writeJson(res, 503, { ok: false, error: 'audit-guard-unavailable' }, NO_STORE);
          const body = await readBody(req);
          // ---- 【①-3 · P-6】C⁺：/audit-pass 是"放行一次受保护写入" ⇒ 一律要求一次性确认令牌 ----
          //   签发路径选 a（复用本端点加 mode:'confirm'，不新增写口）。
          if (body?.mode === 'confirm') {
            const issued = confirmTokens.issue(CONFIRM_ACTIONS.AUDIT_PASS, { at: Date.now() });
            auditPanel({ type: 'panel-confirm-issued', action: CONFIRM_ACTIONS.AUDIT_PASS, via: 'panel', expiresAt: issued.expiresAt });
            return writeJson(res, 200, { ok: true, token: issued.token, expiresAt: issued.expiresAt, ttlMs: issued.ttlMs }, NO_STORE);
          }
          {
            const c = confirmTokens.consume(CONFIRM_ACTIONS.AUDIT_PASS, body?.confirmToken);
            if (!c.ok) {
              auditPanel({ type: 'confirm-token-rejected', action: CONFIRM_ACTIONS.AUDIT_PASS, via: 'panel', code: c.code });
              return writeJson(res, 403, {
                ok: false, code: c.code ?? CONFIRM_CODES.INVALID,
                error: '发写入凭证缺少有效的一次性确认令牌：先 POST {mode:"confirm"} 取令牌 → 再带 confirmToken 提交。无令牌一律拒绝（防误触/重复提交，不防恶意进程）。',
                hint: 'POST {mode:"confirm"} → POST {path, contentHash, confirmToken}',
              }, NO_STORE);
            }
          }
          const target = typeof body?.path === 'string' ? body.path.trim() : '';
          const hash = typeof body?.contentHash === 'string' ? body.contentHash.trim().toLowerCase() : '';
          if (!target) return writeJson(res, 400, { ok: false, error: 'missing-path' }, NO_STORE);
          if (!/^[0-9a-f]{64}$/.test(hash)) return writeJson(res, 400, { ok: false, error: 'bad-content-hash' }, NO_STORE);
          const zone = classifyTarget(target);
          if (!zone || zone.tier !== 'A') {
            return writeJson(res, 200, { ok: false, code: 'NOT_PROTECTED', error: `目标不在 A 层保护区（${zone?.label ?? '普通路径'}）：B 层走写后审计，无需凭证` }, NO_STORE);
          }
          let forced = false;
          const forceReason = typeof body?.forceReason === 'string' && body.forceReason.trim() ? body.forceReason.trim().slice(0, 200) : null;
          if (forceReason) {
            const judge = guard.judgeForce({ actorSession: body?.actorSession ?? null });
            if (!judge.allowed) {
              return writeJson(res, 403, { ok: false, code: judge.code, error: judge.message, actor: judge.actor }, NO_STORE);
            }
            forced = true;
          }
          const pathKey = normalizePath(target);
          const entry = guard.issueToken(pathKey, hash, { source: 'cli', actor: body?.actorSession ?? null, reason: forceReason, runId: body?.runId ?? null });
          writeJson(res, 200, { ok: true, pathKey, expiresAt: entry.expiresAt, ttlMs: guard.tokens.ttlMs, forced, zone: zone.id }, NO_STORE);
        }
      });
      // ---- P5：GET/POST /audit-off（「暂停写入审计」逃生舱）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/audit-off`,
        handler: async (req, res) => {
          if (!guard) return writeJson(res, 503, { ok: false, error: 'audit-guard-unavailable' }, NO_STORE);
          // GET = 只读状态（顶栏常驻横幅 / 排障都读它）。附带 TTL 口径两个常量（只增不改名）。
          if (req.method === 'GET') return writeJson(res, 200, { ok: true, ...guard.off(true), maxTtlMs: AUDIT_OFF_MAX_MS, defaultTtlMs: AUDIT_OFF_DEFAULT_MS }, NO_STORE);
          if (req.method === 'POST') {
            const body = await readBody(req);
            // ---- 【①-3 · P-6】C⁺：/audit-off 让写入守门人闭眼 ⇒ 一律要求一次性确认令牌 ----
            //   签发路径选 a（复用本端点加 mode:'confirm'）。⚠️ 只读地给出"当前状态 + 关闭后果"供确认框渲染。
            if (body?.mode === 'confirm') {
              const cur = guard.off(true);
              const issued = confirmTokens.issue(CONFIRM_ACTIONS.AUDIT_OFF, { at: Date.now(), currentlyActive: cur?.active === true });
              auditPanel({ type: 'panel-confirm-issued', action: CONFIRM_ACTIONS.AUDIT_OFF, via: 'panel', currentlyActive: cur?.active === true, expiresAt: issued.expiresAt });
              return writeJson(res, 200, { ok: true, token: issued.token, expiresAt: issued.expiresAt, ttlMs: issued.ttlMs, currentlyActive: cur?.active === true }, NO_STORE);
            }
            {
              const c = confirmTokens.consume(CONFIRM_ACTIONS.AUDIT_OFF, body?.confirmToken);
              if (!c.ok) {
                auditPanel({ type: 'confirm-token-rejected', action: CONFIRM_ACTIONS.AUDIT_OFF, via: 'panel', code: c.code });
                return writeJson(res, 403, {
                  ok: false, code: c.code ?? CONFIRM_CODES.INVALID,
                  error: '切换写入审计暂停开关缺少有效的一次性确认令牌：先 POST {mode:"confirm"} 取令牌 → 主人确认 → 带 confirmToken 提交。无令牌一律拒绝（防误触/重复提交，不防恶意进程）。',
                  hint: 'POST {mode:"confirm"} → 确认框 → POST {off, reason, confirmToken}',
                }, NO_STORE);
              }
            }
            const r = (function () {
              const goingOff = body?.off !== false;
              // ---- 【卡「冲刺600 · audit-off 限时」】服务端 clamp + 必填理由（控制室口径包 §3.1 / §7.3②）----
              //   根因（①-3 报告 §四·1）：改前 `until = off && ttlMs>0 ? now+ttlMs : null`，
              //   而前端 client.js **根本不传 ttlMs** ⇒ 一键暂停 = 永不过期。clamp 必须在服务端。
              //   本段三道门（全 fail-closed，且**每次拒绝都留审计行**，绝不静默）：
              //     ① lib 不可用 → 拒（宁可不放行，也不放一个没有上限的洞）；
              //     ② 暂停（off=true）必须带非空理由（恢复不要求 —— 救命路径不能被参数校验卡死）；
              //     ③ ttlMs 经 `normalizeAuditOffTtl()` 归一化：不传 ⇒ 缺省 30min；超界 ⇒ clamp 到 30min；
              //        非法（NaN/负数/字符串垃圾/对象）⇒ 拒 + 400 + 审计行。
              if (!normalizeAuditOffTtl) {
                auditPanel({ type: 'audit-off-rejected', code: 'AUDIT_OFF_TTL_GUARD_UNAVAILABLE', via: 'panel' });
                return { status: 503, body: { ok: false, code: 'AUDIT_OFF_TTL_GUARD_UNAVAILABLE', error: 'TTL 守卫（butler lib audit-token.mjs）不可用 ⇒ 拒绝暂停写入审计（fail-closed：不允许出现无上限的暂停）。' } };
              }
              const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
              if (goingOff && !reason) {
                auditPanel({ type: 'audit-off-rejected', code: 'AUDIT_OFF_REASON_REQUIRED', via: 'panel' });
                return { status: 400, body: { ok: false, code: 'AUDIT_OFF_REASON_REQUIRED', error: '暂停写入审计必须填写理由（口径 §7.3②）——理由会进审计流水与告警，不接受空理由。', maxTtlMs: AUDIT_OFF_MAX_MS, defaultTtlMs: AUDIT_OFF_DEFAULT_MS } };
              }
              const ttl = normalizeAuditOffTtl(body?.ttlMs);
              if (goingOff && !ttl.ok) {
                auditPanel({ type: 'audit-off-rejected', code: ttl.code, requested: ttl.requested === undefined ? null : String(ttl.requested).slice(0, 40), via: 'panel' });
                return { status: 400, body: { ok: false, code: ttl.code, error: ttl.message, maxTtlMs: AUDIT_OFF_MAX_MS, defaultTtlMs: AUDIT_OFF_DEFAULT_MS } };
              }
              let wrote;
              try {
                wrote = guard.setOff({
                  off: goingOff,
                  reason: reason || undefined,
                  by: 'panel',
                  // ⚠️ 传**原始 requested**（不是 `ttl.ttlMs`）：clamp 的唯一执行点是 lib 的 writeAuditOff，
                  //   路由这次调用只负责"非法就拒"。若这里先按上限截断再传，lib 再归一化时就看不出
                  //   "被 clamp 过"（ttlClamped 会变 false）⇒ 留痕失真。requested=null（不传）时 lib 走缺省。
                  ttlMs: goingOff ? ttl.requested : undefined,
                });
              } catch (e) {
                auditPanel({ type: 'audit-off-rejected', code: String(e?.code ?? 'AUDIT_OFF_WRITE_FAILED'), error: String(e?.message ?? e).slice(0, 200), via: 'panel' });
                return { status: 500, body: { ok: false, code: String(e?.code ?? 'AUDIT_OFF_WRITE_FAILED'), error: String(e?.message ?? e) } };
              }
              // 面板侧留痕（guard 侧另有一条 audit-pause / audit-resume；这里补"请求被接受 + clamp 实况"）
              auditPanel({
                type: 'panel-audit-off',
                off: wrote.off === true,
                until: wrote.until ?? null,
                ttlMs: wrote.ttlMs ?? null,
                ttlClamped: wrote.ttlClamped === true,
                ttlRequested: wrote.ttlRequested ?? null,
                reason: wrote.reason ?? null,
                by: 'panel',
                via: 'panel',
              });
              // 与其它写口同口径：写后立刻失效服务端分片缓存（否则 TTL 30s 内「守门人」卡还是旧状态）
              invalidateCache(null);
              return { status: 200, body: { ok: true, ...wrote, maxTtlMs: AUDIT_OFF_MAX_MS, defaultTtlMs: AUDIT_OFF_DEFAULT_MS, cacheInvalidated: true } };
            })();
            return writeJson(res, r.status, r.body, NO_STORE);
          }
          return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
        }
      });
      // ---- P5：GET /audit-state（守门人状态 + 干预统计 / 分级校准数据）----
      register({
        kind: 'exact',
        path: `${API_PREFIX}/audit-state`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          let stats = null;
          try { stats = collectAuditStats(); } catch (e) { stats = { ok: false, error: String(e?.message ?? e) }; }
          writeJson(res, 200, { ok: true, guard: guard ? guard.stats() : null, stats }, NO_STORE);
        }
      });
      // ---- v0.6.0（规则 R4「开关是活的」/ kill switch L2）：GET /modules ----
      // 模块级熔断开关全景：describeModules() + 每个模块的 checkModuleAllowed()（L0 level / L1 owner+ownerOn /
      // L2 enabled+source+by/why/since / 最终 allowed+blockedBy）。只读，0 token。
      register({
        kind: 'exact',
        path: `${API_PREFIX}/modules`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          try {
            writeJson(res, 200, await collectModules(), NO_STORE);
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
          }
        }
      });
      // ---- v0.6.0：POST /modules/set —— 关/开单个模块（body {id, enabled, why}）----
      // why 必填（开关变更必须可溯源）；写路径 = butler lib 的 setModuleEnabled（原子写 + 审计 + moduleHistory），
      // 本插件**不新增第二套开关存储**。校验失败一律 400 + 明确 code。
      register({
        kind: 'exact',
        path: `${API_PREFIX}/modules/set`,
        handler: async (req, res) => {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          const body = await readBody(req);
          const r = await setModuleEnabledViaApi(body, { by: 'panel' });
          writeJson(res, r.status, r.body, NO_STORE);
        }
      });
      // ---- GET /v1/p4-candidates（坑升级候选，**只读**；2026-10-09 卡「冲刺600·批4-1」）----
      //   本路由**只读**：应答 = pending 候选前 N 条（`?limit=` 可调，硬顶 100）+ 计数 + 池路径。
      //   「采纳 / 忽略」两个动作**不在这里**：走下面既有的统一闸门 `POST /v1/action`
      //   （动作 id `p4-candidate-adopt` / `p4-candidate-reject`，实现在共享底座 manual-actions.mjs，
      //    真写由既有 CLI `tools\dsh-butler\mark-p4-adopted.mjs` 完成 —— 面板不另写第二套写库逻辑）。
      //   依赖 `lib/p4-candidates.mjs` ⇒ **必须同步 deploy.mjs 的 LIB_FILES**（否则实体里缺文件、boot 崩）。
      register({
        kind: 'exact',
        path: `${API_PREFIX}/v1/p4-candidates`,
        handler: async (req, res) => {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          try {
            const q = new URL(req.url, 'http://localhost').searchParams;
            const limit = parseInt(q.get('limit') ?? '', 10);
            writeJson(res, 200, collectP4Candidates({
              cap: Number.isFinite(limit) && limit > 0 ? limit : undefined,
            }), NO_STORE);
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
          }
        }
      });
      // ---- P1「会动手」：GET /v1/action（动作清单，只读）+ POST /v1/action（统一闸门）----
      //   【身份口径 · 如实写明】面板通道的到达边界 = 本机 loopback + GUI（webserver 本身**无鉴权**，
      //   E9 实测），与既有写口（/card、/ignore…）同风险档 ⇒ 这里的 `actor` 是**声明值**而非认证结果；
      //   缺 actor 时按 `owner-panel` 记账（只有面板这条通道有这个默认，直连 lib 的会话/脚本一律
      //   必须显式传 actor —— fail-close 在 lib 里，不靠这条路由自觉）。
      //   【写面】本路由**不直写任何状态**：动作自身只经 ① task-board Host API ② 预检报告 md
      //   ③ 审计 JSONL（lib/audit.mjs 的哈希链）。缺 dryRun 一律按预览处理（`dryRun !== false`）。
      register({
        kind: 'exact',
        path: `${API_PREFIX}/v1/action`,
        handler: async (req, res) => {
          // ⚠️ 方法分发形态**必须**与 `/restart` 同款（正向 `===` + else-if + else 405）：
          //   `lib\write-scope.mjs` 的 method 扫描只认这种 branch 形态；混用「正向 GET + 反向 `!== POST` 守卫」
          //   会让扫描器只解析出 GET ⇒ 写口表零差集判红（2026-09-28 实测踩过，别改回混用）。
          if (req.method === 'GET') {
            try {
              writeJson(res, 200, { ok: true, version: MANUAL_ACTIONS_VERSION, actions: describeManualActions() }, NO_STORE);
            } catch (error) {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) }, NO_STORE);
            }
          } else if (req.method === 'POST') {
            const body = await readBody(req);
            if (!body || typeof body !== 'object' || Array.isArray(body)) {
              return writeJson(res, 400, { ok: false, code: 'bad-body', message: '请求体必须是 JSON 对象：{actionId, params, dryRun, actor, expectedPlanHash}' }, NO_STORE);
            }
            const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.trim() : 'owner-panel';
            try {
              const r = await runManualAction({
                actionId: body.actionId,
                params: body.params,
                dryRun: body.dryRun !== false,
                actor,
                expectedPlanHash: body.expectedPlanHash,
                correlationId: body.correlationId,
              }, {
                // ⚠️ **看板 Host API 必须打本实例自己**（`localWebBase()` 处理了"测试实例 3090 ≠ 生产 3080"：
                //   它按 DSH_HOME 重定向判定并忽略继承来的 DSH_WEB_URL）。
                //   2026-09-28 真机实测踩过：不注入时 lib 默认打 3080 ⇒ **测试实例的动作全打到生产看板**
                //   （催办 update 报 invalid-action 是巧合掩盖，转卡那一下真在生产账本里建了一张卡，已清理）。
                board: makeBoardClient({ baseUrl: localWebBase() }),
              });
              const http = Number.isInteger(r?.http) ? r.http : (r?.ok ? 200 : 500);
              writeJson(res, http, r, NO_STORE);
            } catch (error) {
              writeJson(res, 500, { ok: false, code: 'runtime-error', message: String(error?.message ?? error) }, NO_STORE);
            }
          } else {
            writeJson(res, 405, { ok: false, error: 'method-not-allowed' }, NO_STORE);
          }
        }
      });
    } catch (error) {
      for (const dispose of disposers) dispose();
      throw error;
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'butler-panel: routes');

  // ═══════════════════════════════════════════════════════════════════════════
  // 【A 补 · 首屏 SWR 的配套 · 2026-10-21】插件起来后**预热一次** `core+feed`
  // 【2026-10-26 · 卡「面板首屏冷窗治本」· V3.0.0 判据 2】再**加一路周期预热**（默认 12 分钟）
  //   新增动机：条目超硬上限是**惰性删除** —— 不主动清，要等下一次 `peekCache` 才发现并
  //   `store.delete()`，而这一次访问同时还得**阻塞重算**（实测 1.5~3.9 s）⇒ 面板闲十几分钟后
  //   第一枪必破判据线（生产实测 10-21 16:46 = 1555 ms、10-25 12:32 = 3168 ms）。
  //   周期预热把条目 age 钉在 interval 以内 ⇒ 永远不会被删 ⇒ 任何时刻打开都有值可端（新鲜或 stale）。
  //
  //   为什么要有它：SWR 只治"缓存到期那一次"，治不了"重启后第一次打开"——缓存是空的，
  //   第一次打开必然冷算（现跑硬底 = 服务端自己算 core 片 1509 ms，必然超 1500 ms 判据线）。
  //   ⇒ 启动后延迟预热一次，把首屏那条缓存键（`cacheKeyOf(['core','feed'])` = `core+feed`）焐热。
  //
  //   周期取 12 分钟（`PREWARM_INTERVAL_DEFAULT_MS` = 720_000）的三条理由：
  //     ① **必须 < 900 s 硬上限**（`STATE_STALE_MAX_MS`）—— 超了条目照样被惰性删掉，等于没治；
  //     ② **必须 > 300 s TTL**（`STATE_CACHE_TTL_MS`）—— `peekCache` 在 age < TTL 时直接命中、
  //        根本不进重算 ⇒ 那一轮**空转、一次都不算**（"更勤"不等于"更暖"，只等于白跑）；
  //     ③ **不动 TTL** —— 主人 2026-10-21 拍板的是 SWR，不是"缓存更久"；
  //        `state-cache.mjs` L37 明令「不许把 TTL 调大来替代本机制」。
  //   余量 180 s 覆盖"预热那轮恰逢进程忙 / 单轮失败"。停摆成本（实测 F9）：每小时 ≤5 轮、
  //   每轮让整个 dsh 同步停摆 1.2~2.4 s ⇒ 每小时 6~12 s ≈ 0.2%~0.3% 墙钟。
  //
  //   为什么延迟 18 s（常量 = PREWARM_DELAY_MS，理由就在这里）：
  //     · 太早 = 跟 boot 抢资源（主包加载插件/建索引、生态面板冷价 1.6~1.7 s 都在前十几秒）；
  //     · 太晚 = 主人重启后一眼就想看面板，来不及焐；
  //     · 题面给的窗口是 15~20 s，取中段 18 s。
  //
  //   纪律（题面红线）：
  //     · 一次性那轮**保留**（继续焐当次首屏）；周期轮**与它完全同一条路径**
  //       （同一个 `parseParts(PREWARM_PARTS)` + 同一个 `buildShardPayload(..., {useCache:true})`
  //       ⇒ 同一把 `singleFlight` 锁、同一个缓存键，**绝不另写一套计算**）；
  //     · **不新增 tickd job**（周期预热是本进程内的定时器，不是调度器任务）；
  //     · 失败**静默 + 一行痕**（logger.warn），绝不抛到启动链、绝不阻塞 boot；
  //     · 定时器 `unref()`（不拽着进程）；插件 dispose 时 `clearTimeout` + `clearInterval` 都清；
  //     · `DSH_BUTLER_PANEL_NO_PREWARM=1` ⇒ **一次性 + 周期都关**（自检/测试实例用）；
  //     · `DSH_BUTLER_PANEL_PREWARM_INTERVAL_MS=0` ⇒ 显式不建 interval（等价改前行为）；
  //       非法值（NaN / 负数）⇒ 回落 720_000 并打一行 warn。
  // ═══════════════════════════════════════════════════════════════════════════
  ctx.effect(() => {
    if (process.env.DSH_BUTLER_PANEL_NO_PREWARM === '1') return () => { /* 显式关闭（一次性 + 周期都关） */ };
    let disposed = false;
    // 【V3.0.0 · 判据 15 缺口 A-1 · 2026-10-26】运行期开关「关/开」的状态切换各打一行痕（不刷日志）。
    let switchOffLogged = false;
    // ⚠️ 一次性轮与周期轮**共用这一个函数** —— 不许另写一套计算（否则缓存键/单飞锁会分叉）。
    const warmOnce = async (reason) => {
      if (disposed) return false;
      // 【运行期开关】`panelSwitches.swr === false` ⇒ **本次不真算**（零取数、零缓存写入）。
      //   为什么不拆定时器：拆了就没法"改键即开回"（要重启才回来）。这里**每次执行先查键**（5 s 缓存），
      //   所以键关后同一个定时器下一轮照样空转返回 ⇒ 判据「预热不跑」= 不产生任何计算，
      //   证据 = 缓存统计 `computes` 不增长 + 无「预热完成」日志（不是"定时器对象消失"）。
      //   键开 / 缺键 / 值非法 ⇒ 完全走下面原路径，与改前逐项等价。
      if (!panelSwitchOn('swr')) {
        if (!switchOffLogged) {
          switchOffLogged = true;
          try { ctx.logger?.info?.('[butler-panel] 预热已关（panelSwitches.swr=false）—— 开机/周期预热都不真算（定时器仍在，改回 true 即恢复，无需重启）'); } catch { /* ignore */ }
        }
        return false;
      }
      if (switchOffLogged) {
        switchOffLogged = false;
        try { ctx.logger?.info?.('[butler-panel] 预热已开回（panelSwitches.swr != false）—— 恢复 18 s 开机 + 每轮周期预热'); } catch { /* ignore */ }
      }
      try {
        const selection = parseParts(PREWARM_PARTS.join(','));
        const budget = createBudget(SHARD_BUDGET_MS);
        const sessionsIndex = () => fetchMainSessionIndex({ timeoutMs: Math.max(200, Math.min(MAIN_TITLE_TIMEOUT_MS, budget.remaining())) })
          .then((idx) => (Array.isArray(idx.sessions) ? idx.sessions : null))
          .catch(() => null);
        const payload = await buildShardPayload(selection, {
          budget,
          // 预热就是要**真算一次**（缓存空时 swr 本来也无差别；显式写死避免语义歧义）
          swr: false,
          deps: { baseUrl: localWebBase(), sessionsIndex, guard },
          // 走缓存，把结果留在进程内缓存里（`useCache` 默认 true，这里显式写出意图）
          useCache: true,
        });
        const c = payload?.meta?.cache ?? {};
        try {
          ctx.logger?.info?.(`[butler-panel] ${reason}预热完成：parts=${PREWARM_PARTS.join(',')} hit=${c.hit === true} computeMs=${c.computeMs ?? '-'} —— 首屏缓存已焐热`);
        } catch { /* 日志失败不影响 */ }
        return true;
      } catch (e) {
        // 一行痕即可：预热失败不影响任何功能（首次打开照旧冷算，之后由 SWR 兜）
        try { ctx.logger?.warn?.(`[butler-panel] ${reason}预热失败（忽略，不影响功能）：${e?.message ?? e}`); } catch { /* ignore */ }
        return false;
      }
    };
    const timer = setTimeout(() => { void warmOnce('开机'); }, PREWARM_DELAY_MS);
    timer.unref?.();
    const { ms: intervalMs, warn } = resolvePrewarmIntervalMs();
    if (warn) { try { ctx.logger?.warn?.(warn); } catch { /* ignore */ } }
    let ticker = null;
    if (intervalMs > 0) {
      ticker = setInterval(() => { void warmOnce('周期'); }, intervalMs);
      ticker.unref?.();
      try { ctx.logger?.info?.(`[butler-panel] 周期预热已开：每 ${intervalMs} ms 跑一次 core+feed（必须 > TTL 300000 且 < 硬上限 900000，详见代码注释）`); } catch { /* ignore */ }
    } else {
      try { ctx.logger?.info?.('[butler-panel] 周期预热已关（DSH_BUTLER_PANEL_PREWARM_INTERVAL_MS=0）—— 行为等于改前：只跑开机那一次'); } catch { /* ignore */ }
    }
    return () => {
      disposed = true;
      try { clearTimeout(timer); } catch { /* ignore */ }
      if (ticker) { try { clearInterval(ticker); } catch { /* ignore */ } }
    };
  }, 'butler-panel: warmup core+feed');
}

export { apply };
