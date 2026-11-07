// dsh-butler-panel / lib/shards.mjs
// 【卡 A1 · v1.1 修订块 B2】分片定义 + parts 解析 + 严格投影 + 逐片采集。
//
// 片（按耗时切，不按字段切；唯一真相 = 方案 v1.1 修订块 B2）：
//   core     meta + summary + sessions(含 interrupted) + tasks + watch.unacked(仅 id/level/title/at/ackToken)
//            + board.review(计数 + 前 N 条标题) + audit(计数)                        预算 ≤ 30 KB
//   health   独立片（生态面板 HTTP 2.7s 是它的固定价，首屏先出 core、health 异步后填）  ≤ 12 KB
//   feed     今日段：最近 8 条 + 总条数（实测今日段 71,796 B 必须截断；**不再返回 tail**）≤ 6 KB
//   assets   每注册组一行：组名 + 计数 + 最近异常数 + asOf                              ≤ 8 KB
//   metrics  六项指标（唯一入口 lib\metrics.mjs；A1 只冻结接口）                        ≤ 2 KB
//   contract persona 契约全文（默认不随 parts=core 返回；无参全量按甲案仍返回）       127 KB
//
//   【冲刺600·面板三小修 · 2026-10-10】新增两片**懒取档**（默认没人拉，只有显式 `?parts=` 才计算）：
//   healthdetail  健康监控**完整档**：`health` 片只带前端 buildHealth() 渲染所需字段，
//                 长尾数组（tidy.history / l2Observe 明细 / handoff.lines / facts.skipped /
//                 external.sources / restart.lastBatch.items / upgrades.pending 的第 5+ 条）**折叠成计数**
//                 （各留 `*Count` + `trimmed:true` 标记，绝不伪装成"本来就没有"）。本片回完整版。
//                 ⇒ `health` 片从实测 17.4 KB 降到 ~10 KB（预算 ≤ 12 KB 由结构性折叠保证，非放宽预算）。
//   metricsdetail 六项指标**完整档**：`metrics` 片硬 ≤ 2048 B，预算保险丝会把 part 级 `reason`
//                 删成 `reasonTrimmed:true`、`errors` 截到 24–48 字 ⇒ 本片给全文（含逐项 asOf / 文案）。
//                 前端「原因全文（点击展开）」按需拉这一次，**不进首屏**。
//
// 兼容铁律（B9）：本模块**只被新路径调用**。无参 `/state` 一律走 index.js 的原全量逻辑，
//   语义与改造前逐字一致；`buildState()` 的签名与默认返回保持不变（日报/周报/verify 直接 import 它）。
//
// 未知 parts 值：忽略 + 记 meta.unknownParts，**不 4xx**（R1）。
// 只读铁律：本模块不写任何文件（R7）；`~/.dsh` 下所有读取都是只读打开。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  dshHome, dshWorkspace, collectTasks, collectMemory, readIgnore, detectInterrupted,
  collectAuditStats, collectHealth, collectTidy, collectReports, readPersonaContract,
  changedTodayOf, localDayKey, OVERDUE_DAYS,
} from './state.js';
import { collectFalsePositive } from './checks.mjs';
import { STATE_CACHE_TTL_MS, SHARD_BUDGET_MS, cacheKeyOf, singleFlight, createBudget } from './state-cache.mjs';
// 【V3.0.0 · 判据 15 缺口 A-2 · 2026-10-26】面板运行期开关（前端据 `meta.panelSwitches` 一处 if 决定渲不渲染）。
import { readPanelSwitches } from './panel-switches.mjs';
import { collectMetrics } from './metrics.mjs';
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 path.join(home, name) 逐字节相同）。
import { butlerLib as butlerLibDir, statePathResolver } from './butler-root.mjs';
const resolveStatePath = await statePathResolver();

/** 已实现的片名（顺序即文档顺序）。
 *  【卡 V2-C】新增 `audit`（P5 守门人全量：stats + guard 运行时统计）与 `reports`（报告档案 +
 *  趋势；原 `reports` 只在**无参全量**里返回，Tab 化的「报告」「管家」都要它，故独立成片）。
 *  【卡 多端线·服务面健康 · 2026-10-11】新增 `service`（服务面总览 —— ⑤ 包 S-7 **挂点 1**：
 *  长连接存活 / 今日入站 / 丢线次数 / 推送台账末行 / 家人用量末行；判定**只有一份**，本片只渲染
 *  `dsh-butler\lib\secretary-health.mjs` 的结论 —— 见 `collectServiceShard` 头注）。 */
export const SHARD_NAMES = Object.freeze(['core', 'health', 'feed', 'assets', 'metrics', 'audit', 'reports', 'contract', 'cleanup', 'healthdetail', 'metricsdetail', 'service']);
/** 无参语义（兼容契约）：`parts` 缺省 = 旧行为全量。 */
export const FULL_PARTS = 'full';
/** 本机自调用基址（与 queue-watch.mjs 的 DEFAULT_BASE_URL 同源；测试实例由 index.js 传 3090）。 */
export const DEFAULT_BASE_URL = 'http://localhost:3080';

// ---------------------------------------------------------------------------
// 逐片 TTL（卡 V2-C · 方案 §5.3）
//   `contract` = **10 分钟**：persona 全文 127 KB，只在「管家」Tab 点开契约时才拉一次，
//   方案明确要求 10min TTL；其余片保持主人拍板的 300s 节奏（**不**按片细化成 5s/30s，
//   否则首屏组合键（V2-D 后 = core,metrics,feed）会退化成 5s TTL → 首屏缓存形同不存在，
//   冷启动（生态面板 HTTP 是固定价）会被放大 N 倍 —— 这是 V2-B 实测过的性能红线）。
//   组合请求（如 `?parts=core,contract`）取**保守值**：任一片为默认 TTL 即用 300s。
// ---------------------------------------------------------------------------
export const CONTRACT_TTL_MS = 600_000;
/** 按片集合给出缓存 TTL（默认 STATE_CACHE_TTL_MS）。 */
export function ttlForParts(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  const set = new Set(list.map((p) => String(p ?? '').trim().toLowerCase()));
  if (set.size === 1 && set.has('contract')) return CONTRACT_TTL_MS;
  return STATE_CACHE_TTL_MS;
}
/** core 冷启动总超时预算（B1③）。 */
export const CORE_BUDGET_MS = SHARD_BUDGET_MS;
/** core 内 watch.unacked 条数上限（B2：只带 id/level/title/at/ackToken）。 */
export const WATCH_UNACKED_CAP = 20;
/** core 内 board.review 标题条数上限。 */
export const BOARD_REVIEW_CAP = 12;
/**
 * 【卡 面板③·取数 · S1】board.review 的**条件请求**缓存（按看板 revision 判等，**不按时间过期**）。
 * 为什么：看板 `GET /api/task-board/state` 在 live 档要序列化 3.10 MB（现跑 175~2152 ms），
 *   而面板只用其中 `status=review` 的卡；看板侧本就实现了 `If-None-Match` 的 304 短路
 *   （`host-routes.ts#matchesRevision`：短路发生在快照构建**之前** ⇒ 3.1 MB 序列化全省）。
 * 有效性：复用键 = 看板 `revision`（`host-ledger.ts#commit` 每次改卡必 +1）⇒ 不会读到旧卡数据；
 *   双判据（执行会话是否还活着）**不缓存**，每次仍用最新 session 索引重算。
 */
const BOARD_COND_CACHE = { revision: null, review: null };
/** core 内 queue.alerts 条数上限（遗留① 面板红标通道 · 与 queue-watch「①②④」的告警视图同源）。 */
export const QUEUE_ALERTS_CAP = 12;
/** cleanup 片候选线条数上限（口径与 P0 模块的 `MAX_ITEMS_PER_TICK` 一致：8）。 */
export const CLEANUP_ITEM_CAP = 8;
/** feed 今日段条数上限（最近 N 条）。 */
export const FEED_ITEM_CAP = 8;
/** feed 今日段字节上限（超出时更早的条目不再带，超出部分只体现在 total 里）。 */
export const FEED_BYTES_CAP = 5_600;
/** health 片超时预算（生态面板 HTTP 是固定价，独立于 core 的 1.2s）。 */
export const HEALTH_BUDGET_MS = 6_000;
/** butler lib 目录（口径与 state.js 的 BUTLER_LIB_DIR 一致：面板独立可跑，不依赖 tools 树存在）。 */
const BUTLER_LIB_DIR = (process.env.BUTLER_LIB_DIR ?? '').trim() || butlerLibDir();

// ---------------------------------------------------------------------------
// 片白名单（R1：`?parts=core` 必须**子字段级**可断言；M3 要求 core 明写 sessions.interrupted）
//   null = 整段透传；数组 = 只透传这些子字段。
// ---------------------------------------------------------------------------
export const SHARD_FIELDS = Object.freeze({
  core: {
    meta: null,
    summary: ['running', 'todo', 'backlog', 'overdue', 'interrupted', 'changedToday', 'memories'],
    sessions: ['interrupted', 'activeGroups', 'endedRecent', 'scanned', 'unreadable', 'staleReflow', 'interruptedTail', 'asOf', 'relay'],
    tasks: ['revision', 'running', 'todo', 'backlog', 'overdue', 'recentClosed', 'asOf'],
    watch: null,
    board: null,
    queue: null,
    audit: ['ok', 'windowDays', 'totals', 'byCode', 'asOf'],
    // 【V2.9封口②·W2 接线】SLO 尾部 SLI 白名单（只透传结论值；`downs` 明细不进片 —— 载荷预算）
    sli: ['ok', 'at', 'version', 'items', 'memory', 'coverage', 'reason', 'asOf'],
  },
  feed: null,
  assets: null,
  metrics: null,
  audit: null,
  reports: null,
  health: null,
  contract: null,
  cleanup: null,
  // 【2026-10-11 卡 多端线·服务面健康】service 片整段透传（片内结构已由 collectServiceShard 定稿，
  //   字段全部来自判定库 ⇒ 不再二次裁剪；红线仍是「面板只渲染、不自算判定」）。
  service: null,
});

// ---------------------------------------------------------------------------
// parts 解析（未知值忽略 + 记录，绝不 4xx）
// ---------------------------------------------------------------------------
/**
 * 解析 `?parts=` 取值。
 * @param {string|string[]|null|undefined} raw
 * @returns {{isFull:boolean, requested:string[], unknown:string[], raw:string|null}}
 *   · 缺省/空串 → `isFull:true`（无参 = 旧行为全量，兼容契约）
 *   · 未知值 → 落 `unknown`（路由把它写进 `meta.unknownParts`，仍返回 200）
 *   · `all` 作为 `full` 的别名（便于手工调试；不是文档承诺的契约字段）
 */
export function parseParts(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : (raw === null || raw === undefined ? '' : String(raw));
  if (!text.trim()) return { isFull: true, requested: [FULL_PARTS], unknown: [], raw: null };
  const seen = new Set();
  const requested = [];
  const unknown = [];
  for (const piece of text.split(',')) {
    const name = piece.trim().toLowerCase();
    if (!name) continue;
    if (name === FULL_PARTS || name === 'all') {
      if (!seen.has(FULL_PARTS)) { seen.add(FULL_PARTS); requested.push(FULL_PARTS); }
      continue;
    }
    if (SHARD_NAMES.includes(name)) {
      if (!seen.has(name)) { seen.add(name); requested.push(name); }
      continue;
    }
    if (!seen.has('u:' + name)) { seen.add('u:' + name); unknown.push(name); }
  }
  if (requested.includes(FULL_PARTS)) return { isFull: true, requested: [FULL_PARTS], unknown, raw: text };
  if (requested.length === 0) return { isFull: false, requested: [], unknown, raw: text };
  return { isFull: false, requested, unknown, raw: text };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function pick(obj, keys) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (!Array.isArray(keys)) return obj;
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}
function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}
/** 文件源 asOf（B4/R3 三类之一：文件 = mtime）。 */
function fileAsOf(p) {
  const st = statOrNull(p);
  return { at: st ? st.mtimeMs : null, source: 'file-mtime' };
}
function truncate(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '…' : str;
}
function byteLen(v) {
  try { return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8'); } catch { return 0; }
}
/** 动态加载 butler lib（失败负缓存；绝不因缺库抛错）。 */
const butlerLibraries = new Map();
async function butlerLib(name) {
  if (butlerLibraries.has(name)) return butlerLibraries.get(name);
  let mod = null;
  try {
    mod = await import(pathToFileURL(path.join(BUTLER_LIB_DIR, name)).href);
  } catch { mod = null; }
  butlerLibraries.set(name, mod);
  return mod;
}
/** 单测用：清掉动态库缓存。 */
export function resetLibraryCache() { butlerLibraries.clear(); }

// ---------------------------------------------------------------------------
// core 片
// ---------------------------------------------------------------------------
/**
 * watch.unacked：调用 **butler lib 的 listUnacked**（B4#1 唯一权威源，面板禁止自算）。
 * 只带 id/level/title/detail/at/ackToken（B2：不含证据全文）。库不可用 → 显式"不可探测 + 原因"。
 * 2026-09-14：补 `detail`（人话一行）+ 把只读事件表（id→中文标题/级别）喂给 listUnacked 兜底
 *   —— 否则首页「② 待处理」只有英文 id 和灰点，主人看不懂。
 */
async function collectWatchUnacked(ctx) {
  const file = resolveStatePath('butler-watch-state.json', { home: dshHome() }).path;
  const asOf = fileAsOf(file);
  const j = readJsonFile(file);
  if (!j || typeof j !== 'object') {
    return { ok: false, reason: 'watch 状态文件缺失或不可读（不可探测）', file, count: null, items: [], asOf };
  }
  const wp = await butlerLib('watch-policy.mjs');
  if (!wp || typeof wp.listUnacked !== 'function') {
    return { ok: false, reason: 'watch-policy 库不可用（listUnacked 未导出，不可探测）', file, count: null, items: [], asOf };
  }
  // 事件表只作**显示兜底**（id → 中文标题 / 级别），不参与任何判据：判据仍只在 listUnacked 里。
  const we = await butlerLib('watch-events.mjs');
  const eventTitles = {};
  const eventLevels = {};
  for (const spec of we?.EVENT_SPECS ?? []) {
    if (!spec || !spec.id) continue;
    if (spec.title) eventTitles[spec.id] = spec.title;
    if (spec.level) eventLevels[spec.id] = spec.level;
  }
  try {
    const r = wp.listUnacked(j, { now: ctx.now, eventTitles, eventLevels });
    const items = (r.items ?? []).slice(0, WATCH_UNACKED_CAP).map((it) => ({
      id: String(it.id ?? ''),
      level: it.level ?? null,
      title: truncate(it.title, 60),
      detail: truncate(it.detail, 200),
      at: it.at ?? null,
      ackToken: it.ackToken ?? null,
    }));
    return {
      ok: true,
      file,
      count: r.count ?? items.length,
      returned: items.length,
      oldestAt: r.oldestAt ?? null,
      deduped: r.deduped ?? 0,
      items,
      asOf,
    };
  } catch (e) {
    return { ok: false, reason: 'listUnacked 抛错：' + String(e?.message ?? e), file, count: null, items: [], asOf };
  }
}

/**
 * board.review：走 **Host API** `/api/task-board/state` + **双判据**（R2-12/R2-13）。
 * 双判据第二半（执行会话是否还活着）复用 `queue-watch.mjs` 的 `isExecutionAlive`，**面板不复制口径**。
 * sessions 由调用方注入（同一份 session.list 结果，零额外 RPC）；拿不到 → `aliveKnown:false`（显式标注，不假值）。
 *
 * 【卡「冲刺600·补面板残余」· gap-1-29 · 2026-10-10】**asOf 确定性契约**（见 `BOARD_ASOF_CONTRACT`）：
 *   rpc 源 = **取用时刻**（与本文件 :407 `asOf.sessions = {at: now, source:'scan'}` 同款口径，B4/R3 原文）；
 *   **采集失败路径也写取用时刻**，失败信息走 `degraded:true` + `reason`（短代码，见下表），
 *   ⇒ `at` 不再出现 `null`（旧形态 `{at:null, source:'rpc'}` 会让同一片两次读数一个 null 一个时刻，
 *      R3 断言只能降级成 WARN，属**读数不稳定**的根因）。
 *   `reason` 取值域（有限枚举，加值必须同步改断言）：
 *     `lib-unavailable` | `budget-exhausted` | `rpc-error` | `rpc-not-ok`
 */
const BOARD_ASOF_REASON = Object.freeze({
  LIB_UNAVAILABLE: 'lib-unavailable',
  BUDGET_EXHAUSTED: 'budget-exhausted',
  RPC_ERROR: 'rpc-error',
  RPC_NOT_OK: 'rpc-not-ok',
});
/** asOf 契约自证（被 `_test/verify-panel-v2.mjs` R3.board 断言；改口径必须同步改断言）。 */
export const BOARD_ASOF_CONTRACT = Object.freeze({
  source: 'rpc',
  at: '恒为有限毫秒数（= 本次探测的取用时刻，不是数据时刻）',
  okFalseRequires: ['degraded:true', 'reason ∈ BOARD_ASOF_REASON'],
  reasonDomain: Object.values(BOARD_ASOF_REASON),
});
/**
 * 【卡 面板③·取数 · S2】按需取会话索引（宿主 RPC `session.list`，现跑 median 610.4 ms / 314 KB）。
 * 为什么按需：它在 core 里的**唯一**下游是「双判据第二半」（执行会话是否还活着）；
 *   一张待验收卡都没有时没有需要判的对象 ⇒ 这次 RPC 一次都不该发。
 * 口径：① 调用方直接给了数组（`deps.sessions`，单测/旧调用方）就用它；
 *      ② 待判卡数 ≤ 0 ⇒ 返回 null（调用方把 `aliveKnown` 按「0 张卡」改判 true，不再画假告警）；
 *      ③ 否则调 `deps.sessionsIndex()`（`index.js` 注入的 thunk），失败/超时 ⇒ null（显式降级，不假值）。
 */
async function resolveSessionsFor(ctx, needCount) {
  if (Array.isArray(ctx.sessions)) return ctx.sessions;
  if (needCount <= 0) return null;
  if (typeof ctx.sessionsIndex !== 'function') return null;
  try {
    const v = await ctx.sessionsIndex();
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}
async function collectBoardReview(ctx) {
  // 取用时刻（**一次采集只取一次**）：成功/失败两条路共用同一个值 ⇒ 读数确定、可断言。
  const asOf = { at: Date.now(), source: 'rpc' };
  /** 失败路径的显式降级标记（`at` 照旧是取用时刻，绝不写 null 假值）。 */
  const degrade = (reason) => ({ ...asOf, degraded: true, reason });
  const qw = await butlerLib('queue-watch.mjs');
  if (!qw || typeof qw.readBoard !== 'function' || typeof qw.isExecutionAlive !== 'function') {
    return { ok: false, reason: 'butler queue-watch 库不可用（不可探测）', count: null, items: [], asOf: degrade(BOARD_ASOF_REASON.LIB_UNAVAILABLE) };
  }
  if (!ctx.budget.allow('board', 400)) {
    return { ok: false, reason: '超时预算不足，未探测 Host API（不可探测）', count: null, items: [], asOf: degrade(BOARD_ASOF_REASON.BUDGET_EXHAUSTED) };
  }
  const timeoutMs = Math.max(200, Math.min(ctx.budget.remaining(), 900));
  let board;
  try {
    board = await qw.readBoard({
      baseUrl: ctx.baseUrl,
      timeoutMs,
      ...(typeof ctx.fetchImpl === 'function' ? { fetchImpl: ctx.fetchImpl } : {}),
      // 【卡 面板③·取数 · S1】带上上次的看板 revision：没变就 304（0 B，省掉 3.1 MB 序列化+传输+解析）。
      ...(BOARD_COND_CACHE.review !== null && BOARD_COND_CACHE.revision !== null
        ? { ifNoneMatch: '"' + String(BOARD_COND_CACHE.revision) + '"' }
        : {}),
    });
  } catch (e) {
    return { ok: false, reason: 'Host API 调用失败：' + String(e?.message ?? e), count: null, items: [], asOf: degrade(BOARD_ASOF_REASON.RPC_ERROR) };
  }
  if (!board?.ok) {
    return { ok: false, reason: 'Host API 不可用：' + String(board?.error ?? 'unknown'), count: null, items: [], asOf: degrade(BOARD_ASOF_REASON.RPC_NOT_OK) };
  }
  // 【卡 面板③·取数 · S1】304 = 看板说"跟上次一模一样" ⇒ 复用上次的 review 卡列表（判据仍是下面的双判据）。
  const cards = board.notModified === true && Array.isArray(BOARD_COND_CACHE.review)
    ? BOARD_COND_CACHE.review
    : (Array.isArray(board.review) ? board.review : []);
  if (board.notModified !== true) {
    BOARD_COND_CACHE.review = cards;
    BOARD_COND_CACHE.revision = board.revision ?? null;
  }
  // 【卡 面板③·取数 · S2】会话索引按需：只有真有「待验收卡」要判第二半时才要它（0 张 ⇒ 一次都不发）。
  const sessions = await resolveSessionsFor(ctx, cards.length);
  const rows = cards.map((c) => {
    const alive = sessions
      ? qw.isExecutionAlive(c, sessions)
      : { known: false, alive: false, reason: 'session-list-unavailable' };
    return {
      id: c.id,
      title: truncate(c.title, 60),
      seq: c.seq ?? null,
      updatedAt: c.updatedAt ?? null,
      // 双判据：known && !alive = 执行会话已真结束（可验收）；known && alive = 疑似假结算
      settled: alive.known === true && alive.alive === false,
      execAlive: alive.alive === true,
      aliveReason: alive.reason ?? null,
    };
  });
  return {
    ok: true,
    revision: board.revision ?? BOARD_COND_CACHE.revision ?? null,
    count: rows.length,
    settledCount: rows.filter((r) => r.settled).length,
    aliveCount: rows.filter((r) => r.execAlive).length,
    // 【卡 面板③·取数 · S2】0 张卡 ⇒ 没有需要判的对象，aliveKnown 记 true（否则前端会画一条"session.list 不可得"的假告警）。
    aliveKnown: sessions !== null || rows.length === 0,
    reason: sessions === null && rows.length > 0 ? 'session.list 不可得 → 双判据第二半未判定（不按已结束处理）' : null,
    items: rows.slice(0, BOARD_REVIEW_CAP).map(({ id, title, seq, updatedAt, settled, execAlive }) => ({ id, title, seq, updatedAt, settled, execAlive })),
    // 【gap-1-29】成功路径与失败路径共用同一个取用时刻（同一个 `asOf` 对象）⇒ 读数确定。
    asOf,
  };
}

/**
 * queue.alerts：**队列推进巡检的失败态**（遗留① 面板红标通道 · 2026-09-17）。
 * 动机：队列的失败态（注入失败 / 四门挡下 / 疑似假结算 / 无目标 / 升级仍滞留）过去只落桌宠 + 日报段
 *   + `%TEMP%` 日志，面板「② 待处理」一条都看不到 —— 不开日报就完全看不见"提醒发不出去"。
 * 口径：**判据不在面板**。本函数只读 `butler-queue-notify.json` 并调 `queue-watch.mjs#alertsOf`
 *   （唯一真源，与 CLI `--status` / `--alerts` 同一份输出）；**面板绝不复制告警判定**（同 listUnacked 纪律）。
 * 降级：队列库版本旧（无 alertsOf）→ `degraded:true` + 原因 + 空明细（**绝不自己算一份**）。
 * 写动作：无。面板只展示；告警的消解发生在队列侧（卡离开 review / 目标恢复 / 四门放行），
 *   下一轮 tick（≤1 分钟）自动消失 —— 因此**不接 panel 的 ack 写口**（队列台账没有 ackToken 语义）。
 */
async function collectQueueAlerts(ctx) {
  const file = resolveStatePath('butler-queue-notify.json', { home: dshHome() }).path;
  const asOf = fileAsOf(file);
  const j = readJsonFile(file);
  if (!j || typeof j !== 'object') {
    return { ok: false, degraded: false, reason: '队列台账缺失或不可读（butler-queue-notify.json 不在本机 → 不可探测）', file, stats: null, items: [], asOf };
  }
  const qw = await butlerLib('queue-watch.mjs');
  if (!qw || typeof qw.alertsOf !== 'function') {
    // 队列库未部署 alertsOf（旧版）——面板**不自己判**，如实说"看不了"
    return {
      ok: false, degraded: true, file, asOf, items: [], stats: null,
      reason: '队列表 queue-watch.mjs 未提供 alertsOf（版本旧）→ 告警视图不可得；升级队列侧 lib/queue-watch.mjs 即可（面板不复制判据）',
    };
  }
  try {
    const cfg = typeof qw.loadConfig === 'function'
      ? (() => { try { return qw.loadConfig({ home: dshHome() }); } catch { return null; } })()
      : null;
    const r = qw.alertsOf(j, { now: ctx.now, cfg, cap: QUEUE_ALERTS_CAP });
    const items = (r.items ?? []).slice(0, QUEUE_ALERTS_CAP).map((a) => ({
      taskId: String(a.taskId ?? ''),
      seq: a.seq ?? null,
      line: truncate(a.line, 40),
      title: truncate(a.title, 60),
      level: a.level === 'red' ? 'red' : 'yellow',
      label: truncate(a.label, 40),
      detail: truncate(a.detail, 200),
      ageMin: a.ageMin ?? null,
      source: a.source ?? null,
      notifiedAt: a.notifiedAt ?? null,
      escalatedAt: a.escalatedAt ?? null,
      execAlive: a.execAlive === true,
    }));
    return {
      ok: true,
      degraded: false,
      file,
      count: r.stats?.count ?? items.length,
      returned: items.length,
      byLevel: r.stats?.byLevel ?? null,
      entries: r.stats?.entries ?? null,
      version: r.version ?? null,
      items,
      asOf,
    };
  } catch (e) {
    return { ok: false, degraded: false, reason: 'alertsOf 抛错：' + String(e?.message ?? e), file, stats: null, items: [], asOf };
  }
}

/** 变更流水"今日有记"（只 stat 最新文件，不读全文——全文归 feed 片）。 */
function changelogFreshness(now) {
  const dir = path.join(dshWorkspace(), 'docs', '变更流水');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n)); } catch { return { ok: false, dir, asOf: { at: null, source: 'file-mtime' } }; }
  if (files.length === 0) return { ok: false, dir, asOf: { at: null, source: 'file-mtime' } };
  const stats = files.map((f) => ({ f, st: statOrNull(f) })).filter((x) => x.st);
  if (stats.length === 0) return { ok: false, dir, asOf: { at: null, source: 'file-mtime' } };
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const file = stats[0].f;
  return {
    ok: true,
    file: path.basename(file),
    mtime: stats[0].st.mtimeMs,
    changedToday: changedTodayOf(stats[0].st.mtimeMs, now),
    asOf: { at: stats[0].st.mtimeMs, source: 'file-mtime' },
  };
}

/**
 * 【V2.9封口②·W2 接线】SLO 尾部 SLI —— ① 守护鱼可用率 / ② dsh 服务可用率 / ③ 会话成功率 /
 *   ⑧ 回滚成功率（+ §3.7.5 内存）。这就是 A 域 L149/L160「面板侧接线尾部 4 项采集器」的**面板消费口**。
 * 口径与判定**唯一真源** = `dsh-butler\lib\slo-tail.mjs`（本函数只取结论、**不复制任何统计**）。
 * 字节预算：走 `sliTailLite()` 瘦载荷（全量 `sliTailReport()` 实测 ≈ 27.7 KB，禁进片）。
 * 失败 / 库不可用 ⇒ 显式「不可探测 + 原因」，**绝不显示假值**（面板既有纪律）。
 */
async function collectSliShard() {
  const lib = await butlerLib('slo-tail.mjs');
  if (!lib || typeof lib.sliTailLite !== 'function') {
    return { ok: false, reason: 'slo-tail 库不可用（sliTailLite 未导出，不可探测）' };
  }
  try {
    return lib.sliTailLite({});
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

/** core 片采集（同步源优先，异步源走预算）。 */
async function collectCoreShard(ctx) {
  const now = ctx.now;
  const asOf = {};
  const ignore = (() => { try { return readIgnore(); } catch { return { sessions: [], tasks: [] }; } })();
  const igSess = new Set(ignore.sessions ?? []);
  const igTask = new Set(ignore.tasks ?? []);
  const filterTasks = (list) => (list ?? []).filter((t) => !igTask.has(t.id));

  // ① 任务看板（直读账本，只读）
  let tasks;
  try {
    tasks = collectTasks();
  } catch (e) {
    tasks = { revision: 0, running: [], todo: [], backlog: [], overdue: [], recentClosed: [], error: String(e?.message ?? e) };
  }
  asOf.tasks = fileAsOf(path.join(dshHome(), 'task-board', 'ledger-v2.json'));

  // ② 会话扫描（含 interrupted）
  let sessions;
  try {
    sessions = detectInterrupted();
  } catch (e) {
    sessions = { interrupted: [], activeGroups: [], endedRecent: 0, scanned: 0, unreadable: 0, staleReflow: 0, interruptedTail: 0, error: String(e?.message ?? e) };
  }
  const interrupted = (sessions.interrupted ?? []).filter((x) => !igSess.has(x.id));
  // RPC/扫描类 asOf：取用时刻（B4/R3：RPC 源 = 取用时刻 + asOfSource:'rpc'）
  asOf.sessions = { at: now, source: 'scan' };

  // ③ 变更流水新鲜度（只 stat；全文归 feed 片）
  const changelog = changelogFreshness(now);
  asOf.changelog = changelog.asOf ?? { at: null, source: 'file-mtime' };

  // ④ 记忆脉搏
  let memory;
  try { memory = collectMemory(); } catch (e) { memory = { ok: false, error: String(e?.message ?? e) }; }
  asOf.memory = fileAsOf(path.join(dshHome(), 'memory', 'memory.db'));

  // ⑤ P5 审计计数（core 只带计数，不带 recentBlocks/calibration）
  let audit;
  try { audit = collectAuditStats(); } catch (e) { audit = { ok: false, error: String(e?.message ?? e) }; }
  asOf.audit = (() => {
    const dir = path.join(dshHome(), 'butler-audit');
    const st = statOrNull(dir);
    return { at: st ? st.mtimeMs : null, source: 'file-mtime' };
  })();

  // ⑥⑦⑧ + ⑨（W2 接线）**并行**：
  //   【V2.9封口②·W2 性能】原串行三段各自发 HTTP/RPC（实测 core 冷取 460~739 ms 大头在此）；
  //   四段互不依赖 ⇒ 并行后 core 冷价 ≈ **最慢一段**。
  //   ⚠️ 装配顺序与串行版**逐字节同序**（asOf 赋值顺序仍 ⑥⑦⑧⑨），只是发起时机提前。
  const [watch, board, queue, sli] = await Promise.all([
    collectWatchUnacked(ctx),   // ⑥ watch.unacked（唯一权威源 listUnacked）
    collectBoardReview(ctx),    // ⑦ board.review（Host API + 双判据）
    collectQueueAlerts(ctx),    // ⑧ queue.alerts（遗留① 面板红标通道）
    collectSliShard(),          // ⑨ SLO 尾部 SLI（W2 接线；纯只读本地文件，实测 105~124 ms）
  ]);
  asOf.watch = watch.asOf ?? { at: null, source: 'file-mtime' };
  asOf.board = board.asOf ?? { at: null, source: 'rpc' };
  asOf.queue = queue.asOf ?? { at: null, source: 'file-mtime' };
  asOf.sli = { at: Date.now(), source: 'file-mtime' };

  // ⑨ relay（**会话接力 · 2026-09-22 卡 S1 新增：只读一行** —— 不动任何既有告警逻辑）
  //   口径：直接复用 `session-relay.mjs` 的 `relayPanelSummary()`（**纯只读**：不建锁、不清残留、不归档）。
  //   失败降级 = 显式 `{error}`（面板显示"不可探测"），**不**让它拖垮 core 片。
  let relay = null;
  try {
    const srMod = await import(pathToFileURL(path.join(dshWorkspace(), 'tools', 'session-relay.mjs')).href);
    relay = srMod.relayPanelSummary({ home: dshHome() });
  } catch (e) { relay = { error: String(e?.message ?? e) }; }
  // ⚠️ **不单列 `asOf.relay`** —— relay 摘要是 `sessions` 的子字段，沿用 `asOf.sessions`；
  //    且既有不变量单测限定 asOf 来源 ∈ {file-mtime, scan, rpc} 三类（加第四类会红）。

  const summary = {
    running: filterTasks(tasks.running).length,
    todo: filterTasks(tasks.todo).length,
    backlog: filterTasks(tasks.backlog).length,
    overdue: filterTasks(tasks.overdue).length,
    interrupted: interrupted.length,
    changedToday: changelog.ok && changelog.changedToday ? 1 : 0,
    memories: memory.ok ? memory.total : -1,
  };

  const result = {
    meta: {
      overdueDays: OVERDUE_DAYS,
      ignored: { sessions: (ignore.sessions ?? []).length, tasks: (ignore.tasks ?? []).length },
      asOf,
    },
    summary: pick(summary, SHARD_FIELDS.core.summary),
    sessions: pick({ ...sessions, interrupted, asOf: asOf.sessions, relay }, SHARD_FIELDS.core.sessions),
    tasks: pick({
      ...tasks,
      running: filterTasks(tasks.running),
      todo: filterTasks(tasks.todo),
      backlog: filterTasks(tasks.backlog),
      overdue: filterTasks(tasks.overdue),
      asOf: asOf.tasks,
    }, SHARD_FIELDS.core.tasks),
    watch,
    board,
    queue,
    audit: pick({ ...audit, asOf: asOf.audit }, SHARD_FIELDS.core.audit),
    // ⑨ SLO 尾部 SLI（【V2.9封口②·W2 接线】）：瘦载荷 + 白名单裁剪（面板片硬字节预算）
    sli: pick({ ...sli, asOf: asOf.sli }, SHARD_FIELDS.core.sli),
  };
  // 【V2-B 接线】把 core 的采集结果共享给**同一请求内**的 metrics 片（A2 接入清单 ③）：
  //   "复用同一份 sources 才能满足 R5 的缓存/实时两路 sha256 相等"。只读引用，不改写。
  if (ctx.shared && typeof ctx.shared === 'object') ctx.shared.core = result;
  return result;
}

// ---------------------------------------------------------------------------
// feed 片（今日段：最近 N 条 + 总条数；**不再返回 tail** —— R2-8 同一段文本发两遍）
//   V2-B：再挂一段 `advice`（当日日报的「## 💡 建议」段 = P2.5 产物）——首屏块 1 的建议
//   唯一来源。**只读解析已生成内容，绝不调用 generateAdvice / callZhipu**（B5 硬约束）。
// ---------------------------------------------------------------------------
/**
 * 当日日报的「## 💡 建议」段（**只解析，不生成**）。
 * @param {{now?:number, dir?:string, limit?:number}} [opts]
 * @returns 找不到当日日报 / 没有该段 → `{ok:false, reason}`（前端显示"今日未生成"，绝不造假）
 */
export function collectAdviceShard(opts = {}) {
  const now = opts.now ?? Date.now();
  const day = localDayKey(now);
  const limit = Math.max(1, Number(opts.limit ?? 3));
  const dir = opts.dir ?? path.join(dshWorkspace(), 'docs', '管家报告');
  const miss = (reason) => ({ ok: false, day, reason, items: [], total: 0, asOf: { at: null, source: 'file-mtime' } });
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(n));
  } catch {
    return miss('管家报告目录不可读（不可探测）');
  }
  const sameDay = names.filter((n) => n.startsWith(day + '-') || n === day + '.md');
  if (sameDay.length === 0) return miss(`当日日报（${day}）尚未生成`);
  // 双机同名日报会随三仓同步过来 → 优先本机（hostname 前缀），退化为 mtime 最新
  const host = String(os.hostname() ?? '').toLowerCase();
  const scoped = sameDay.filter((n) => n.toLowerCase().includes(host.slice(0, 6)));
  const pick = (list) => list.map((n) => ({ n, st: statOrNull(path.join(dir, n)) }))
    .filter((x) => x.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0]?.n ?? list[0];
  const name = pick(scoped.length ? scoped : sameDay);
  const file = path.join(dir, name);
  const st = statOrNull(file);
  const asOf = { at: st ? st.mtimeMs : null, source: 'file-mtime' };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return miss('日报文件不可读'); }
  const lines = text.split(/\r?\n/);
  // 段头必须**精确**是「## 💡 建议」——日报里另有「## 💡 统筹提示（P7 会照应）」，
  //   用 includes('建议') 之类宽匹配会把统筹提示整段吃进来（2026-09-14 实测）。
  const head = lines.findIndex((l) => {
    const t = l.trim();
    return t.startsWith('##') && t.includes('💡') && /建议\s*$/.test(t.replace(/^#+\s*/, ''));
  });
  if (head < 0) return { ...miss(`日报（${name}）内没有「## 💡 建议」段`), file: name, asOf };
  const items = [];
  let meta = null;
  for (let i = head + 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith('##')) break;
    if (!t) continue;
    if (t.startsWith('>')) { meta = truncate(t.replace(/^>\s*/, ''), 160); continue; }
    const m = t.match(/^[-*]\s+(.*)$/);
    if (!m) continue;
    const label = (m[1].match(/【([^】]{1,24})】/) ?? [])[1] ?? null;
    items.push({ text: truncate(m[1], 200), label });
  }
  const total = items.length;
  if (total === 0) return { ...miss(`日报（${name}）「## 💡 建议」段为空`), file: name, asOf };
  return {
    ok: true,
    day,
    file: name,
    items: items.slice(0, limit),
    total,
    note: meta,
    asOf,
    authority: '日报「## 💡 建议」段（P2.5 产物）· 只读解析，**不调用 LLM**（B5）',
  };
}

/**
 * @param {{now?:number, limit?:number, bytesCap?:number, dir?:string}} [opts]
 */
function collectChangelogToday(opts = {}) {
  const now = opts.now ?? Date.now();
  const cap = Math.max(1, Number(opts.limit ?? FEED_ITEM_CAP));
  const bytesCap = Number(opts.bytesCap ?? FEED_BYTES_CAP);
  const dir = opts.dir ?? path.join(dshWorkspace(), 'docs', '变更流水');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n)); } catch {
    return { ok: false, reason: '变更流水目录不可读（不可探测）', dir, asOf: { at: null, source: 'file-mtime' } };
  }
  if (files.length === 0) return { ok: false, reason: '变更流水目录为空', dir, asOf: { at: null, source: 'file-mtime' } };
  files.sort((a, b) => (statOrNull(b)?.mtimeMs ?? 0) - (statOrNull(a)?.mtimeMs ?? 0));
  const file = files[0];
  const st = statOrNull(file);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: '变更流水文件不可读', file, asOf: { at: st?.mtimeMs ?? null, source: 'file-mtime' } }; }
  const todayMd = (localDayKey(now) ?? '').slice(5);
  const lines = text.split(/\r?\n/);
  const heads = [];
  lines.forEach((l, i) => {
    const m = l.match(/^##\s*(\d{2}-\d{2})\s*$/);
    if (m) heads.push({ date: m[1], line: i });
  });
  let g = null;
  for (let i = heads.length - 1; i >= 0; i--) { if (heads[i].date === todayMd) { g = heads[i]; break; } }
  const changedToday = changedTodayOf(st?.mtimeMs ?? null, now);
  const base = {
    ok: true,
    file: path.basename(file),
    mtime: st?.mtimeMs ?? null,
    changedToday,
    asOf: { at: st?.mtimeMs ?? null, source: 'file-mtime' },
  };
  if (!g) {
    return { ...base, today: { date: todayMd, total: 0, returned: 0, truncated: false, bytes: 0, items: [] } };
  }
  const endLine = heads.find((h) => h.line > g.line)?.line ?? lines.length;
  const entries = [];
  let cur = null;
  for (const raw of lines.slice(g.line + 1, endLine)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^-\s*(\d{1,2}:\d{2})\s*(.*)$/);
    if (m) {
      const segs = m[2].split('｜').map((s) => s.trim()).filter(Boolean);
      cur = { time: m[1], main: truncate(segs[0] ?? '', 140), meta: segs.slice(1, 4).map((s) => truncate(s, 80)) };
      entries.push(cur);
      continue;
    }
    if (cur) {
      cur.extra = cur.extra ?? [];
      if (cur.extra.length < 2) cur.extra.push(truncate(line.replace(/^[-*>#\s]+/, ''), 80));
    }
  }
  const total = entries.length;
  const recent = entries.slice(-cap).reverse(); // 文件正序 → 取最近 cap 条 → 最新在最上
  const items = [];
  let bytes = 0;
  for (const it of recent) {
    const b = byteLen(it);
    if (items.length > 0 && bytes + b > bytesCap) break;
    items.push(it);
    bytes += b;
  }
  return {
    ...base,
    today: {
      date: todayMd,
      total,
      returned: items.length,
      truncated: items.length < total,
      bytes,
      items,
    },
  };
}

/** feed 片（对外入口）= 变更流水今日段 + 日报建议段（两段各自独立降级，互不拖垮）。 */
export function collectFeedShard(opts = {}) {
  const now = opts.now ?? Date.now();
  const changelog = collectChangelogToday({ ...opts, now });
  const advice = collectAdviceShard({ now, dir: opts.reportDir });
  return { ...changelog, advice };
}

// ---------------------------------------------------------------------------
// assets 片（B7：已知四源 + 实体计数摘要；每注册组一行）
// ---------------------------------------------------------------------------
export function collectAssetsShard(opts = {}) {
  const now = opts.now ?? Date.now();
  const home = dshHome();
  const rows = [];
  const asOf = {};

  // ① 组件版本（butler-version.json）
  const verFile = resolveStatePath('butler-version.json', { home }).path;
  const ver = readJsonFile(verFile);
  asOf.components = fileAsOf(verFile);
  rows.push({
    group: '组件版本',
    count: ver ? Object.keys(ver.components ?? {}).length : 0,
    anomalies: ver ? 0 : 1,
    ok: !!ver,
    source: 'butler-version.json',
    asOf: asOf.components.at,
    note: ver ? `${ver.product ?? '?'} ${ver.version ?? '?'}` : '文件缺失（不可探测）',
  });

  // ② 状态文件登记（state-files.mjs → 本机缺失数）
  const stateFiles = opts.stateFiles ?? null; // 由调用方注入后同步化（见 collectAssetsShardAsync）
  if (Array.isArray(stateFiles)) {
    const missing = stateFiles.filter((s) => {
      const rel = String(s?.name ?? '').replace(/\/+$/, '');
      if (!rel) return true;
      try { return !fs.existsSync(path.join(home, rel)); } catch { return true; }
    });
    rows.push({
      group: '状态文件登记',
      count: stateFiles.length,
      anomalies: missing.length,
      ok: true,
      source: 'lib/state-files.mjs',
      asOf: null,
      note: missing.length ? `本机缺失 ${missing.length} 项：${missing.slice(0, 3).map((m) => m.name).join('、')}` : '登记项均存在',
    });
  } else {
    rows.push({ group: '状态文件登记', count: 0, anomalies: 0, ok: false, source: 'lib/state-files.mjs', asOf: null, note: '登记表不可读（不可探测）' });
  }

  // ③ 升级体检（生态面板落盘缓存，**不打 npm**）
  const cacheFile = path.join(home, 'ecosystem-panel-upgrade-cache.json');
  const cache = readJsonFile(cacheFile);
  const items = Array.isArray(cache?.items) ? cache.items : (Array.isArray(cache?.groups?.upgrades) ? cache.groups.upgrades : null);
  asOf.upgrades = fileAsOf(cacheFile);
  if (items) {
    const red = items.filter((x) => x?.status === 'red').length;
    const yellow = items.filter((x) => x?.status === 'yellow').length;
    rows.push({
      group: '升级体检',
      count: items.length,
      anomalies: red + yellow,
      ok: true,
      source: 'ecosystem-panel-upgrade-cache.json',
      asOf: asOf.upgrades.at,
      note: `🔴${red} 🟡${yellow}`,
    });
  } else {
    rows.push({ group: '升级体检', count: 0, anomalies: 0, ok: false, source: 'ecosystem-panel-upgrade-cache.json', asOf: asOf.upgrades.at, note: '缓存缺失/结构不可解析（不可探测）' });
  }

  // ④ P8 收纳（butler-tidy-state.json，与 health 片同源函数）
  let tidy = null;
  try { tidy = collectTidy(); } catch { tidy = { ok: false }; }
  asOf.tidy = fileAsOf(resolveStatePath('butler-tidy-state.json', { home }).path);
  if (tidy?.ok) {
    const s = tidy.summary ?? {};
    rows.push({
      group: 'P8 收纳',
      count: tidy.produced ?? tidy.checkpoints ?? 0,
      anomalies: (s.block ?? 0) + (s.warn ?? 0),
      ok: true,
      source: 'butler-tidy-state.json',
      asOf: tidy.ranAt ?? asOf.tidy.at,
      note: `检查点 ${tidy.produced ?? '-'}/${tidy.checkpoints ?? '-'}`,
    });
  } else {
    rows.push({ group: 'P8 收纳', count: 0, anomalies: 0, ok: false, source: 'butler-tidy-state.json', asOf: asOf.tidy.at, note: '状态缺失或未跑（不可探测）' });
  }

  // ⑤ 术语实体摘要（butler-entities.json —— 只是"实体计数摘要"，**不是资产表**，B7）
  const entFile = resolveStatePath('butler-entities.json', { home }).path;
  const ent = readJsonFile(entFile);
  asOf.entities = fileAsOf(entFile);
  if (ent && typeof ent === 'object') {
    const carriers = Object.values(ent).reduce((n, v) => n + (Array.isArray(v?.carriers) ? v.carriers.length : 0), 0);
    rows.push({
      group: '术语实体（摘要）',
      count: Object.keys(ent).length,
      anomalies: 0,
      ok: true,
      source: 'butler-entities.json',
      asOf: asOf.entities.at,
      note: `carriers ${carriers}`,
    });
  } else {
    rows.push({ group: '术语实体（摘要）', count: 0, anomalies: 0, ok: false, source: 'butler-entities.json', asOf: asOf.entities.at, note: '索引缺失（不可探测）' });
  }

  const payload = {
    ok: true,
    rows,
    totalGroups: rows.length,
    anomalies: rows.reduce((n, r) => n + (r.anomalies ?? 0), 0),
    unreachable: rows.filter((r) => r.ok === false).map((r) => r.group),
    asOf,
    computedAt: now,
  };
  return { ...payload, bytes: byteLen(payload) };
}

/** assets 片（异步包装：补上 butler lib 的登记表）。 */
async function collectAssetsShardAsync(ctx) {
  let stateFiles = ctx.deps?.stateFiles;
  if (!Array.isArray(stateFiles)) {
    const sf = await butlerLib('state-files.mjs');
    stateFiles = Array.isArray(sf?.STATE_FILES) ? sf.STATE_FILES : null;
  }
  return collectAssetsShard({ now: ctx.now, stateFiles });
}

// ---------------------------------------------------------------------------
// metrics 片（V2-B 接线 · A2 接入清单 ①②③）
//   · 唯一入口 = `lib\metrics.mjs#collectMetrics`（缓存路径与实时路径同一函数 → R5 前半）
//   · watch/board/tasks **优先复用同一请求内 core 片的结果**（D2 同源 → metricsDigest 相等）
//   · 面板**不跑子进程**：池级误报率（`barewatch-cross`）显式留空 → 前端显示"不可探测 + 原因"
//   · 生态面板 `/state`（升级体检/补丁漂移/解耦）走 HTTP：**独立超时**且由 buildShardPayload
//     与 core 采集**并行预热**（生态面板冷价实测 1.2–2.0s，串行会让首屏雪上加霜）
// ---------------------------------------------------------------------------

/** 生态面板状态路径（基址取**本次请求**的 baseUrl：测试实例 3090 与生产 3080 并存）。 */
export const ECO_STATE_PATH = '/api/dsh-ecosystem-panel/state';
/** 生态面板 `/state` 单次超时（可环境变量覆盖；超时 = "不可探测 + 原因"，绝不假值）。 */
export const METRICS_ECO_TIMEOUT_MS = Number(process.env.DSH_BUTLER_METRICS_ECO_TIMEOUT_MS ?? 2_000) || 2_000;

/**
 * 预热生态面板 `/state`（返回 Promise，由调用方在**跑 core 之前**发起、在 metrics 采集时 await）。
 * 失败/超时一律返回 `{eco:null, err}` —— 调用方据此给"不可探测 + 原因"，不重试、不伪造。
 */
export function startEcoFetch(ctx) {
  const base = String(ctx.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const started = Date.now();
  return (async () => {
    const fetchImpl = typeof ctx.fetchImpl === 'function' ? ctx.fetchImpl : globalThis.fetch;
    if (typeof fetchImpl !== 'function') return { eco: null, err: '本运行环境无 fetch（不可探测）', ms: 0 };
    try {
      const res = await fetchImpl(base + ECO_STATE_PATH, {
        headers: { origin: base, 'sec-fetch-site': 'same-origin' },
        cache: 'no-store',
        signal: AbortSignal.timeout(METRICS_ECO_TIMEOUT_MS),
      });
      if (!res || res.ok !== true) return { eco: null, err: '生态面板 HTTP ' + String(res?.status ?? '?'), ms: Date.now() - started };
      return { eco: await res.json(), err: null, ms: Date.now() - started };
    } catch (e) {
      return { eco: null, err: '生态面板不可探测：' + String(e?.message ?? e), ms: Date.now() - started };
    }
  })();
}

/** 看板 tasks（含 ignore 过滤 —— 与 core 片 summary/日报同口径；单请求 metrics 时的兜底采集）。 */
function collectTasksWithIgnore() {
  const asOf = fileAsOf(path.join(dshHome(), 'task-board', 'ledger-v2.json'));
  const ignore = (() => { try { return readIgnore(); } catch { return { sessions: [], tasks: [] }; } })();
  const igTask = new Set(ignore.tasks ?? []);
  const filterTasks = (list) => (list ?? []).filter((t) => !igTask.has(t.id));
  try {
    const tasks = collectTasks();
    return {
      ok: true,
      ...tasks,
      running: filterTasks(tasks.running),
      todo: filterTasks(tasks.todo),
      backlog: filterTasks(tasks.backlog),
      overdue: filterTasks(tasks.overdue),
      asOf,
    };
  } catch (e) {
    return { ok: false, reason: '看板账本不可读：' + String(e?.message ?? e), asOf };
  }
}

/** 采集六项指标的**全部数据源**（纯只读；butler lib 动态加载，失败即显式不可探测）。 */
async function collectMetricSources(ctx) {
  const home = dshHome();
  const core = ctx.shared?.core ?? null;
  const sources = {};

  // ①②③ 未 ack 事件 / 待验收卡 / 在途任务 —— 复用 core 片（同源），单请求 metrics 时自采
  sources.watch = core?.watch ?? await collectWatchUnacked(ctx);
  sources.board = core?.board ?? await collectBoardReview(ctx);
  sources.tasks = core?.tasks ?? collectTasksWithIgnore();

  // ④ 自动动作（口径 = daily[<今日>].noQuotaCount，**不是 count**）
  const aaFile = resolveStatePath('butler-auto-actions.json', { home }).path;
  const aaJson = readJsonFile(aaFile);
  sources.autoActions = aaJson
    ? { ok: true, data: aaJson, asOf: fileAsOf(aaFile) }
    : { ok: false, reason: 'butler-auto-actions.json 缺失或不可读（今日自动动作数不可得）', asOf: fileAsOf(aaFile) };

  // ④b 额度闸（【施工卡 ⑥-2】⑥ 包 §3.4-P1 面板行）—— **判定同源 + 零副作用**：
  //    · `checkDailyLimit` / `readQuotaLedger` / `localDay` 一律取 butler lib 的**唯一实现**（面板不复制判定）；
  //    · **不调 `readLimits()`**：那条路径读失败会 `alert()` 写盘，而面板采集是只读路径（红线：观察不写状态）
  //      ⇒ 改成「直读护栏文件 → 缺/坏则回落 `defaultLimits()`（同源默认、偏严）」，并把 `_source` 如实标出；
  //    · 台账读失败 / 整文件解析不出 ⇒ 原样把 `available:false` 传下去（metrics 侧判「未观测」，**绝不判 0**）；
  //    · 台账文件不存在 = 从未降级 ⇒ `available:true` + 0（正常绿，这是 ⑥-1 定义的语义，本卡不改）。
  const aact = await butlerLib('autonomy-actions.mjs');
  if (aact && typeof aact.checkDailyLimit === 'function') {
    const guardFile = resolveStatePath('butler-autonomy-limits.json', { home }).path;
    const guard = readJsonFile(guardFile);
    const dflt = typeof aact.defaultLimits === 'function' ? aact.defaultLimits() : null;
    const maxRaw = guard?.maxAutoActionsPerDay ?? dflt?.maxAutoActionsPerDay;
    const max = Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null;
    const day = typeof aact.localDay === 'function' ? aact.localDay(ctx.now) : null;
    let daily = null;
    let ledger = null;
    let reason = null;
    try {
      daily = aact.checkDailyLimit(aaJson ?? {}, day ?? undefined, max);   // used/max/reached —— 唯一判定函数的原样输出
    } catch (e) {
      reason = 'checkDailyLimit 异常：' + String(e?.message ?? e);
    }
    try {
      ledger = typeof aact.readQuotaLedger === 'function'
        ? aact.readQuotaLedger({ home, now: ctx.now })
        : { available: false, error: 'butler 库未提供 readQuotaLedger（版本过旧）' };
    } catch (e) {
      ledger = { available: false, error: String(e?.message ?? e) };
    }
    sources.quotaGate = {
      ok: Boolean(daily),
      day,
      daily,                                                   // {day, used, max, reached, reason} 或 null
      limits: { max, source: guard ? 'file' : (dflt ? 'default' : 'unavailable'), file: guardFile },
      ledger,                                                  // readQuotaLedger 汇总原样（含 available/error）
      reason,
      asOf: fileAsOf(aaFile),                                  // 主 asOf = daily 计数来源（自动动作状态文件）的 mtime
    };
  } else {
    sources.quotaGate = { ok: false, reason: 'butler 库 autonomy-actions.mjs 不可用（额度闸不可探测）', asOf: fileAsOf(resolveStatePath('butler-autonomy-limits.json', { home }).path) };
  }

  // ⑤ 自治档位（L0 = readAutonomyState / L2 = describeModules；预期关闭集合取登记表 baseline===false）
  const [astate, amods] = await Promise.all([butlerLib('autonomy-state.mjs'), butlerLib('autonomy-modules.mjs')]);
  if (astate?.readAutonomyState || amods?.describeModules) {
    const safe = (fn) => { try { return fn(); } catch { return null; } };
    sources.autonomy = {
      l0: astate?.readAutonomyState ? safe(() => astate.readAutonomyState({ home })) : null,
      l2: amods?.describeModules ? safe(() => amods.describeModules({ home })) : null,
      expectedDisabledIds: Object.entries(amods?.MODULE_IDS ?? {}).filter(([, v]) => v?.baseline === false).map(([k]) => k),
      asOf: fileAsOf(resolveStatePath('butler-autonomy-state.json', { home }).path),
    };
  }

  // ⑥ 资产异常：升级体检/补丁漂移/解耦 ← 生态面板缓存（HTTP 预热结果）；镜像 ← 冷盘健康判定
  const ecoRes = ctx.metricsEcoPrewarm ? await ctx.metricsEcoPrewarm : null;
  const offsite = await butlerLib('rollback-offsite-health.mjs');
  let mirror = null;
  try { mirror = offsite?.judgeOffsiteHealth ? offsite.judgeOffsiteHealth({ home, now: ctx.now }) : null; } catch { mirror = null; }
  sources.assets = {
    eco: ecoRes?.eco ?? null,
    ecoError: ecoRes ? (ecoRes.err ?? null) : '本次请求未预热生态面板（不可探测）',
    mirror: mirror ? {
      ok: true,
      level: mirror.level,
      missing: Number(mirror.consecutiveFailures ?? 0) > 0 ? 1 : 0,
      reason: mirror.reason ?? null,
      asOf: { at: mirror.lastRunAt ? Date.parse(mirror.lastRunAt) : null, source: 'file-mtime' },
    } : null,
    asOf: { at: ctx.now, source: 'http' },
  };

  // ⑦ 误报率：按机 ← barewatch summary（日报「📊 误报率」段同源）；交叉 ← checks 段 4
  //    池级 L1/L2 需 `barewatch-cross` 子进程 → 面板只读不跑子进程 → 留空（显式不可探测）
  const bwFile = resolveStatePath('butler-barewatch-state.json', { home }).path;
  const bw = readJsonFile(bwFile);
  let checksSeg4 = null;
  try { checksSeg4 = collectFalsePositive(); } catch { checksSeg4 = null; }
  sources.falsePositive = {
    byMachine: bw?.summary ? { ...bw.summary, device: bw.device ?? null } : null,
    checksSegment4: checksSeg4,
    pool: null,
    detailComplete: null,
    asOf: fileAsOf(bwFile),
  };

  // ⑧ tickd 心跳（只取 judgeTickdHealth().level；面板**不自算 age** —— 该字段是 UTC）
  const tickdh = await butlerLib('tickd-health.mjs');
  let judge = null;
  try { judge = tickdh?.judgeTickdHealth ? tickdh.judgeTickdHealth({ now: ctx.now }) : null; } catch { judge = null; }
  if (judge) {
    sources.tickd = {
      level: judge.level ?? null,
      reason: judge.reason ?? null,
      // 【卡「tickd 停摆治本」2026-09-23】把"常驻在不在"一并透传：首屏心跳段必须能直说
      // 「引擎未运行」，而不是只给一个 🔴 异常（原因藏 tooltip = 引擎停摆依然不显眼）。
      // 判据仍是同一份 judgeTickdHealth()（面板不自算）。
      running: { ok: judge.running?.ok === true, reason: judge.running?.reason ?? null, pid: judge.running?.pid ?? null },
      // 【M5】会话异地镜像红标（判据真源 = `butler-session-mirror.json#consecutiveUnreachable`）：
      //   ⚠️ metrics 片是**硬 ≤2048 B**（`SHARD_BUDGET_BYTES`，生产真值已 ~1986 B，余量 ~60 B）
      //   ⇒ 片上**只带极短字段**（`lv` 级别 + `n` 连续轮数，≈25 B，固定键名 + 短枚举 + 数字，符合阶梯
      //   终止性论证）；四段式全文走 health 片（`lib/state.js#collectTickdHealth().sessionMirror`）。
      //   判据仍是同一份 judgeTickdHealth()（面板不自算、不复读 json）。
      mirror: judge.sessionMirror ? {
        lv: judge.sessionMirror.level ?? null,
        n: Number(judge.sessionMirror.consecutiveUnreachable ?? 0),
      } : null,
      asOf: fileAsOf(path.join(process.env.TEMP ?? os.tmpdir(), 'dsh-butler-tickd', 'state.json')),
    };
  }

  return sources;
}

/** metrics 片：唯一入口 + shard 档（≤2 KB 由阶梯终止性保证）。 */
async function collectMetricsShardAsync(ctx) {
  const sources = await collectMetricSources(ctx);
  return collectMetrics({ now: ctx.now, sources }, { profile: 'shard' });
}

/**
 * metrics **完整档**（【1.3】懒取片 `metricsdetail`）：
 *   `collectMetrics` 缺省 profile = `'full'`（含逐项 asOf / part 级 reason 全文 / errors 全文 / 说明文案）。
 *   与 shard 档**同一唯一入口、同一份 sources** ⇒ 六项计数与状态逐值一致（不存在两套算法）。
 */
async function collectMetricsDetail(ctx) {
  const sources = await collectMetricSources(ctx);
  return collectMetrics({ now: ctx.now, sources });
}

// ---------------------------------------------------------------------------
// service 片（⑤ 包 S-7 **挂点 1**：面板分片 · 2026-10-11 卡【多端线·服务面健康】）
//
// 口径（⑤ 包 §3.7「唯一判定入口 + 三挂点」/ §16-B1 / ① 包冻结项「面板只渲染、不自算判定」）：
//   · **判定只有一份**：全在 `tools\dsh-butler\lib\secretary-health.mjs#collectHealth`（+ S-9 的
//     `#collectFamilyUsage`）—— 本片**只挑字段 + 截断文案**，一条 `if (状态) …` 都不写
//     （面板里另写健康判定 = 第二套真源，正是本卡红线禁止的）。
//   · 状态词/图标也取自判定库导出的 `stateWord` / `checkIcon`（不在这里硬编 emoji 映射）。
//   · 判定库不可用 / 抛错 ⇒ **显式成段**（`ok:false` + reason），**绝不渲染成「服务面正常」**。
//   · 只读：判定库自身零网络零写盘；本片除动态 import 判定库外不碰任何文件。
//
// 片内容 = 服务面总览五项（卡要求）：① 总判定 ② hub 存活（`channel` 项）
//   ③ 今日入站 / 丢线 N 次（`channel.evidence`）④ 推送台账末行（`push-delivery` 项）
//   ⑤ 家人用量末行（`collectFamilyUsage`）。
// ---------------------------------------------------------------------------
/** 单项文案截断长度（片要小：8 项 × 200 字 ≈ 2 KB 量级）。 */
const SERVICE_DETAIL_CAP = 200;
/** 从判定库的 checks 里取一项；**取不到就是 null**（绝不现造一个"默认正常"顶上）。 */
function checkOf(health, id) {
  return ((health && health.checks) || []).find((c) => c && c.id === id) ?? null;
}
/** 只挑 evidence 里要展示的键（原始读数的搬运，判定已在判定库里做过）。 */
function evOf(check, keys) {
  const src = (check && check.evidence) || {};
  const out = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}
/**
 * service 片：服务面总览（**纯渲染判定库结论**）。
 * @param {{now?:number}} [ctx]
 * @returns {Promise<object>} 判定库不可用 ⇒ `{ok:false, reason}`（显式成段，不是"正常"）
 */
export async function collectServiceShard(ctx = {}) {
  const now = ctx.now ?? Date.now();
  const home = dshHome();
  const asOf = { at: now, source: 'compute' };
  const sh = await butlerLib('secretary-health.mjs');
  if (!sh || typeof sh.collectHealth !== 'function') {
    return { ok: false, reason: '判定库 secretary-health.mjs 不可用（挂点 1 不可探测）—— 这不是「服务面正常」', asOf };
  }
  let health = null;
  let healthError = null;
  try { health = await sh.collectHealth({ home, now }); }
  catch (e) { healthError = String((e && e.message) || e); }
  if (!health) {
    return { ok: false, reason: `判定自身抛错（${healthError ?? '无输出'}）—— 这不是「服务面正常」`, asOf };
  }
  let family = null;
  try {
    family = typeof sh.collectFamilyUsage === 'function' ? await sh.collectFamilyUsage({ home, now }) : null;
  } catch (e) { family = { error: String((e && e.message) || e) }; }
  let exitCode = null;
  try { exitCode = typeof sh.exitCodeOf === 'function' ? sh.exitCodeOf(health) : null; } catch { exitCode = null; }
  const icon = (st) => (typeof sh.checkIcon === 'function' ? sh.checkIcon(st) : null);
  const word = (st) => (typeof sh.stateWord === 'function' ? sh.stateWord(st) : null);

  const chan = checkOf(health, 'channel');
  const push = checkOf(health, 'push-delivery');
  const fam = family && !family.error ? family : null;
  return {
    ok: true,
    verdict: {
      state: health.state ?? null,
      word: word(health.state),
      exitCode,
      counts: health.counts ?? null,
      asOf: health.asOf ?? null,
      host: health.host ?? null,
      home: health.home ?? null,
      environment: health.environment ?? null,
    },
    // ②③ hub 存活 + 今日入站 / 丢线（判据 = 判定库 `channel` 项；本片不动它一个字段）
    hub: chan ? {
      state: chan.state ?? null,
      icon: icon(chan.state),
      title: chan.title ?? null,
      detail: truncate(chan.detail, SERVICE_DETAIL_CAP),
      ...evOf(chan, ['source', 'fresh', 'connected', 'ageMs', 'staleMs', 'todayInbound', 'disconnectCount',
        'kickedCount', 'at', 'pid', 'host', 'lastMsgAt', 'expectedHere', 'takeover', 'stoppedBy', 'readError']),
    } : null,
    // ④ 推送台账末行
    push: push ? {
      state: push.state ?? null,
      icon: icon(push.state),
      title: push.title ?? null,
      detail: truncate(push.detail, SERVICE_DETAIL_CAP),
      ...evOf(push, ['lastAt', 'lastStatus', 'sentToday', 'realSends', 'rows', 'bad', 'consecutiveFail']),
    } : null,
    // 全量逐项（状态 + 截断文案）：面板要"八项一览"时用，不新增判定
    checks: ((health.checks) || []).map((c) => ({
      id: c.id, title: c.title, state: c.state, detail: truncate(c.detail, SERVICE_DETAIL_CAP),
    })),
    // ⑤ 家人用量末行
    family: fam ? {
      state: fam.state ?? null,
      day: fam.day ?? null,
      host: fam.host ?? null,
      asOf: fam.asOf ?? null,
      identity: fam.identity ? {
        exists: fam.identity.exists, ok: fam.identity.ok, error: fam.identity.error ?? null,
        shape: fam.identity.shape ?? null, count: fam.identity.count ?? null,
      } : null,
      usage: fam.usage ? {
        exists: fam.usage.exists, rows: fam.usage.rows ?? null, badRows: fam.usage.badRows ?? null,
        totalTurnsToday: fam.usage.totalTurnsToday ?? null, totalTokensToday: fam.usage.totalTokensToday ?? null,
        rejectedToday: fam.usage.rejectedToday ?? null,
        perUserTop: (fam.usage.perUser ?? []).slice(0, 5).map((p) => ({
          userid: p.userid, name: p.name ?? null, turnsToday: p.turnsToday ?? 0,
          turnsAll: p.turnsAll ?? 0, lastAt: p.lastAt ?? null,
        })),
      } : null,
      push: fam.push ?? null,
    } : (family && family.error ? { error: family.error } : null),
    asOf,
  };
}

// ---------------------------------------------------------------------------
// audit 片（V2-C：P5 写入守门人全量 —— 原只在**无参全量**里组装，Tab 化的「管家」需要）
//   · `stats` = state.js#collectAuditStats（与日报「🛡 守门人」段同源，0 token）
//   · `guard` = **运行时**守门人统计（挂载状态 / 待用凭证 / 逃生舱），由 index.js 注入实例；
//     未注入（旧版/未挂载）→ 显式 `null`，前端显示"未挂载"，**绝不伪造运行中**。
// ---------------------------------------------------------------------------
export function collectAuditShard(ctx = {}) {
  const now = ctx.now ?? Date.now();
  let stats;
  try { stats = collectAuditStats(); } catch (e) { stats = { ok: false, error: String(e?.message ?? e) }; }
  const guard = ctx.deps?.guard ?? null;
  let guardStats = null;
  if (guard && typeof guard.stats === 'function') {
    try { guardStats = guard.stats(); } catch { guardStats = null; }
  }
  const dir = path.join(dshHome(), 'butler-audit');
  const st = statOrNull(dir);
  return {
    ok: true,
    stats,
    guard: guardStats,
    guardMounted: guardStats !== null,
    asOf: { at: st ? st.mtimeMs : null, source: 'file-mtime' },
    computedAt: now,
  };
}

// ---------------------------------------------------------------------------
// reports 片（V2-C：报告档案 + 趋势卡）
//   · 「报告」Tab（dailies/weeklies/externals 列表与预览）与「管家」Tab 的趋势卡都要它；
//   · 此前只在无参全量里返回 → Tab 化后必须能按需拉，否则两处恒空。
// ---------------------------------------------------------------------------
/**
 * 待清账主线片（P3 · 2026-09-15 卡 9bde0f9e）。
 *
 * 定位：**只读展示 P0 判定引擎的结果**——判据唯一真源 = `tools\dsh-butler\lib\board-cleanup.mjs`
 *   的 `evaluateBoard()`（纯函数），面板**不自算**任何一条口径（与 watch.unacked 复用 listUnacked 同款纪律）。
 *
 * 数据源三处（都是只读）：
 *   ① 看板账本 `~/.dsh/task-board/ledger-v2.json`（全量含归档卡）→ 喂给 evaluateBoard
 *   ② 台账 `~/.dsh/butler-board-cleanup.json`（冷却 / 第三态 / 上次评估）→ 用 summarizeState 解析
 *   ③ 库文件本体（动态 import，缺库 → 显式"不可探测 + 原因"，绝不伪造 0 条）
 *
 * ⚠️ 与 P0 的口径边界：面板**只展示**，不改档位、不写台账、不发通知（写动作仍只在 queue tick 与 CLI）。
 */
async function collectCleanupShard(ctx) {
  const now = ctx.now;
  const asOf = { at: null, source: 'file-mtime' };
  const bcl = await butlerLib('board-cleanup.mjs');
  if (!bcl || typeof bcl.evaluateBoard !== 'function') {
    return { ok: false, reason: 'butler board-cleanup 库不可用（不可探测）', items: [], asOf };
  }
  const home = dshHome();
  const stateFile = resolveStatePath('butler-board-cleanup.json', { home }).path;
  const ledgerFile = path.join(home, 'task-board', 'ledger-v2.json');
  asOf.at = fileAsOf(stateFile).at;

  let loaded = { state: null, exists: false, broken: false, reason: null };
  try { loaded = bcl.loadState({ home }); } catch (e) {
    loaded = { state: null, exists: fs.existsSync(stateFile), broken: true, reason: String(e?.message ?? e) };
  }
  let sum = null;
  try { sum = typeof bcl.summarizeState === 'function' ? bcl.summarizeState(loaded.state, { now }) : null; } catch { sum = null; }

  const ledger = readJsonFile(ledgerFile);
  if (!ledger || !Array.isArray(ledger.tasks)) {
    return {
      ok: false, reason: '看板账本不可读（' + ledgerFile + '）', items: [], asOf,
      stateFile, stateExists: loaded.exists === true, stateBroken: loaded.broken === true,
    };
  }

  let ev = null;
  try { ev = bcl.evaluateBoard(ledger.tasks, { now, revision: ledger.revision ?? null, cfg: sum?.config }); } catch (e) {
    return { ok: false, reason: '判据评估失败：' + String(e?.message ?? e), items: [], asOf, stateFile };
  }
  const cfg = ev.cfg ?? {};
  const cdMs = (Number(cfg.cooldownDays) || 7) * 86_400_000;
  const byLine = new Map((sum?.rows ?? []).map((r) => [r.line, r]));
  const items = [], suppressed = [], stale = [];
  for (const r of ev.lines ?? []) {
    if (!r.candidate) continue;
    const rec = byLine.get(r.line) ?? null;
    const lastNotifiedAt = rec?.lastNotifiedAt ?? null;
    const base = {
      line: r.line, live: r.live, archivedCount: r.archivedCount ?? 0,
      allDone: r.allDone === true, ageMs: r.ageMs ?? null, lastActivity: r.lastActivity ?? null,
      cardIds: (r.cardIds ?? []).slice(0, 12), lastNotifiedAt,
    };
    if (rec?.state === 'stale' || rec?.staleAt != null) { stale.push(base); continue; }
    if (lastNotifiedAt !== null && (now - lastNotifiedAt) < cdMs) {
      suppressed.push({ ...base, cooldownLeftH: Math.max(0, Math.round((cdMs - (now - lastNotifiedAt)) / 3_600_000)) });
      continue;
    }
    // 命令文案直接复用 P0 模块的格式化函数（**不做第二份真相**）；面板里显示成纯文本，故去掉 markdown 反引号
    const strip = (s) => String(s ?? '').replace(/`/g, '');
    let brief = r.line, commands = [];
    try { brief = strip(bcl.formatItemBrief(base)); } catch { /* 保底用线名 */ }
    try { commands = (bcl.formatCommandLines({ ...base, rawLine: r.rawLine })).map(strip); } catch { commands = []; }
    items.push({ ...base, brief, commands });
  }
  items.sort((a, b) => (a.lastActivity ?? 0) - (b.lastActivity ?? 0));

  // K5（2026-09-28）：观测项 = 在板卡数 + 在板体积 + 整线归档建议。
  //   口径算式走共享真源 `lib/board-j1-limits.mjs`（面板**不自算**，与「判据只复用 evaluateBoard」同款纪律）；
  //   体积读数 = 账本文件 `stat.size`（只读，不解析内容）。缺库/缺函数一律降级为 null，不伪造 0。
  let inBoard = null;
  try {
    if (typeof bcl.buildInBoardView === 'function') {
      const volume = typeof bcl.readLedgerVolume === 'function'
        ? bcl.readLedgerVolume({ home })
        : { ok: false, file: ledgerFile, bytes: null, error: 'readLedgerVolume 不可用' };
      inBoard = bcl.buildInBoardView({ evaluation: ev, volume, notifiedLines: items.length });
    }
  } catch (e) {
    inBoard = { ok: false, note: '观测项组装失败：' + String(e?.message ?? e) };
  }

  return {
    ok: true,
    mode: sum?.config?.mode ?? cfg.mode ?? null,
    lastCheckAt: sum?.lastCheckAt ?? null,
    lastResult: sum?.lastResult ?? null,
    revision: ledger.revision ?? null,
    counts: ev.counts ?? null,
    stats: sum?.stats ?? null,
    config: {
      minLive: cfg.minLive ?? null, matureMs: cfg.matureMs ?? null,
      cooldownDays: cfg.cooldownDays ?? null, throttleMs: cfg.throttleMs ?? null,
    },
    itemCount: items.length,
    items: items.slice(0, CLEANUP_ITEM_CAP),
    /** K5：在板卡数 + 在板体积 + 整线归档建议（只读提示；口径真源 = lib/board-j1-limits.mjs）。 */
    inBoard,
    suppressed: suppressed.slice(0, 6),
    stale: stale.slice(0, 6),
    stateFile, stateExists: loaded.exists === true, stateBroken: loaded.broken === true,
    stateReason: loaded.reason ?? null,
    asOf,
  };
}

export function collectReportsShard(ctx = {}) {
  try { return collectReports(); } catch (e) { return { ok: false, error: String(e?.message ?? e), trends: null }; }
}

// ---------------------------------------------------------------------------
// 【冲刺600·面板三小修 · 1.13】health 片结构性瘦身
//   -------------------------------------------------------------------------
//   背景（2026-10-10 实测）：`?parts=health` 响应体 **18119 B (17.7 KB)** > 预算 12 KB（R2.health 红）。
//   逐字段拆解（同一时刻实读）：tidy 6726 · handoff 2964 · upgrades 2892 · tickd 1820 · restart 1267 ·
//   external 1051 · archive 599 · upgradeLock 417。
//   -------------------------------------------------------------------------
//   口径：**只有前端 `lib/client.js#buildHealth()` 真正渲染的字段留在片上**，长尾列表折叠成**计数**。
//     · 不删语义：折叠处一律留 `*Count`（计数是状态，与"本来就没有"必须分得开）+ 片级
//       `trimmed:true` / `detailIn:'healthdetail'` 显式标记；
//     · 不放松预算：预算仍是 12 KB，靠"**只发前端要的**"达标（实测 17.4 KB → ~9 KB）；
//     · 不丢数据：完整档由懒取片 `?parts=healthdetail` 提供（同一 `collectHealth()` 入口，未折叠）。
//   ⚠️ 加字段前先问一句「buildHealth() 渲染它吗」—— 不渲染的进 healthdetail，别进 health。
// ---------------------------------------------------------------------------
/** health 片裁剪：保留前端渲染所需字段，长尾折叠成计数（幂等：对已裁剪对象再跑一次结果不变）。 */
export function trimHealthShard(h) {
  if (!h || typeof h !== 'object') return h;
  const DETAIL = 'healthdetail';
  const out = { ...h };

  // ① tidy：前端只渲染 summary / tmp / archive / gate / findings（前 4 条非 ok）。
  //    三轮 history、observe 逐轮明细、p2Events 未注册名单 —— 前端零引用。
  if (out.tidy && typeof out.tidy === 'object') {
    const t = { ...out.tidy };
    const hist = Array.isArray(t.history) ? t.history : null;
    if (hist) { t.historyCount = hist.length; delete t.history; }
    const obsHist = Array.isArray(t.l2ObserveHistory) ? t.l2ObserveHistory : null;
    if (obsHist) { t.l2ObserveHistoryCount = obsHist.length; delete t.l2ObserveHistory; }
    if (t.l2Observe && typeof t.l2Observe === 'object') {
      const o = t.l2Observe;
      const next = { ...o };
      // ⚠️ 用「有才折算」而非白名单重建：对**已折叠**对象再跑一次必须逐字节相同
      //   （白名单重建会把 `wouldMoveCount` 覆盖成 0 —— 单测 test-panel3-health-trim 逮到过）。
      if (Array.isArray(o.wouldMove)) { next.wouldMoveCount = o.wouldMove.length; delete next.wouldMove; }
      if (Array.isArray(o.buckets)) { next.bucketsCount = o.buckets.length; delete next.buckets; }
      for (const k of ['counters', 'skippedByStage', 'refcheck', 'gate', 'describe']) delete next[k];
      next.trimmed = true; next.detailIn = DETAIL;
      t.l2Observe = next;
    }
    if (t.gate && typeof t.gate === 'object' && t.gate.p2Events && typeof t.gate.p2Events === 'object') {
      const p2 = { ...t.gate.p2Events };
      const nr = Array.isArray(p2.notRegistered) ? p2.notRegistered : null;
      if (nr) { p2.notRegisteredCount = nr.length; delete p2.notRegistered; }
      t.gate = { ...t.gate, p2Events: p2 };
    }
    t.trimmed = true; t.detailIn = DETAIL;
    out.tidy = t;
  }

  // ② handoff：前端只用 facts 的计数/短字段 + redBar + volumes；`lines`（日报文本行）与
  //    `facts.skipped` / `facts.deferred` 明细前端零引用（计数 skippedCount / unpushedCount 已在）。
  if (out.handoff && typeof out.handoff === 'object') {
    const hd = { ...out.handoff };
    const lines = Array.isArray(hd.lines) ? hd.lines : null;
    if (lines) { hd.linesCount = lines.length; delete hd.lines; }
    if (hd.facts && typeof hd.facts === 'object') {
      const f = { ...hd.facts };
      const sk = Array.isArray(f.skipped) ? f.skipped : null;
      const df = Array.isArray(f.deferred) ? f.deferred : null;
      if (sk) {
        if (typeof f.skippedCount !== 'number') f.skippedCount = sk.length;
        if (typeof f.skippedNeedsHuman !== 'number') f.skippedNeedsHuman = sk.filter((s) => s?.needsHuman).length;
        delete f.skipped;
      }
      if (df) { if (typeof f.deferredCount !== 'number') f.deferredCount = df.length; delete f.deferred; }
      hd.facts = f;
    }
    hd.trimmed = true; hd.detailIn = DETAIL;
    out.handoff = hd;
  }

  // ③ upgrades：前端只渲染 pending 的前 4 条（`pend.slice(0,4)`）且不读每条的 `problems`
  //    ⇒ 片上只发 4 条 + 条数；`pendingTotal` 保留（前端用它显示"还有 N 项"）。
  if (out.upgrades && typeof out.upgrades === 'object') {
    const u = { ...out.upgrades };
    if (Array.isArray(u.pending)) {
      const all = u.pending;
      if (typeof u.pendingTotal !== 'number') u.pendingTotal = all.length;
      u.pending = all.slice(0, 4).map((p) => {
        if (!p || typeof p !== 'object') return p;
        const pr = Array.isArray(p.problems) ? p.problems : null;
        const next = { ...p };
        if (pr) { next.problemsCount = pr.length; delete next.problems; }
        return next;
      });
      u.trimmed = true; u.detailIn = DETAIL;
    }
    out.upgrades = u;
  }

  // ④ external：前端只用 counts + items（前 3）+ failing（前 2）+ muted/suppressed；
  //    今日 `sources` 快照数组（含 snapshot 全文）零引用。注意与 `sourceCount`（注册表源数）不同义。
  if (out.external && typeof out.external === 'object' && Array.isArray(out.external.sources)) {
    const e = { ...out.external };
    e.sourcesCount = e.sources.length;
    delete e.sources;
    e.trimmed = true; e.detailIn = DETAIL;
    out.external = e;
  }

  // ⑤ restart：前端只用 lastBatch 的 finishedAt/interrupted/notified；`items` 明细零引用。
  if (out.restart && typeof out.restart === 'object' && out.restart.lastBatch
    && typeof out.restart.lastBatch === 'object' && Array.isArray(out.restart.lastBatch.items)) {
    const r = { ...out.restart };
    r.lastBatch = { ...r.lastBatch, itemsCount: r.lastBatch.items.length };
    delete r.lastBatch.items;
    r.trimmed = true; r.detailIn = DETAIL;
    out.restart = r;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 逐片采集分发
// ---------------------------------------------------------------------------
async function collectShard(name, ctx) {
  switch (name) {
    case 'core': return collectCoreShard(ctx);
    case 'feed': return collectFeedShard({
      now: ctx.now,
      limit: ctx.deps?.feedLimit,
      dir: ctx.deps?.changelogDir,
      reportDir: ctx.deps?.reportDir,
    });
    case 'assets': return collectAssetsShardAsync(ctx);
    case 'metrics': return collectMetricsShardAsync(ctx);
    case 'audit': return collectAuditShard(ctx);
    case 'reports': return collectReportsShard(ctx);
    case 'cleanup': return collectCleanupShard(ctx);
    case 'contract': return readPersonaContract();
    case 'health': {
      if (!ctx.budget.allow('health', 0)) {
        return { ok: false, reason: '超时预算不足，未探测（不可探测）', unreachable: true };
      }
      // 【V2.9封口②·W2 性能】health 与 metrics **同读**生态面板 `/state`（实测该 HTTP 固定价 1.6~1.7 s）
      //   ⇒ 两片共用**同一次**请求（`ctx.ecoFetch`，由 buildShardPayload 在跑任何片之前发起）。
      try { return trimHealthShard(await collectHealth({ eco: ctx.ecoFetch ?? null })); } catch (e) { return { ok: false, error: String(e?.message ?? e), unreachable: true }; }
    }
    // 【1.13】懒取档：health 的**完整版**（未折叠）。只在显式 `?parts=healthdetail` 时计算，
    //   不进首屏、不进任何 Tab 的 TAB_PARTS —— 需要长尾明细（tidy 历史 / handoff lines / skipped 明细 /
    //   external sources / upgrades 第 5+ 条 / restart items）时手工拉这一片。
    case 'healthdetail': {
      if (!ctx.budget.allow('health', 0)) {
        return { ok: false, reason: '超时预算不足，未探测（不可探测）', unreachable: true };
      }
      try { return await collectHealth(); } catch (e) { return { ok: false, error: String(e?.message ?? e), unreachable: true }; }
    }
    // 【1.3】懒取档：metrics 的 **full 档**（含逐项 asOf / part 级 reason 全文 / errors 全文 / 文案）。
    //   metrics 片硬 ≤ 2048 B，预算保险丝会把 reason 删成 `reasonTrimmed:true`、errors 截到 24–48 字
    //   ⇒ 前端「原因全文（点击展开）」按需拉这一片。判据同源：同一个 collectMetrics 唯一入口。
    case 'metricsdetail': return collectMetricsDetail(ctx);
    // 【2026-10-11 卡 多端线·服务面健康】⑤ 包 S-7 **挂点 1**：面板 service 片
    //   （只渲染 `secretary-health.mjs` 的结论 —— 面板不另写健康判定）
    case 'service': return collectServiceShard(ctx);
    default: return { ok: false, reason: `未知片：${name}` };
  }
}

/**
 * 构建分片响应（唯一入口：缓存路径与实时路径都走这里）。
 * @param {{isFull:boolean, requested:string[], unknown:string[]}} selection parseParts() 的结果
 * @param {{now?:number, ttlMs?:number, budget?:object, budgetMs?:number, useCache?:boolean, deps?:object}} [opts]
 *   deps: { sessions, sessionsIndex, baseUrl, fetchImpl, stateFiles, changelogDir, feedLimit, guard, reportDir }
 */
export async function buildShardPayload(selection, opts = {}) {
  const now = opts.now ?? Date.now();
  const budget = opts.budget ?? createBudget(opts.budgetMs ?? CORE_BUDGET_MS, now);
  // 【V2-C】默认 TTL 逐片定（contract = 10min；其余 300s）——显式 ttlMs 优先（单测/自检用）。
  const ttlMs = opts.ttlMs ?? ttlForParts(selection.requested);
  const deps = opts.deps ?? {};
  const ctx = {
    now,
    budget,
    deps,
    sessions: Array.isArray(deps.sessions) ? deps.sessions : null,
    // 【卡 面板③·取数 · S2】懒取 thunk（`deps.sessionsIndex`）：只有真有卡要判时才调它。
    sessionsIndex: typeof deps.sessionsIndex === 'function' ? deps.sessionsIndex : null,
    baseUrl: deps.baseUrl ?? DEFAULT_BASE_URL,
    fetchImpl: typeof deps.fetchImpl === 'function' ? deps.fetchImpl : undefined,
    // 【V2-B】片间共享位：core 的采集结果供同请求内的 metrics 片复用（A2 接入清单 ③ 同源纪律）
    shared: {},
  };
  const key = cacheKeyOf(selection.requested);
  const produce = async () => {
    // 【V2-B】metrics 片的生态面板 HTTP 与 core 采集**并行**预热：只在真正要重算时发起
    //   （缓存命中零成本；生态面板冷价实测 1.2–2.0s，串行会让冷启动首屏叠加成 ~4s）
    //   【V2.9封口②·W2 性能】预热面扩到 health：health 与 metrics **同读**生态面板 `/state`
    //   （实测该 HTTP 固定价 1.6~1.7 s，各发一次 = 白翻倍）⇒ 两片共用同一次请求
    //   （`ctx.ecoFetch` 与 `ctx.metricsEcoPrewarm` 是**同一个 Promise**）。
    if (selection.requested.includes('metrics') || selection.requested.includes('metricsdetail')
      || selection.requested.includes('health') || selection.requested.includes('healthdetail')) {
      const ecoPrewarm = startEcoFetch(ctx);
      ctx.metricsEcoPrewarm = ecoPrewarm;
      ctx.ecoFetch = ecoPrewarm;
    }
    // 片装配：
    //   · core 是"多段集合"（summary/sessions/tasks/watch/board/audit）→ **展开到顶层**，
    //     这样前端 B 卡可以沿用既有渲染路径（state.summary / state.sessions / state.tasks）；
    //   · 其余片以**片名**为键（health/feed/assets/metrics/contract）；
    //   · meta 只有一份，位于顶层（core 的 meta 片段并入）。
    const acc = { meta: {} };
    //   【V2.9封口②·W2 性能】片间**并行**：core 是唯一的「生产者」（其 `shared.core` 被 metrics 片复用
    //   ⇒ metrics 必须等 core 算完），其余片互不依赖 ⇒ 并行发起、**按 `requested` 原序装配**
    //   ⇒ 响应字段顺序与串行版逐字节同序（回归套件 R2 的载荷断言面不变）。
    const values = new Map();
    for (const name of selection.requested.filter((n) => n === 'core')) {
      values.set(name, await collectShard(name, ctx));
    }
    const restNames = selection.requested.filter((n) => n !== 'core');
    if (restNames.length) {
      const settled = await Promise.all(restNames.map(async (n) => [n, await collectShard(n, ctx)]));
      for (const [n, v] of settled) values.set(n, v);
    }
    for (const name of selection.requested) {
      const value = values.get(name);
      if (name === 'core' && value && typeof value === 'object') {
        const { meta: coreMeta, ...rest } = value;
        Object.assign(acc, rest);
        Object.assign(acc.meta, coreMeta ?? {});
      } else {
        acc[name] = value;
      }
    }
    acc.meta = {
      ...acc.meta,
      generatedAt: Date.now(),
      parts: selection.requested,
      unknownParts: selection.unknown,
      budget: acc.meta.budget ?? budget.snapshot(),
    };
    return acc;
  };
  const useCache = opts.useCache !== false && selection.requested.length > 0;
  // 【A 补 · 首屏 SWR · 2026-10-21】唯一入口默认开 `swr`：缓存过期但未超硬上限（15min）时
  //   **立刻端旧 payload** + 后台单飞重算一次 —— 治"正好撞上 300s 缓存到期那一次首屏 1.5~2.7s"。
  //   `opts.swr === false` 是单测/自检的显式关闭口（保留"过期即阻塞重算"的老语义做对照）。
  const swr = opts.swr !== false;
  let r;
  if (useCache) {
    r = await singleFlight(key, produce, {
      ttlMs, now, swr,
      // 后台重算失败留痕（不抛给请求方）：交回 index.js 路由的 logger 打一行
      onRefreshError: typeof opts.onRefreshError === 'function' ? opts.onRefreshError : undefined,
    });
  } else {
    r = { ok: true, payload: await produce(), hit: false, coalesced: false, computedAt: Date.now(), computeMs: 0, ageMs: 0, stale: false, refreshing: false };
  }
  if (!r.ok) throw new Error(r.error ?? 'shard-compute-failed');
  const payload = r.payload;
  return {
    ...payload,
    meta: {
      ...(payload.meta ?? {}),
      parts: selection.requested,
      unknownParts: selection.unknown,
      // 【V3.0.0 · 判据 15 缺口 A-2 · 2026-10-26】面板运行期开关值 —— **在最终组装处**（不是 produce 里）取实时值：
      //   payload 可能整份来自缓存（命中旧条目），开关值必须跟"这一次请求"走，否则改键要等 TTL 300s 才反映。
      panelSwitches: readPanelSwitches().values,
      cache: {
        key,
        hit: r.hit === true,
        coalesced: r.coalesced === true,
        // 【A 补 · SWR】「不许假装新鲜」：`stale/refreshing` 两个布尔必须如实反映
        //   ①stale=true = 本次端出去的 payload **已过 TTL**（读数旧，前端可据此标注）
        //   ②refreshing=true = 同时有一次后台重算在跑（下一次打开就会变新）
        //   旧字段 `ageMs/computedAt/computeMs/ttlMs` 全部保留（前端"缓存龄"渲染不动）。
        stale: r.stale === true,
        refreshing: r.refreshing === true,
        computedAt: r.computedAt,
        ageMs: r.ageMs ?? 0,
        computeMs: r.computeMs ?? 0,
        ttlMs,
      },
    },
  };
}

/** 该片组合的缓存键（路由/自检用）。 */
export function shardCacheKey(selection) {
  return cacheKeyOf(selection?.requested ?? []);
}
