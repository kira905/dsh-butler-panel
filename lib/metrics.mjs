// dsh-butler-panel / lib/metrics.mjs
// 【v1.1 修订块 B1①】六项指标的**唯一入口**（面板实时路径与缓存路径调同一函数）。
//
// 状态（2026-09-14 · 卡 A2「lib\metrics.mjs 唯一入口 + 离线夹具」）：
//   A1 卡冻结接口；本卡落地真实计算。**本模块是纯函数库**：
//     · 不读文件、不写文件（数据源由调用方采集后作为入参注入）
//     · 不 import 面板其他模块（state.js / client.js / index.js / checks.mjs 一律不碰）
//     · 不调 LLM（B5：面板任何路径禁止 generateAdvice / callZhipu）
//     · 无模块加载期时间常量（V2-0 的 TODAY 缺陷：跨零点后"今日"永久停在启动那天）
//       → 所有"今日"类判定一律用**注入的 now**（`input.now` / `opts.now`）
//     · 同一输入两次调用 → JSON 逐字节相等（R5 前半：`metricsDigest()` sha256 相等）
//
// 调用方（面板 V2-B / 快照 job / 离线比对脚本）负责采集各数据源，形状见下方 `Sources` 契约。
//
// ---------------------------------------------------------------------------
// Sources 契约（每个源都允许"整个缺失"→ 该分项必须报 `available:false` + 原因，
//   **绝不允许用 0 冒充"没有数据"** —— B4 与 I5 的教训：`count=0` 同时代表"没干活"与"没数据"）
//
//   sources.watch        未 ack 事件：`shards.mjs#collectWatchUnacked` 的输出
//                        （{ok, count, items[{id,level,title,at,ackToken}], oldestAt, asOf, reason}）
//                        或原始 `butler-watch-state.json` + `deps.listUnacked`
//   sources.board        待验收卡：`shards.mjs#collectBoardReview` 的输出
//                        （{ok, count, settledCount, aliveCount, aliveKnown, items, asOf, reason}）
//   sources.autoActions  `butler-auto-actions.json` 内容，或 {ok, data, asOf}
//   sources.autonomy     {l0: readAutonomyState(), l2: describeModules(), expectedDisabledIds?, asOf}
//   sources.assets       {eco: <生态面板 /state 或它的 groups>, mirror?: {...}, asOf}
//   sources.tasks        {ok, running: <array|number>, todo: <array|number>, asOf}（看板现口径）
//   sources.falsePositive{byMachine, checksSegment4?, pool, detailComplete, asOf}
//   sources.tickd        {level|judge:{level}, asOf}
//   sources.quotaGate    【⑥ 包 §3.4-P1 · 施工卡 ⑥-2】额度闸：
//                        {ok, day, daily:{used,max,reached}, limits:{max,source,file},
//                         ledger:{available,exists,lines,badLines,degradedBatches,blockedCount,
//                                 byKind,byGate,last,error,file}, asOf:{at,source}}
//                        `daily` 必须由采集层用 **butler 库的 `checkDailyLimit`（唯一判定函数）** 算出后注入；
//                        本模块**不重算额度判定**（同源纪律）。台账汇总 = `readQuotaLedger({home,day})` 的输出原样传入。
// ---------------------------------------------------------------------------
//
// 【同源纪律（§4.3 单一数据源铁律）】本模块**只做聚合与呈现，不复制任何判定逻辑**：
//   · 未 ack 计数 = `lib/watch-policy.mjs#listUnacked` 的输出（唯一权威源，面板禁止自算）
//   · 待验收卡   = `lib/queue-watch.mjs#pickReviewCards + isExecutionAlive` 的双判据结果（由采集方算好传入）
//   · 误报率     = 当日日报「📊 误报率」段的同源值（真源 = `butler-barewatch-state.json` 的 `summary`，
//                  该段由 `barewatch-tick.mjs#refreshDailySection` 写入；`checks.mjs` 段 4 的值一并回显作交叉核对）
//   · 已关模块   = `lib/autonomy-modules.mjs#describeModules`（与日报摘要「🛑 已关闭模块」同源）
//   · tickd 心跳 = `lib/tickd-health.mjs#judgeTickdHealth().level`（只取 level，**面板不自算 age**：
//                  该字段是 UTC，混用会造成 8 小时级假告警）
//
// ---------------------------------------------------------------------------
// 三种返回形态（同一函数、同一输入 → 同口径；**计数/状态绝不同档位而变**）
//
//   | 形态 | 触发 | 载荷 | 内容 |
//   |---|---|---|---|
//   | `full`  | 默认 | 生产实测 ~10 KB | 全量：六项 + 分项 + 逐项 asOf + 明细 items + 说明文案 + errors |
//   | `shard` | `opts.profile:'shard'` | **恒 ≤ `SHARD_BUDGET_BYTES`(2048)** ✓ | 片用：六项数字/状态 + 分项计数 + 片级 asOf + errors + `textIn:'full'` + `trimLevel` |
//   | `slim`  | **未注入任何源**（A1 兼容调用 `collectMetrics({now})`） | ~1.5 KB | 汇总原因 + 每项骨架（一律 null，绝不给 0） |
//
//   ⚠️ metrics 片预算 ≤2 KB（v1.1 B2）是**硬断言**（`_test/test-shards.mjs` + `_test/metrics-live-compare.mjs`）：
//   V2-B 接入时必须走 `collectMetrics({now, sources}, { profile:'shard' })` —— full 档 ~10 KB 会撑爆 5 倍。
//   明细的归属是 core 片的 `watch.unacked` / `board.review`，本就不该进 metrics 片。
//   裁剪纪律：**任何计数、状态、asOf、errors 一字不动**，裁的只有明细列表与说明文本（§ toShard 注释）。
//
//   🛠 **返工修正（2026-09-14 · 卡 A2 第三方验收 ①）**：旧 shard 档是"一次性固定裁剪"，字段仍随
//   数据量增长（顶层 reason 全文、errors 2×60 字、gateLabelMachine 长限定词、parts[*].reason 4×40 字、
//   byKind 键数随动作种类增长）→ 生产真值 **2,184 B 破线**。现改为「结构上限 + 阶梯降级」：
//   `SHARD_LADDER` 逐档收缩文本与折叠映射，**第一个 ≤ 预算的档胜出**；极限档只含数字/短枚举键
//   （其尺寸与数据量无关）⇒ 预算恒成立由**阶梯终止性**保证，不靠"当天样本恰好够小"。降级程度随
//   `trimLevel` 暴露（0 = 完整档），前端遇 >0 时明细/说明去 full 档取（`textIn:'full'`）。
//
// 【V2-B 接入清单（本卡 A2 不做，留给出接入卡）】
//   ① `shards.mjs#collectCoreShard` 的 watch/board 两个采集结果 → 作为 sources 传给 collectMetrics
//   ② 传 `{ profile: 'shard' }`；③ 复用同一份 sources 才能满足 R5 的"缓存/实时两路 sha256 相等"

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { engineLibDirs } from './engine-search.mjs';

/** 指标模块版本（唯一入口；接口字段名自 A1 冻结后不得改）。 */
// 0.2.1（2026-09-18 · 施工卡 ⑥-2「面板额度字段」）：`autoActionsToday` **只追加** `quotaGate`
//   （既有字段名与语义一字未动 —— ①包判据 6「结构不变 + 只追加」）。消费方按 `>= 0.2.1` 判字段在否。
export const METRICS_VERSION = '0.2.1';

/** 六项指标的键（顺序即前端展示顺序）。 */
export const METRIC_KEYS = Object.freeze([
  'pendingTodo',
  'autonomy',
  'autoActionsToday',
  'assetAnomalies',
  'inflight',
  'falsePositive',
]);

/** 指标 #2 里「预期关闭」的判定：由调用方注入 id 集合（登记表 `MODULE_IDS` 的 `baseline===false` 行）。 */
export const EXPECTED_DISABLED_HINT = '锁后交付（baseline=false）：p3-auto / queue-wake / p8-tidy / p9-handoff / p0-auto-restart / p5-auto-rollback / auto-heal';

/** 指标 #6「按机」口径的限定词（达标必须带限定词：按机 ≤10% ≠ 池级门槛）。 */
export const GATE_LABEL_MACHINE = '按机（该机自算）：误报率 <5% / 累计 ≥50 / 疑似占比 ≤10%';
/** 指标 #6 池级口径的限定词。 */
export const GATE_LABEL_POOL = '池级（跨机并集）：L1 25 条·15 独立状况 / L2 50 条·30 独立状况，且零稳态真误报';

/** 「需确认动作」的统计窗口默认值：7 天（`lastResults` 是滚动窗口，无"已处理"标记，故按时间收敛）。 */
export const NEED_CONFIRM_WINDOW_MS = 7 * 86_400_000;

/** 分项明细里每条最多带多少条（载荷纪律：metrics 片预算 ≤2 KB）。 */
export const ITEM_CAP = 5;

/** metrics 片载荷**硬上限**（v1.1 修订块 B2：`metrics` 片 ≤ 2 KB）。shard 档恒不超过它。 */
export const SHARD_BUDGET_BYTES = 2048;

/** shard 档限定词短码（完整限定词文案 `GATE_LABEL_MACHINE` 留在 full 档；B4#6 只要求"带限定词"）。 */
export const SHARD_GATE_LABEL_MACHINE = '按机';

/**
 * shard 档降级阶梯（返工修正 ①：把"≤2 KB"从经验值变成**结构保证**）。
 *
 * 每档只描述"文本留多长 / 折叠映射是否保留"，计数与状态字段**与档位无关**：
 *   · `reason`    顶层汇总原因（含多源诊断）的字符上限，0 = 不带
 *   · `errMax` / `errText`  `errors[]` 条数上限 / 每条字符上限
 *   · `partReason`  分项 `reason` 字符上限（0 = 只留 `reasonTrimmed:true` 标记，不伪装成"无原因"）
 *   · `l0Text`    L0 档位说明文本（`l0Reason` / `l0Unavailable`）字符上限，0 = 不带
 *   · `maps`      是否保留折叠映射（`byKind` / `byStatusToday` / `byLevel`）——**键数随数据量增长**的那部分
 *
 * 终止性：`maps:false` 且全部文本上限为 0 时，输出只剩固定键名 + 数字/短枚举 ⇒ 尺寸与数据量无关，
 * 必然 ≤ `SHARD_BUDGET_BYTES`；故阶梯总能停在某一档，预算恒成立（`_test/test-metrics.mjs` 用
 * 极端放大输入实测该终止性）。
 */
export const SHARD_LADDER = Object.freeze([
  // 0 · 常态档（生产真值落这一档时，六项与 full 档逐值一致）
  { reason: 48, errMax: 2, errText: 48, partReason: 32, l0Text: 16, maps: true },
  // 1 · 文案偏长（如顶层 reason 含多源诊断文本）：文本再压一档，明细仍全
  { reason: 24, errMax: 1, errText: 32, partReason: 16, l0Text: 0, maps: true },
  // 2 · 折叠映射偏大（动作种类多 → byKind 键数增长）：只留计数，文本压到最短
  { reason: 16, errMax: 1, errText: 24, partReason: 0, l0Text: 0, maps: false },
  // 3 · 极端档：零文本 + 零折叠映射 ⇒ 尺寸与数据量无关（结构保证 ≤ 预算）
  { reason: 0, errMax: 0, errText: 0, partReason: 0, l0Text: 0, maps: false },
]);

/** UTF-8 字节数（与 `Buffer.byteLength(x,'utf8')` 同口径；纯函数、零 IO，供断言与降级判据共用）。 */
export function shardBytes(x) {
  try {
    return new TextEncoder().encode(typeof x === 'string' ? x : JSON.stringify(x)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// 纯工具
// ---------------------------------------------------------------------------

/** 本地时区日键 `YYYY-MM-DD`（与 `state.js#localDayKey` 同口径；此处独立实现以免 import 面板模块）。 */
export function localDayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 指标的规范化摘要（缓存路径与实时路径用**同一函数**比较：R5 前半）。 */
export function metricsDigest(metrics) {
  return createHash('sha256').update(JSON.stringify(metrics) ?? 'null').digest('hex');
}

/** 稳定键序（对象按键名排序 → 同一输入产出逐字节一致）。 */
function stableObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj ?? null;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function clampItem(it) {
  return {
    id: String(it?.id ?? ''),
    level: it?.level ?? null,
    title: String(it?.title ?? '').slice(0, 60),
    at: num(it?.at, null),
    ackToken: it?.ackToken ?? null,
  };
}

function asOfOf(src, defaultSource = null) {
  const a = src?.asOf;
  if (a === undefined || a === null) return { at: null, source: defaultSource };
  if (typeof a === 'number') return { at: Number.isFinite(a) ? a : null, source: defaultSource ?? 'generated' };
  if (typeof a === 'object') {
    return {
      at: num(a.at, null),
      source: a.source ?? defaultSource ?? null,
    };
  }
  return { at: null, source: defaultSource };
}

/**
 * 源是否可用。约定：`ok === false` 或 `missing === true` 才算"不可用"；
 * 原始 JSON（无 ok 字段）默认视为可用（调用方既然传进来就是读到了）。
 */
function usable(src) {
  return Boolean(src) && typeof src === 'object' && src.ok !== false && src.missing !== true;
}

function unusableReason(src, fallback) {
  return String(src?.reason ?? src?.error ?? fallback);
}

function countOfList(v) {
  if (Array.isArray(v)) return v.length;
  const n = num(v, null);
  return n;
}

// ---------------------------------------------------------------------------
// butler lib 的**只读**探测（仅用于把 listUnacked 这一条权威判据拿到手；
//   面板 V2-B 走自己的动态加载器注入时优先用注入值）
// ---------------------------------------------------------------------------

// 本模块承诺"纯函数、不 import 面板其他模块"，所以这里只按**环境变量**算候选目录，
// 不引 ./butler-root.mjs（保持 metrics.mjs 的零依赖性质）。
const BUTLER_LIB_DIRS = [
  process.env.DSH_BUTLER_LIB_DIR,
  (process.env.BUTLER_ROOT ?? '').trim() ? path.join(process.env.BUTLER_ROOT.trim(), 'lib') : null,
  (process.env.DSH_WORKSPACE ?? '').trim() ? path.join(process.env.DSH_WORKSPACE.trim(), 'tools', 'dsh-butler', 'lib') : null,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dsh-butler', 'lib'),
  // 全新机器上没有「大管家工具目录」，但可能有已安装的 npm 包（@kira905/dsh-butler-engine）。
  // 这里只借 engine-search 的**纯路径**能力，不碰任何面板业务模块，本文件的零依赖性质不变。
  ...engineLibDirs('butler'),
].filter(Boolean);

async function tryImport(url) {
  try { return await import(url); } catch { return null; }
}

/** 探测 butler lib（不读业务文件；路径探测只为在本机/部署后都能找到库）。 */
export async function resolveButlerLib(name) {
  const seen = new Set();
  for (const dir of BUTLER_LIB_DIRS) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    let href = null;
    try { href = pathToFileURL(path.join(dir, name)).href; } catch { continue; }
    const mod = await tryImport(href);
    if (mod) return mod;
  }
  return null;
}

const builtinLibs = {
  watchPolicy: await resolveButlerLib('watch-policy.mjs'),
  queueWatch: await resolveButlerLib('queue-watch.mjs'),
};

/** 内置依赖可用性（供调用方/单测断言"权威源是否到位"）。 */
export function builtinDepsStatus() {
  return {
    listUnacked: typeof builtinLibs.watchPolicy?.listUnacked === 'function',
    isExecutionAlive: typeof builtinLibs.queueWatch?.isExecutionAlive === 'function',
    queueWatchVersion: builtinLibs.queueWatch?.QUEUE_VERSION ?? null,
    watchPolicyVersion: builtinLibs.watchPolicy?.WATCH_POLICY_VERSION ?? null,
  };
}

// ---------------------------------------------------------------------------
// 指标 #1 · 🔴 待我处理（三项分项相加，**不去重**）
// ---------------------------------------------------------------------------

/**
 * 未 ack（分项①）：唯一权威源 = `watch-policy.mjs#listUnacked`。
 * 接受两种输入：已算好的计数（面板 core 片路径）或原始 state（离线夹具/独立调用路径）。
 * @returns {object} 分项
 */
/**
 * 未 ack 明细的 🔴/🟡 分色（**2026-09-14 生产实测**：`watch-policy.applyPolicy` 写 `events` 时
 *   **不落 `level` 字段** → `listUnacked` 的 item.level 只能回 null（deferred 项才有 level，但 events 恒胜）。
 *   ⇒ 分色不可得是**数据源事实**，必须如实标注 `byLevelKnown:false`，绝不能让前端把
 *   `byLevel.red=0` 读成"没有红黄告警"。）
 */
function byLevelOf(items, count) {
  const byLevel = { red: 0, yellow: 0, other: 0 };
  for (const it of Array.isArray(items) ? items : []) {
    if (it?.level === 'red') byLevel.red++;
    else if (it?.level === 'yellow') byLevel.yellow++;
    else byLevel.other++;
  }
  const seen = Array.isArray(items) ? items.length : 0;
  const levelKnown = seen === 0 ? true : items.some((it) => it?.level !== null && it?.level !== undefined);
  return {
    byLevel,
    byLevelSeen: seen,
    byLevelPartial: seen < (count ?? seen),
    byLevelKnown: levelKnown,
    byLevelNote: levelKnown
      ? null
      : 'watch state 的 events 记录未存 level 字段 → 🔴/🟡 分色不可得（红黄总数不可分；未 ack 总数仍然有效）',
  };
}

function partWatchUnacked(src, ctx) {
  const asOf = asOfOf(src, 'file-mtime');
  if (!usable(src)) {
    return {
      available: false, count: null, reason: unusableReason(src, 'watch 源未注入（未 ack 数据不可得）'), asOf,
    };
  }
  // 形态 A：已由 listUnacked 算好（core 片同源复用，推荐路径）
  const direct = num(src.count, null);
  if (direct !== null) {
    const items = Array.isArray(src.items) ? src.items.slice(0, ITEM_CAP) : [];
    return {
      available: true,
      count: direct,
      oldestAt: num(src.oldestAt, null),
      ...byLevelOf(src.items, direct),
      deduped: num(src.deduped, null),
      items: items.map(clampItem),
      authority: 'listUnacked',
      asOf,
    };
  }
  // 形态 B：原始 watch state → 调权威函数现算
  if (src.state && typeof src.state === 'object') {
    const fn = ctx.deps.listUnacked ?? builtinLibs.watchPolicy?.listUnacked;
    if (typeof fn !== 'function') {
      return {
        available: false, count: null, asOf,
        reason: 'watch state 已给但 listUnacked 未注入/不可加载（不复制判据，故不可算）',
      };
    }
    try {
      const r = fn(src.state, { now: ctx.now });
      const items = Array.isArray(r.items) ? r.items : [];
      const count = num(r.count, items.length);
      return {
        available: true,
        count,
        oldestAt: num(r.oldestAt, null),
        ...byLevelOf(items, count),
        deduped: num(r.deduped, null),
        items: items.slice(0, ITEM_CAP).map(clampItem),
        authority: 'listUnacked(live)',
        asOf,
      };
    } catch (e) {
      return { available: false, count: null, asOf, reason: 'listUnacked 抛错：' + String(e?.message ?? e) };
    }
  }
  return { available: false, count: null, asOf, reason: unusableReason(src, 'watch 源形状不可识别（既无 count 也无 state）') };
}

/**
 * 待验收卡（分项②）：**双判据** `status==='review'` ∧ 执行会话已结束（`isExecutionAlive`）。
 * 判据不可得的处置（明写，绝不猜）：
 *   · `aliveKnown===false`（session.list 整份拿不到）→ `judgement:'unknown'`、`count:null`
 *     （**不按"执行已结束"计数**，也不回显原始 review 数当结果）
 *   · 卡无 executions / 无 sessionId（`isExecutionAlive` 的 `known:false`）→ 该卡判 `settled:false`
 *     且计入 `unknownExecution`，**不计入待验收**（沿用 queue-watch 的保守语义：拿不准就不叫醒）
 */
function partBoardReview(src) {
  const asOf = asOfOf(src, 'rpc');
  if (!usable(src)) {
    return { available: false, count: null, judgement: 'unknown', reason: unusableReason(src, '看板 Host API 未注入（待验收卡不可得）'), asOf };
  }
  if (src.aliveKnown === false) {
    return {
      available: true,
      count: null,
      judgement: 'unknown',
      rawReviewCount: num(src.count, null),
      reason: 'session.list 不可得 → 双判据第二半未判定（不按"执行已结束"处理）',
      items: (Array.isArray(src.items) ? src.items : []).slice(0, ITEM_CAP).map((x) => ({ id: x?.id ?? null, title: String(x?.title ?? '').slice(0, 60), settled: false })),
      asOf,
    };
  }
  let settled = num(src.settledCount, null);
  let unknownExecution = num(src.unknownExecution, null);
  if (settled === null && Array.isArray(src.items)) {
    // 兜底：从明细数（明细可能被 cap 截断 → 标注 partial）
    settled = src.items.filter((x) => x?.settled === true).length;
    unknownExecution = src.items.filter((x) => x?.settled !== true).length;
  }
  if (settled === null) {
    return { available: false, count: null, judgement: 'unknown', reason: unusableReason(src, '看板源既无 settledCount 也无明细（待验收数不可得）'), asOf };
  }
  return {
    available: true,
    count: settled,
    judgement: 'settled',
    rawReviewCount: num(src.count, null),
    aliveCount: num(src.aliveCount, null),
    unknownExecution,
    items: (Array.isArray(src.items) ? src.items : []).slice(0, ITEM_CAP).map((x) => ({ id: x?.id ?? null, title: String(x?.title ?? '').slice(0, 60), settled: x?.settled === true })),
    asOf,
  };
}

/**
 * 需确认动作（分项③）：分级表 L3（`auto:false`，只通知/预览确认）。
 * 源 = `butler-auto-actions.json` 的 `lastResults`；去重键 = `sigKey`（缺则 `kind|at`）；
 * 窗口 = `NEED_CONFIRM_WINDOW_MS`（`lastResults` 无"已处理"标记，滚动窗口按时间收敛，防历史累积虚高）。
 * 判据不复制：是否 L3 一律读条目自带的 `level` 字段（登记表见 `lib/autonomy-actions.mjs#AUTO_ACTION_KINDS`）。
 */
function collectNeedConfirm(aaData, now, windowMs, itemCap = ITEM_CAP) {
  const rows = Array.isArray(aaData?.lastResults) ? aaData.lastResults : [];
  const cut = now - windowMs;
  const seen = new Map();
  let deduped = 0;
  let outOfWindow = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (String(r.level ?? '') !== 'L3') continue;
    const at = num(r.at, null);
    if (at !== null && at < cut) { outOfWindow++; continue; }
    const key = String(r.sigKey ?? `${r.kind ?? '?'}|${at ?? 0}`);
    if (seen.has(key)) { deduped++; continue; }
    seen.set(key, {
      key,
      kind: r.kind ?? null,
      label: r.label ?? null,
      status: r.status ?? null,
      dryRun: r.dryRun === true,
      at,
      reason: String(r.reason ?? '').slice(0, 120),
    });
  }
  const items = [...seen.values()]
    .sort((a, b) => ((b.at ?? 0) - (a.at ?? 0)) || String(a.key).localeCompare(String(b.key)))
    .slice(0, itemCap);
  return { count: seen.size, items, deduped, outOfWindow, windowMs };
}

function partNeedConfirm(aaUsable, aaData, ctx, windowMs) {
  const asOf = asOfOf(aaData?.__src ?? null, 'file-mtime');
  if (!aaUsable) {
    return { available: false, count: null, reason: '自动动作状态文件未注入/不可读（需确认动作不可得）', asOf };
  }
  const r = collectNeedConfirm(aaData, ctx.now, windowMs);
  return {
    available: true,
    count: r.count,
    deduped: r.deduped,
    outOfWindow: r.outOfWindow,
    windowMs: r.windowMs,
    items: r.items,
    authority: 'auto-actions.lastResults[level=L3]',
    asOf,
  };
}

function buildPendingTodo(srcs, ctx, windowMs) {
  const watchUnacked = partWatchUnacked(srcs.watch, ctx);
  const boardReview = partBoardReview(srcs.board);
  const needConfirm = partNeedConfirm(ctx.aaUsable, ctx.aaData, ctx, windowMs);

  const parts = { watchUnacked, boardReview, needConfirm };
  const allParts = Object.keys(parts);
  const missing = allParts.filter((k) => parts[k].count === null);
  const allMissing = missing.length === allParts.length;
  // 【红线】全部分项不可得时 **knownSum 也是 null**（不是 0）：0 会被前端读成"今天没事要你处理"
  const knownSum = allMissing ? null : allParts.reduce((a, k) => a + (parts[k].count ?? 0), 0);
  const available = !allMissing;
  for (const k of missing) {
    const r = parts[k]?.reason ?? '不可得';
    ctx.err(`pendingTodo.${k}`, r);
  }
  const value = missing.length === 0 ? knownSum : null;
  return {
    available,
    value,
    knownSum,
    display: allMissing
      ? `不可探测（${missing.length} 项数据未就绪）`
      : (missing.length === 0
        ? `${value} 件待你处理（未 ack ${parts.watchUnacked.count} + 待验收 ${parts.boardReview.count} + 需确认 ${parts.needConfirm.count}）`
        : `已知 ${knownSum} 件待处理（${missing.length} 项数据未就绪：${missing.join('、')}）`),
    parts,
    unavailableParts: missing,
    partial: missing.length > 0,
    asOf: { watchUnacked: watchUnacked.asOf, boardReview: boardReview.asOf, needConfirm: needConfirm.asOf },
    authority: '分项相加、不去重（三类对象天然键不同：watch=eventId+ackToken / 卡=卡id / 动作=sigKey）',
  };
}

// ---------------------------------------------------------------------------
// 指标 #2 · 🚦 自治档位（L0 档位 + L2 已关模块数，两个数分开）
// ---------------------------------------------------------------------------

function moduleRows(l2) {
  const m = l2?.modules;
  if (Array.isArray(m)) return m;
  if (m && typeof m === 'object') return Object.values(m);
  return null;
}

function buildAutonomy(srcs, ctx) {
  const au = srcs.autonomy;
  const asOf = asOfOf(au, 'file-mtime');
  const l0 = au?.l0 ?? null;
  const l2 = au?.l2 ?? null;

  let l0Level = null;
  let l0Unavailable = null;
  if (!au) l0Unavailable = 'autonomy 源未注入（L0 档位不可得）';
  else if (!l0 || typeof l0 !== 'object') l0Unavailable = 'L0 档位（readAutonomyState）未注入';
  else if (typeof l0.level !== 'string') l0Unavailable = 'readAutonomyState 输出无 level 字段';
  else l0Level = l0.level;
  if (l0Unavailable) ctx.err('autonomy.l0Level', l0Unavailable);

  const rows = moduleRows(l2);
  let l2DisabledCount = null;
  let disabled = [];
  let l2Unavailable = null;
  if (!au) l2Unavailable = 'autonomy 源未注入（L2 模块开关不可得）';
  else if (!l2 || typeof l2 !== 'object') l2Unavailable = 'L2 模块开关（describeModules）未注入';
  else if (rows === null) l2Unavailable = 'describeModules 输出无可识别的 modules（object/array 皆非）';
  else {
    disabled = rows.filter((m) => m && m.enabled !== true).map((m) => ({
      id: String(m.id ?? ''),
      label: String(m.label ?? ''),
      owner: m.owner ?? null,
      source: m.source ?? null,
      since: m.since ?? null,
      by: m.by ?? null,
      why: m.why ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id));
    l2DisabledCount = disabled.length;
  }
  if (l2Unavailable) ctx.err('autonomy.l2DisabledCount', l2Unavailable);

  // 预期关闭 vs 异常关闭：预期集合由调用方注入（登记表 MODULE_IDS 的 baseline===false 行），**不在本模块硬编码**
  const expectedIds = Array.isArray(au?.expectedDisabledIds) ? au.expectedDisabledIds.map(String) : null;
  let expectedDisabled = null;
  let unexpectedDisabled = null;
  let splitNote = null;
  if (l2DisabledCount !== null) {
    if (expectedIds === null) {
      splitNote = '调用方未注入 expectedDisabledIds（登记表 baseline=false 行）→ 预期/异常关闭**未判定**（不猜）';
      ctx.err('autonomy.unexpectedDisabled', splitNote);
    } else {
      const exp = new Set(expectedIds);
      expectedDisabled = disabled.filter((m) => exp.has(m.id)).map((m) => m.id);
      unexpectedDisabled = disabled.filter((m) => !exp.has(m.id)).map((m) => m.id);
    }
  }

  return {
    available: l0Level !== null || l2DisabledCount !== null,
    l0Level,
    l0Reason: l0?.reason ?? null,
    l0Source: l0?.source ?? null,
    l0Unavailable,
    l2DisabledCount,
    l2TotalCount: rows ? rows.length : null,
    l2Unavailable,
    disabled,
    expectedDisabled,
    unexpectedDisabled,
    splitNote,
    expectedHint: EXPECTED_DISABLED_HINT,
    asOf: { l0: asOf, l2: asOf },
    authority: 'L0 = lib/autonomy-state.mjs#readAutonomyState；L2 = lib/autonomy-modules.mjs#describeModules',
  };
}

// ---------------------------------------------------------------------------
// 指标 #3 · ⚙️ 今日自动办好（口径 = `noQuotaCount`，**不是** `count`）
// ---------------------------------------------------------------------------

/**
 * 指标 #3 的 authority 文案（**审核批注⑧同步改**：⑥ 包 §3.4-P1 原稿新增 `quotaGate.used` 会与既有
 * `quotaCount` 同事实两处，踩 ①包冻结项「同一事实只许一处权威源」⇒ 本卡定为「`quotaGate` 是
 * `quotaCount` 的**视图**」并在权威源文案里写明，不再暗示它是第二个事实）。
 */
const AUTO_ACTIONS_AUTHORITY = 'lib/autonomy-actions.mjs（daily[<localDay>].noQuotaCount；'
  + 'quotaCount=吃配额数，非本口径；quotaGate.used ≡ quotaCount **同一事实的视图**（唯一权威源仍是 daily[<localDay>].count），'
  + 'max/reached = checkDailyLimit 同源输出，degradedToday = 额度台账汇总）';

/**
 * 额度闸分项（【施工卡 ⑥-2】⑥ 包 §3.4-P1「面板」行的落地件）。
 *
 * 口径（逐条守审核批注⑧与 §7.1⑤）：
 *   · `used` = **既有 `quotaCount` 的视图**（同一事实、同一权威源 `daily[<day>].count`），**不另起事实源**；
 *   · `byKindQuota` = `daily[<day>].quotaByKind`（**只计真占配额**的分账）——**不复用老 `byKind`**（全量混合语义）；
 *   · `degradedToday` = 降级台账今日批次数：**文件不存在 ⇒ 0（从未降级 = 正常）**；
 *     **台账读失败/解析不出 ⇒ `null` + reason（判"未观测"，绝不判 0）**；
 *   · `max` / `reached` 一律取采集层用 `checkDailyLimit`（唯一判定函数）算好的注入值，本模块不重算；
 *   · 护栏源/台账源整体未注入 ⇒ `available:false` + reason（不可探测，仍是 `null` 而非 0）。
 *
 * @param {object} ctx  计算上下文（读 `ctx.qgSrc` / `ctx.qgDay`）
 * @param {{quotaCount:number|null, quotaByKind:object|null}} view 既有字段的视图（used / byKindQuota）
 */
function buildQuotaGate(ctx, view) {
  const QG_AUTHORITY = 'used ≡ 既有 quotaCount（lib/autonomy-actions.mjs 的 daily[<localDay>].count，同一事实视图）；'
    + 'max/reached = checkDailyLimit（唯一判定函数，采集层算好注入）；'
    + 'degradedToday/byKind/degradedByKind = readQuotaLedger({home,day})（额度台账只读汇总）';
  const base = {
    available: false,
    used: view.quotaCount,
    max: null, reached: null,
    degradedToday: null, degradedBlocked: null, degradedByKind: null,
    byKindQuota: view.quotaByKind,
    ledger: null, last: null, crossCheck: null,
    day: ctx.qgDay ?? null,
    display: null, reason: null,
    asOf: asOfOf(null, 'file-mtime'),
    authority: QG_AUTHORITY,
  };
  const src = ctx.qgSrc ?? null;
  if (!usable(src)) {
    const reason = unusableReason(src, '额度闸源未注入（护栏限额与降级台账均不可探测）');
    ctx.err('autoActionsToday.quotaGate', reason);
    return { ...base, available: false, display: '不可探测（' + reason + '）', reason };
  }

  const d = src.daily && typeof src.daily === 'object' ? src.daily : null;
  const led = src.ledger && typeof src.ledger === 'object' ? src.ledger : null;
  const ledgerAvailable = Boolean(led) && led.available === true;

  // ── 同源交叉核对（①包冻结项②：判定只有一处；两处不一致就显式报错，不静默择优）──
  const injectedUsed = d ? num(d.used, null) : null;
  let crossCheck = null;
  if (injectedUsed !== null && view.quotaCount !== null && injectedUsed !== view.quotaCount) {
    crossCheck = `checkDailyLimit.used(${injectedUsed}) ≠ daily.count(${view.quotaCount}) —— 两源不一致，used 取既有 quotaCount`;
    ctx.err('autoActionsToday.quotaGate', crossCheck);
  }

  // ── max / reached：全部来自注入（判定在库）──
  const max = num(d?.max, null) ?? num(src.limits?.max, null);
  // 今日无 daily 记录（quotaCount === null）⇒ reached 只能是 null：**"没有数据"不等于"没达上限"**
  const reached = (d && typeof d.reached === 'boolean' && view.quotaCount !== null) ? d.reached : null;

  // ── 降级台账：可用 ⇒ 计数；不可用 ⇒ null + reason（**三态：正常 0 / 不可用 null / 从未降级 0**）──
  const degradedToday = ledgerAvailable ? num(led.degradedBatches, null) : null;
  const degradedBlocked = ledgerAvailable ? num(led.blockedCount, null) : null;
  const degradedByKind = ledgerAvailable ? stableObject(led.byKind ?? {}) : null;
  const ledger = led ? {
    available: ledgerAvailable, exists: led.exists === true, lines: num(led.lines, null),
    badLines: num(led.badLines, null), file: led.file ?? null, error: led.error ?? null,
  } : null;

  const usableGate = max !== null && (view.quotaCount !== null || ledgerAvailable);
  const display = !usableGate
    ? '不可探测（额度护栏不可读' + (ledgerAvailable ? '' : '、降级台账亦不可用 ⇒ 未观测、不判 0') + '）'
    : `额度 ${view.quotaCount === null ? '?' : view.quotaCount}/${max === null ? '?' : max}`
      + (reached === true ? ' ⚠️ 已达上限（其后动作只排队不注入）' : '')
      + (degradedToday === null ? ' · 降级**未观测**（台账不可用，不判 0）' : (degradedToday > 0 ? ` · ⚠️ 今日降级 ${degradedToday} 次` : ' · 今日无降级'));

  return {
    ...base,
    available: usableGate,
    max, reached,
    degradedToday, degradedBlocked, degradedByKind,
    ledger,
    last: ledgerAvailable ? (led.last ?? null) : null,
    crossCheck,
    display,
    reason: usableGate ? (degradedToday === null ? '台账不可用（未观测，非 0）' : null) : '额度护栏不可读',
    asOf: asOfOf(src.asOf !== undefined ? src : led, 'file-mtime'),
  };
}

function buildAutoActionsToday(aaUsable, aaData, ctx) {
  const day0 = localDayKey(ctx.now);
  const asOf = asOfOf(aaData?.__src ?? null, 'file-mtime');
  if (!aaUsable || !aaData) {
    const reason = '自动动作状态文件未注入/不可读（今日自动动作数不可得）';
    ctx.err('autoActionsToday', reason);
    return {
      available: false, hasData: false, date: day0, noQuotaCount: null, quotaCount: null,
      byKind: null, byStatusToday: null, lastAt: null,
      // 【⑥-2】额度闸：aaData 不可用时 used 只能为 null（**不许判 0**）；降级台账与护栏限额跟 aaData 无关，
      //   只要采集层给了源，降级可见性就不因 daily 缺失而消失。
      quotaGate: buildQuotaGate(ctx, { quotaCount: null, quotaByKind: null }),
      display: '不可探测（' + reason + '）', asOf,
      authority: AUTO_ACTIONS_AUTHORITY,
    };
  }
  const daily = aaData.daily && typeof aaData.daily === 'object' ? aaData.daily : {};
  const day = daily[day0] ?? null;

  // 分项（仅作参考，**不计入** noQuotaCount）：lastResults 里落在今天的条目按 status 汇总
  const rows = Array.isArray(aaData.lastResults) ? aaData.lastResults : [];
  const byStatusToday = { executed: 0, 'dry-run': 0, blocked: 0, noop: 0, failed: 0, other: 0 };
  let todayRows = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (localDayKey(num(r.at, NaN)) !== day0) continue;
    todayRows++;
    const s = String(r.status ?? 'other');
    if (Object.prototype.hasOwnProperty.call(byStatusToday, s)) byStatusToday[s]++;
    else byStatusToday.other++;
  }

  if (!day) {
    // 【I5/B4#3】今日无 key → **不是 0**：今日尚无自动动作（数据源可有、今日无记录）
    return {
      available: true, hasData: false, date: day0, noQuotaCount: null, quotaCount: null,
      byKind: null, byStatusToday, todayRows, lastAt: num(aaData.lastRunAt, null),
      // 【⑥-2】今日无 daily key ⇒ used/reached 均为 null（"没有记录" ≠ "0 次"），台账按源如实呈现
      quotaGate: buildQuotaGate(ctx, { quotaCount: null, quotaByKind: null }),
      display: '今日尚无自动动作',
      asOf,
      authority: AUTO_ACTIONS_AUTHORITY,
    };
  }
  const byKind = day.byKind && typeof day.byKind === 'object' ? stableObject(day.byKind) : {};
  // 【⑥-2】分账 `quotaByKind`（⑥ 包 §3.4-P1）：**只计真占配额**的条目，与老 `byKind`（全量混合）并存、语义互不覆盖。
  const byKindQuota = day.quotaByKind && typeof day.quotaByKind === 'object' ? stableObject(day.quotaByKind) : {};
  const noQuotaCount = num(day.noQuotaCount, null);
  return {
    available: true,
    hasData: noQuotaCount !== null,
    date: day0,
    noQuotaCount,
    quotaCount: num(day.count, 0),
    byKind,
    byKindSum: Object.values(byKind).reduce((a, v) => a + (num(v, 0) ?? 0), 0),
    byStatusToday,
    todayRows,
    lastAt: num(day.lastAt, num(aaData.lastRunAt, null)),
    quotaGate: buildQuotaGate(ctx, { quotaCount: num(day.count, 0), quotaByKind: byKindQuota }),
    display: noQuotaCount === null ? '不可探测（今日记录无 noQuotaCount 字段）' : `今日自动办好 ${noQuotaCount} 件`,
    asOf,
    authority: AUTO_ACTIONS_AUTHORITY,
  };
}

// ---------------------------------------------------------------------------
// 指标 #4 · 🧩 资产异常（升级体检 + 镜像缺失 + 补丁漂移 + 解耦违规）
// ---------------------------------------------------------------------------

/**
 * 行状态汇总。默认「非 green 即异常」。
 *
 * `opts.excludeStatuses`（★2026-09-29 · 卡「面板 retired 不计非绿」）：把**预期关闭/不参与判定**的
 * 状态从异常里摘出去 —— 但**不静默丢弃**：摘掉的条数按状态记进返回对象的 `excluded` 里
 * （只在该状态真的摘到条目时才出现该键；没摘到 ⇒ 键缺席 ⇒ 未传 opts 的调用方输出**逐字不变**）。
 * ⚠️ 定向排除**只给该用它的那一处**传：生态面板里只有 `patches` 会出现 `status='retired'`
 * （结构性退休，见 eco panel `state.js#collectPatches`），upgrades 的状态域是
 * green/yellow/red/unknown、decoupling 是 green/yellow/red ⇒ 两处**不得**传本参数。
 */
function tallyStatus(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const excludeStatuses = Array.isArray(opts.excludeStatuses) ? opts.excludeStatuses.map(String) : [];
  const excluded = {};
  const bad = list.filter((x) => {
    if (!x || x.status === 'green') return false;
    const st = x.status == null ? 'null' : String(x.status);
    if (excludeStatuses.includes(st)) {
      excluded[st] = (excluded[st] ?? 0) + 1;
      return false;
    }
    return true;
  });
  const red = bad.filter((x) => x.status === 'red').length;
  const yellow = bad.filter((x) => x.status === 'yellow').length;
  const excludedCount = Object.values(excluded).reduce((a, v) => a + v, 0);
  return {
    available: true,
    total: list.length,
    red,
    yellow,
    count: bad.length,
    items: bad.map((x) => ({
      id: String(opts.nameOf ? opts.nameOf(x) : (x.name ?? x.id ?? '')),
      status: x.status ?? null,
      label: String(x.verdictLabel ?? '').slice(0, 60),
      problems: (x.problems ?? []).slice(0, 1).map((p) => String(p).slice(0, 120)),
    })).slice(0, ITEM_CAP),
    // 被排除的条目**只做呈现**（同 disabledIds 口径）：条数按状态分组，键在排除数为 0 时缺席。
    ...(excludedCount > 0 ? { excluded } : {}),
  };
}

function buildAssetAnomalies(srcs, ctx) {
  const assets = srcs.assets ?? null;
  const asOf = asOfOf(assets, 'http');
  const eco = assets?.eco ?? null;
  const groups = eco?.groups && typeof eco.groups === 'object' ? eco.groups : (eco && (eco.upgrades || eco.patches || eco.decoupling) ? eco : null);

  const parts = {};

  // ① 升级体检
  if (!groups) {
    parts.upgrade = { available: false, count: null, reason: '生态面板 state（缓存）未注入 → 升级体检不可得（面板不打 npm）', asOf };
  } else {
    const t = tallyStatus(groups.upgrades, { nameOf: (x) => x.name });
    const sum = eco?.upgradesMeta?.summary ?? null;
    parts.upgrade = { ...t, summary: sum ? stableObject({ total: sum.total ?? null, green: sum.green ?? null, yellow: sum.yellow ?? null, red: sum.red ?? null }) : null, asOf };
  }

  // ② 镜像缺失（冷盘镜像/回滚点打包：源由调用方注入；两种候选源见卡结论）
  const m = assets?.mirror ?? null;
  if (!usable(m)) {
    parts.mirror = { available: false, count: null, reason: unusableReason(m, '镜像状态源未注入（冷盘镜像/回滚点打包状态不可得）'), asOf: asOfOf(m, 'file-mtime') };
  } else {
    const level = String(m.level ?? (m.ok === false ? 'red' : 'green'));
    const missing = num(m.missing, num(m.missingCount, 0)) ?? 0;
    const count = (level === 'red' ? 1 : 0) + (level === 'yellow' ? 1 : 0) + (missing > 0 && level === 'green' ? 1 : 0);
    parts.mirror = {
      available: true,
      level,
      missing,
      count,
      red: level === 'red' ? 1 : 0,
      yellow: level === 'yellow' ? 1 : 0,
      reason: m.reason ? String(m.reason).slice(0, 160) : null,
      asOf: asOfOf(m, 'file-mtime'),
    };
  }

  // ③ 补丁漂移
  if (!groups) {
    parts.patchDrift = { available: false, count: null, reason: '生态面板 state（缓存）未注入 → 补丁漂移不可得', asOf };
  } else {
    // ⚠️ retired（结构性退休，生态面板 `collectPatches` 的 `status='retired'`）= **不参与判定**：
    //    它是**留在补丁列表里可见**的条目（不删条目、留历史），若按"非 green 即异常"处理，
    //    就会长期挂一条假异常项。故在**本处**定向摘掉，条数记进 `excluded`（只呈现，绝不静默丢弃）。
    //    （disabledPatchIds 是另一回事：那些 id 根本不出现在 patches 行里，本就不参与计数。）
    const t = tallyStatus(groups.patches, { nameOf: (x) => x.id, excludeStatuses: ['retired'] });
    const disabledIds = Array.isArray(groups.disabledPatchIds) ? groups.disabledPatchIds.map(String) : [];
    parts.patchDrift = {
      ...t,
      // ⚠️ 主动禁用（disabledPatchIds）属**预期关闭**，不计入异常；只做呈现
      disabledIds,
      asOf,
    };
  }

  // ④ 解耦违规
  if (!groups) {
    parts.decoupling = { available: false, count: null, reason: '生态面板 state（缓存）未注入 → 解耦违规不可得', asOf };
  } else {
    const t = tallyStatus(groups.decoupling, { nameOf: (x) => x.name });
    parts.decoupling = { ...t, meta: eco?.decouplingMeta ? stableObject({ scriptVersion: eco.decouplingMeta.scriptVersion ?? null, scope: eco.decouplingMeta.scope ?? null }) : null, asOf };
  }

  const missing = Object.entries(parts).filter(([, p]) => p.count === null).map(([k]) => k);
  for (const k of missing) ctx.err(`assetAnomalies.${k}`, parts[k]?.reason ?? '不可得');
  const allMissing = missing.length === Object.keys(parts).length;
  // 【红线】全部分项不可得 → value/red/yellow 一律 null（0 = "资产全绿"是假值）
  const red = allMissing ? null : Object.values(parts).reduce((a, p) => a + (p.red ?? (typeof p.count === 'number' ? p.count : 0)), 0);
  const yellow = allMissing ? null : Object.values(parts).reduce((a, p) => a + (p.yellow ?? 0), 0);
  return {
    available: !allMissing,
    value: allMissing ? null : red + yellow,
    red,
    yellow,
    display: allMissing
      ? `不可探测（${missing.length} 项数据未就绪）`
      : (missing.length === 0
        ? `资产异常 ${red + yellow} 项（🔴 ${red} / 🟡 ${yellow}）`
        : `已知资产异常 ${red + yellow} 项（${missing.length} 项数据未就绪：${missing.join('、')}）`),
    parts,
    unavailableParts: missing,
    partial: missing.length > 0,
    asOf: {
      upgrade: parts.upgrade.asOf,
      mirror: parts.mirror.asOf,
      patchDrift: parts.patchDrift.asOf,
      decoupling: parts.decoupling.asOf,
    },
    authority: '生态面板 /state 缓存（降级/解耦/补丁）+ 冷盘镜像状态；（分项相加、不去重）',
  };
}

// ---------------------------------------------------------------------------
// 指标 #5 · 📥 在途任务（进行中 + 待办；保留现口径便于连续观察）
// ---------------------------------------------------------------------------

function buildInflight(srcs, ctx) {
  const t = srcs.tasks;
  const asOf = asOfOf(t, 'file-mtime');
  if (!usable(t)) {
    const reason = unusableReason(t, '看板任务源未注入（在途任务不可得）');
    ctx.err('inflight', reason);
    return { available: false, value: null, running: null, todo: null, reason, asOf, authority: '看板 collectTasks（running + todo）' };
  }
  const running = countOfList(t.running);
  const todo = countOfList(t.todo);
  if (running === null || todo === null) {
    const reason = '看板源缺少 running/todo（在途任务不可得）';
    ctx.err('inflight', reason);
    return { available: false, value: null, running, todo, reason, asOf, authority: '看板 collectTasks（running + todo）' };
  }
  return {
    available: true,
    value: running + todo,
    running,
    todo,
    backlog: countOfList(t.backlog),
    overdue: countOfList(t.overdue),
    display: `${running + todo} 件在途（进行中 ${running} + 待办 ${todo}）`,
    asOf,
    authority: '看板 collectTasks（running + todo）',
  };
}

// ---------------------------------------------------------------------------
// 指标 #6 · 🎯 误报率（三格：按机 / 池级 L1·L2 / 明细是否完整；达标必带限定词）
// ---------------------------------------------------------------------------

/** 规范化「按机」口径：兼容 barewatch summary（日报段真源）与 checks.mjs 段 4 两种形态。 */
function normalizeByMachine(b, asOf) {
  if (!b || typeof b !== 'object') return null;
  const pct = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
  const gateOf = (g) => (g && typeof g === 'object' ? stableObject({
    rateOk: g.rateOk ?? null,
    sampleOk: g.sampleOk ?? null,
    suspectOk: g.suspectOk ?? null,
    pass: g.pass ?? null,
    warn: g.warn ?? null,
    minSamples: g.minSamples ?? null,
    gateRate: g.gateRate ?? null,
    warnRate: g.warnRate ?? null,
  }) : null);

  // 形态判别必须用**特征字段**：两种形态的 `cumulative` 都叫这个名字，但 barewatch 的是对象、
  //   checks 段 4 的是数字（实测踩过：只按 cumulative 判会把 checks 段 4 误认成 barewatch 口径）。
  const looksChecks = b.totalAlerts !== undefined || b.ready !== undefined || b.hasWatch !== undefined;

  // barewatch summary 形态：{day, dayStats, cumulative:{...}, gate:{rateOk,sampleOk,suspectOk}}
  if (!looksChecks && (b.dayStats || (b.cumulative && typeof b.cumulative === 'object'))) {
    const d = b.dayStats ?? {};
    const c = b.cumulative ?? {};
    return {
      source: 'barewatch-summary',
      day: b.day ?? null,
      today: { total: num(d.total, null), marked: num(d.marked, null), suspect: num(d.suspect, null), rate: pct(d.rate), suspectRate: pct(d.suspectRate) },
      cumulative: { total: num(c.total, null), marked: num(c.marked, null), suspect: num(c.suspect, null), rate: pct(c.rate), suspectRate: pct(c.suspectRate) },
      gate: gateOf(b.gate),
      verdict: b.verdict ?? null,
      gateLabel: GATE_LABEL_MACHINE,
      asOf,
    };
  }

  // checks.mjs 段 4 形态：{ok, totalAlerts, marked, suspect, rate, suspectRate, cumulative, enough, verdict}
  if (b.totalAlerts !== undefined || b.rate !== undefined) {
    return {
      source: 'checks-seg4',
      day: b.day ?? null,
      today: { total: num(b.totalAlerts, null), marked: num(b.marked, null), suspect: num(b.suspect, null), rate: pct(b.rate), suspectRate: pct(b.suspectRate) },
      cumulative: { total: num(b.cumulative, null), marked: null, suspect: null, rate: pct(b.rate), suspectRate: pct(b.suspectRate) },
      gate: b.enough === undefined && b.verdict === undefined ? null : stableObject({
        rateOk: null, sampleOk: b.enough ?? null, suspectOk: null, pass: null, warn: null,
        minSamples: null, gateRate: null, warnRate: null,
      }),
      verdict: b.verdict ?? null,
      gateLabel: GATE_LABEL_MACHINE + '（⚠️ checks 段 4 口径：样本=当前事件数，非观测期累计）',
      asOf,
    };
  }
  return null;
}

function gateRow(g) {
  if (!g || typeof g !== 'object') return null;
  return stableObject({
    available: true,
    pass: g.pass ?? null,
    rowsOk: g.rowsOk ?? null,
    distinctOk: g.distinctOk ?? null,
    steadyFpOk: g.steadyFpOk ?? null,
    marksComplete: g.marksComplete ?? null,
    rows: g.rows ?? null,
    distinct: g.distinct ?? null,
    blockers: Array.isArray(g.blockers) ? g.blockers.map(String) : [],
  });
}

function buildFalsePositive(srcs, ctx) {
  const fp = srcs.falsePositive ?? null;
  const asOf = asOfOf(fp, 'file-mtime');
  const machineRaw = fp?.byMachine ?? null;
  const checksRaw = fp?.checksSegment4 ?? null;

  let byMachine = normalizeByMachine(machineRaw, asOf);
  let crossCheck = null;
  if (!byMachine && checksRaw) {
    byMachine = normalizeByMachine(checksRaw, asOf);
    crossCheck = byMachine;
  } else if (byMachine && checksRaw) {
    crossCheck = normalizeByMachine(checksRaw, asOf);
  }
  if (!byMachine && fp) {
    ctx.err('falsePositive.byMachine', 'falsePositive 源已注入但缺 byMachine/checksSegment4（按机误报率不可得）');
  } else if (!fp) {
    ctx.err('falsePositive.byMachine', 'falsePositive 源未注入（按机误报率不可得）');
  }

  const pool = fp?.pool ?? null;
  const poolGate = pool?.gate ?? null;
  const poolL1 = poolGate ? gateRow(poolGate.L1) : null;
  const poolL2 = poolGate ? gateRow(poolGate.L2) : null;
  if (poolL1 === null || poolL2 === null) {
    ctx.err('falsePositive.poolL1', '池级口径不可得（barewatch-cross 产物未落盘/未注入；该库为纯函数无输出）');
  }

  let detailComplete = fp?.detailComplete;
  if (detailComplete === undefined || detailComplete === null) {
    detailComplete = pool?.summary?.marksComplete ?? null;
  }
  if (detailComplete === null) ctx.err('falsePositive.detailComplete', '明细完整性不可得（pool.summary.marksComplete 缺失）');

  const poolRow = pool ? stableObject({
    rows: num(pool.summary?.rows, null),
    distinct: num(pool.summary?.distinct, null),
    steady: num(pool.summary?.steady, null),
    dev: num(pool.summary?.dev, null),
    marked: num(pool.summary?.marked, null),
    markedUnknown: num(pool.summary?.markedUnknown, null),
    steadyMarked: num(pool.summary?.steadyMarked, null),
    suspect: num(pool.summary?.suspect, null),
    machines: num(pool.summary?.machines, null),
    verdict: pool.poolVerdict ?? pool.verdict ?? null,
  }) : null;

  const available = byMachine !== null || poolL1 !== null || poolL2 !== null;
  return {
    available,
    byMachine,
    crossCheck,
    poolL1: poolL1 ?? { available: false, pass: null, reason: '池级 L1 不可得' },
    poolL2: poolL2 ?? { available: false, pass: null, reason: '池级 L2 不可得' },
    pool: poolRow,
    detailComplete,
    gateLabelMachine: GATE_LABEL_MACHINE,
    gateLabelPool: GATE_LABEL_POOL,
    asOf,
    authority: '按机 = 当日日报「📊 误报率」段同源（barewatch summary）；池级 = lib/barewatch-pool.mjs（纯函数，靠 barewatch-cross 落盘）',
  };
}

// ---------------------------------------------------------------------------
// 顶层
// ---------------------------------------------------------------------------

/**
 * 计算六项指标（**纯函数**）。
 *
 * @param {object} [input] 见文件头 Sources 契约；可直接把源挂在入参上，也可放在 `input.sources`
 * @param {object} [opts]  `now` 同 `input.now`；`deps.listUnacked` / `deps.isExecutionAlive` 可覆盖内置探测
 * @returns {object} `{ok, available, version, items, asOf, errors, note, computedAt}`
 */
export function collectMetrics(input = {}, opts = {}) {
  const nowRaw = opts.now ?? input?.now ?? Date.now();
  const now = Number.isFinite(Number(nowRaw)) ? Number(nowRaw) : Date.now();
  const deps = { listUnacked: opts.deps?.listUnacked ?? null, isExecutionAlive: opts.deps?.isExecutionAlive ?? null };
  const windowMs = Number.isFinite(Number(opts.needConfirmWindowMs)) ? Number(opts.needConfirmWindowMs) : NEED_CONFIRM_WINDOW_MS;

  const errors = [];
  const ctx = {
    now,
    deps,
    err(key, reason) { errors.push(`${key}: ${String(reason)}`); },
  };
  ctx.err = (key, reason) => { errors.push(`${key}: ${String(reason)}`); };

  const srcs = normalizeSources(input);

  // 【⑥-2】额度闸源：采集层注入（daily 由 `checkDailyLimit` 算好 = 判定同源）；本模块只聚合呈现。
  ctx.qgSrc = srcs.quotaGate ?? null;
  ctx.qgDay = (srcs.quotaGate && typeof srcs.quotaGate === 'object' && typeof srcs.quotaGate.day === 'string')
    ? srcs.quotaGate.day
    : localDayKey(now);

  // autoActions：兼容"原始 JSON"与"采集包装"两种形态
  const aaRaw = srcs.autoActions;
  const aaData = (() => {
    if (!aaRaw || typeof aaRaw !== 'object') return null;
    if (aaRaw.data && typeof aaRaw.data === 'object') return { ...aaRaw.data, __src: aaRaw };
    if (aaRaw.daily || aaRaw.lastResults || aaRaw.signatures) return aaRaw;
    return null;
  })();
  ctx.aaData = aaData;
  ctx.aaUsable = usable(aaRaw) && aaData !== null;

  // 【精简档】**没有任何数据源被注入**（典型 = A1 兼容调用 `collectMetrics({now})`、或面板 metrics 片
  //   尚未接入采集器）→ 只返回"汇总原因 + 每项最小骨架"，**不展开逐条诊断文本**。
  //   为什么必须这样：metrics 片的载荷预算 ≤2 KB（v1.1 B2 / 回归项 R2）是**硬断言**；
  //   15 条逐项诊断一展开就是 6.5 KB（2026-09-14 实测，test-shards 的字节断言当场变红）。
  //   逐条诊断只在"确有数据源、但其中若干项缺失"时给（那才是需要排障的场景）。
  const anySourceInjected = Object.values(srcs).some((v) => v !== null && v !== undefined);
  if (!anySourceInjected) return slimUnavailable(now);

  const pendingTodo = buildPendingTodo(srcs, ctx, windowMs);
  const autonomy = buildAutonomy(srcs, ctx);
  const autoActionsToday = buildAutoActionsToday(ctx.aaUsable, aaData, ctx);
  const assetAnomalies = buildAssetAnomalies(srcs, ctx);
  const inflight = buildInflight(srcs, ctx);
  const falsePositive = buildFalsePositive(srcs, ctx);

  // tickd 心跳（只取 level；面板不自算 age）
  const tickdSrc = srcs.tickd ?? null;
  const tickdHealth = (() => {
    if (!usable(tickdSrc)) {
      ctx.err('tickdHealth', unusableReason(tickdSrc, 'tickd 健康源未注入（不可探测）'));
      return { level: null, available: false, reason: unusableReason(tickdSrc, 'tickd 健康源未注入') };
    }
    const level = tickdSrc.level ?? tickdSrc.judge?.level ?? null;
    if (level === null) {
      ctx.err('tickdHealth', 'tickd 源无 level（judgeTickdHealth().level 缺失）');
      return { level: null, available: false, reason: 'tickd 源无 level' };
    }
    // 【卡「tickd 停摆治本」2026-09-23】把"常驻在不在"透传给前端：首屏心跳段要能直说
    // 「引擎未运行」（原先只有 level=red，原因藏在 tooltip 里 —— 看起来像"某个 job 失败"）。
    // 判据仍来自同一份 judgeTickdHealth()，面板不解第二遍。
    return {
      level, available: true,
      reason: tickdSrc.reason ?? tickdSrc.judge?.reason ?? null,
      running: tickdSrc.running ?? tickdSrc.judge?.running ?? null,
      // 【M5】会话异地镜像（判据真源 = `butler-session-mirror.json#consecutiveUnreachable >= 3`）。
      //   上游 = `lib/shards.mjs` 的 `sources.tickd.mirror`（`{lv,n}` 短字段），此处**归一化后**原样透传；
      //   兼容 `{judge:{sessionMirror}}` 形状（A1 兼容调用/夹具）。首屏只认这一个状态位，**面板不重算判据**。
      mirror: (() => {
        const raw = tickdSrc.mirror
          ?? (tickdSrc.judge?.sessionMirror
            ? { lv: tickdSrc.judge.sessionMirror.level, n: tickdSrc.judge.sessionMirror.consecutiveUnreachable }
            : null);
        return raw ? { lv: raw.lv ?? null, n: Number(raw.n ?? 0) } : null;
      })(),
    };
  })();

  const items = {
    pendingTodo,
    autonomy,
    autoActionsToday,
    assetAnomalies,
    inflight,
    falsePositive,
    tickdHealth,
  };

  const asOf = {
    watch: pendingTodo.asOf.watchUnacked,
    board: pendingTodo.asOf.boardReview,
    autoActions: autoActionsToday.asOf,
    autonomyL0: autonomy.asOf.l0,
    autonomyL2: autonomy.asOf.l2,
    assets: assetAnomalies.asOf.upgrade,
    mirror: assetAnomalies.asOf.mirror,
    tasks: inflight.asOf,
    falsePositive: falsePositive.asOf,
    tickd: asOfOf(tickdSrc, 'generated'),
  };

  const sixAvailable = METRIC_KEYS.filter((k) => items[k] && items[k].available === true).length;
  const available = sixAvailable > 0;
  const out = {
    ok: errors.length === 0,
    available,
    version: METRICS_VERSION,
    reason: available ? null : '六项指标全部不可探测（数据源已注入但均不可用）——前端必须显示"不可探测 + 原因"，不得按 0 渲染',
    items,
    asOf,
    errors,
    note: available
      ? `六项指标已计算（可用 ${sixAvailable}/6${errors.length ? `；${errors.length} 项数据未就绪，前端须显式标注` : ''}）`
      : '六项指标全部不可探测（数据源未注入）——前端必须显示"不可探测 + 原因"，不得按 0 渲染',
    counts: { available: sixAvailable, total: METRIC_KEYS.length, errors: errors.length },
    profile: 'full',
    computedAt: now,
  };
  return opts.profile === 'shard' ? toShard(out) : out;
}

/**
 * 【精简档】无任何数据源注入时的返回（见 `collectMetrics` 内注释）。
 * 只给汇总原因 + 每项最小骨架，**不带逐条诊断**，守住 metrics 片 ≤2 KB 预算（B2/R2）。
 * 每项仍然"有结构、无假值"：value/count/knownSum/red/yellow 一律 null（前端按 0 渲染 = 违规）。
 */
function slimUnavailable(now) {
  const nullAsOf = () => ({ at: null, source: null });
  const skeleton = () => ({ available: false, value: null, count: null, knownSum: null, reason: null, asOf: nullAsOf() });
  const items = {};
  for (const k of METRIC_KEYS) items[k] = skeleton();
  // 【⑥-2】额度闸骨架：**结构在、值全 null**（前端读得到字段、"不可探测"不伪装成 0）
  items.autoActionsToday = {
    ...skeleton(),
    hasData: false, date: null, noQuotaCount: null, quotaCount: null,
    byKind: null, byStatusToday: null, lastAt: null, display: null,
    quotaGate: { available: false, used: null, max: null, reached: null, degradedToday: null, degradedBlocked: null,
      degradedByKind: null, byKindQuota: null, ledger: null, last: null, crossCheck: null, day: null,
      display: '不可探测（数据源未接入）', reason: 'quotaGate 源未注入', asOf: nullAsOf(), authority: null },
  };
  items.tickdHealth = { level: null, available: false };
  const detail = '数据源未接入：六项指标全部不可探测（watch/board/autoActions/autonomy/assets/tasks/falsePositive/tickd/quotaGate 均未注入）';
  return {
    ok: false,
    available: false,
    version: METRICS_VERSION,
    reason: '数据源未接入：六项指标全部不可探测',
    items,
    // 精简档的整体 asOf（每项骨架里各带一份 null asOf）——**键形状与详细档不同**，
    //   调用方按 `metrics.slim === true` 判形态（详见 slim 标记）。
    slim: true,
    asOf: nullAsOf(),
    errors: [detail],
    note: '前端须显示"不可探测 + 原因"，不得按 0 渲染',
    counts: { available: 0, total: METRIC_KEYS.length, errors: 1 },
    computedAt: now,
  };
}

/**
 * 【片级裁剪档】`opts.profile === 'shard'` —— 只留**数字 / 状态 / 逐源 asOf / errors**，
 * 去掉一切"给前端做证据展开用的明细"（items 列表 / authority 说明 / crossCheck / disabled 明细 / blockers 文本）。
 *
 * 为什么必须有这一档：metrics 片预算 ≤2 KB（v1.1 B2，回归项 R2 的硬断言）。实测（2026-09-14）
 * **详细档 9,960 B** —— 明细本来就不该进这一片：明细的归属是 core 片的 `watch.unacked` / `board.review`。
 *
 * ⛔ 裁剪纪律：**任何计数、状态（available/value/count）、asOf、errors 一字不动**；
 *    只裁说明性文本与列表，且被裁字段的"缺失原因"（reason）一律保留（截断到 80 字）——
 *    绝不允许裁成"0 或空"这种假值。
 */
function buildShard(m) {
  const trim = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : (s ?? null));
  // 分项缺失原因的结构上限（返工修正 ①：原 40 字 × 最多 7 个分项，在真实数据下会顶破片预算）
  const reasonOf = (v) => (v && v.count === null ? { reason: trim(v.reason, 32) } : {});
  const i = m.items;

  const parts = {};
  for (const [k, v] of Object.entries(i.pendingTodo.parts ?? {})) {
    parts[k] = {
      available: v.available,
      count: v.count ?? null,
      ...(k === 'watchUnacked' ? { byLevel: v.byLevel ?? null, byLevelKnown: v.byLevelKnown ?? null, deduped: v.deduped ?? null } : {}),
      ...(k === 'boardReview' ? { judgement: v.judgement ?? null, rawReviewCount: v.rawReviewCount ?? null, aliveCount: v.aliveCount ?? null } : {}),
      ...(k === 'needConfirm' ? { deduped: v.deduped ?? null } : {}),
      ...reasonOf(v),
    };
  }

  const asParts = {};
  for (const [k, v] of Object.entries(i.assetAnomalies.parts ?? {})) {
    asParts[k] = {
      available: v.available,
      count: v.count ?? null,
      red: v.red ?? null,
      yellow: v.yellow ?? null,
      ...reasonOf(v),
    };
  }

  const gate3 = (g) => (g && typeof g === 'object' ? { rateOk: g.rateOk ?? null, sampleOk: g.sampleOk ?? null, suspectOk: g.suspectOk ?? null } : null);
  const gate2 = (g) => (g ? { available: g.available ?? null, pass: g.pass ?? null } : { available: false, pass: null });

  return {
    ok: m.ok,
    available: m.available,
    version: m.version,
    profile: 'shard',
    reason: trim(m.reason, 48),
    items: {
      pendingTodo: {
        available: i.pendingTodo.available, value: i.pendingTodo.value, knownSum: i.pendingTodo.knownSum,
        partial: i.pendingTodo.partial, unavailableParts: i.pendingTodo.unavailableParts, parts,
      },
      autonomy: {
        available: i.autonomy.available, l0Level: i.autonomy.l0Level,
        l0Reason: trim(i.autonomy.l0Reason, 20), l0Unavailable: trim(i.autonomy.l0Unavailable, 30),
        l2DisabledCount: i.autonomy.l2DisabledCount, l2TotalCount: i.autonomy.l2TotalCount,
        // 名单（disabledIds / expectedDisabled / **unexpectedDisabled**）**一律不进片**：
        //   B4#2 首屏只要"两个数 + 异常关闭"，完整名单在 full 档与日报摘要里（R5 同口径）。
        //   ⚠️ 只给计数、**绝不省略**——省略会被前端读成"没有异常关闭"的假值（V2-B 接线返工：
        //     名单是变长数组，是阶梯终止性论证里唯一漏掉的一项，实测使 2 档逼近 2 KB 硬线）。
        unexpectedDisabledCount: Array.isArray(i.autonomy.unexpectedDisabled) ? i.autonomy.unexpectedDisabled.length : null,
      },
      autoActionsToday: {
        available: i.autoActionsToday.available, hasData: i.autoActionsToday.hasData, date: i.autoActionsToday.date,
        noQuotaCount: i.autoActionsToday.noQuotaCount, quotaCount: i.autoActionsToday.quotaCount,
        byKind: i.autoActionsToday.byKind, byStatusToday: i.autoActionsToday.byStatusToday,
        // 【⑥-2】额度闸：片里只留**两个恒带数字 + 三个条件键**（display/authority/台账明细/分账一律归 full 档）。
        //   为什么这么抠（实测依据 2026-09-18）：生产真值下 metrics 片**基线**已是 1986 B / 2048 B（余量 62 B，落第 1 档），
        //   而第 2 档会连带裁掉 `watchUnacked.byLevel` —— 首屏 #1 卡「红黄 N 件」直接变成"分色不可得"。
        //   即：额度字段多占几十字节 = 拿**别的指标**的可见性做交换。故本字段只带：
        //     · `max`（前端要显示"3/5"，`used` 用既有 `quotaCount`，审核批注⑧要求复用）
        //     · `degradedToday`（**恒带**：0 / N / null 三态语义，缺省绝不表示"没有降级"）
        //     · `reached` 仅 true 时带；`available` 仅 false 时带（缺省视为可用）；`reason` 仅不可用时带。
        quotaGate: (() => {
          const g = i.autoActionsToday.quotaGate;
          if (!g) return null;
          return {
            max: g.max, degradedToday: g.degradedToday,
            ...(g.reached === true ? { reached: true } : {}),
            ...(g.available === false ? { available: false } : {}),
            ...(typeof g.reason === 'string' && g.reason ? { reason: trim(g.reason, 20) } : {}),
          };
        })(),
      },
      assetAnomalies: {
        available: i.assetAnomalies.available, value: i.assetAnomalies.value, red: i.assetAnomalies.red, yellow: i.assetAnomalies.yellow,
        partial: i.assetAnomalies.partial, unavailableParts: i.assetAnomalies.unavailableParts, parts: asParts,
      },
      inflight: {
        available: i.inflight.available, value: i.inflight.value, running: i.inflight.running, todo: i.inflight.todo,
        backlog: i.inflight.backlog ?? null, overdue: i.inflight.overdue ?? null,
      },
      falsePositive: {
        available: i.falsePositive.available,
        byMachine: i.falsePositive.byMachine ? {
          source: i.falsePositive.byMachine.source, day: i.falsePositive.byMachine.day,
          // 当日只留三个计数（rate 可由计数推、且当日 rate 在生产恒为 0）；累计值原样保留（口径一致）。
          today: (() => {
            const t = i.falsePositive.byMachine.today ?? {};
            return { total: t.total ?? null, marked: t.marked ?? null, suspect: t.suspect ?? null };
          })(),
          cumulative: i.falsePositive.byMachine.cumulative,
          gate: gate3(i.falsePositive.byMachine.gate),
        } : null,
        poolL1: gate2(i.falsePositive.poolL1),
        poolL2: gate2(i.falsePositive.poolL2),
        detailComplete: i.falsePositive.detailComplete,
        // 限定词只留**短码**（完整门槛文案在 full 档）：B4#6 要的是"带限定词"，不是把整句门槛塞进片
        gateLabelMachine: SHARD_GATE_LABEL_MACHINE,
      },
      tickdHealth: {
        level: i.tickdHealth.level, available: i.tickdHealth.available,
        // 【M5】会话异地镜像红标：**只在告警态带**（常态零字节代价 —— 生产真值下片余量仅 ~60 B；
        //   缺省语义 = "无镜像告警"，与 `quotaGate.reached` 同风格）。字段形态固定（短枚举 + 数字）
        //   ⇒ 不破坏阶梯终止性论证；片仍恒 ≤ 2048 B（由 `enforceShardBudget()` 保险丝兜底）。
        ...((i.tickdHealth.mirror?.lv === 'yellow' || i.tickdHealth.mirror?.lv === 'red')
          ? { mirror: { lv: i.tickdHealth.mirror.lv, n: Number(i.tickdHealth.mirror.n ?? 0) } } : {}),
      },
    },
    // 【片级 asOf】R3 要的"逐片 asOf"：取本片各源里**最旧**的时刻 + 来源类型集合
    //   （full 档才有逐源 asOf —— 逐源那一份会把片撑爆，明细/说明一律归 full 档）。
    asOf: (() => {
      const vals = Object.values(m.asOf ?? {}).filter((v) => v && typeof v === 'object' && Number.isFinite(Number(v.at)));
      return {
        at: vals.length ? Math.min(...vals.map((v) => Number(v.at))) : null,
        sources: [...new Set(vals.map((v) => v.source).filter(Boolean))].sort(),
      };
    })(),
    errors: (m.errors ?? []).slice(0, 2).map((e) => trim(e, 48)),
    counts: m.counts,
    textIn: 'full',   // 说明文案（display / verdict / authority）在 full 档，避免把同一句话发两遍
    computedAt: m.computedAt,
  };
}

// ---------------------------------------------------------------------------
// 【预算保险丝】返工修正 ① —— shard 档 ≤ 2 KB 由「阶梯终止性」保证，不靠"当天样本恰好够小"
// ---------------------------------------------------------------------------

/** 定点收紧文本（**不动任何计数 / 状态 / 折叠映射**）。 */
function clipShardTexts(shard, cfg) {
  const clip = (s, n) => {
    if (s === null || s === undefined) return null;
    if (!n) return null;
    const str = String(s);
    return str.length > n ? str.slice(0, n) + '…' : str;
  };
  const s = JSON.parse(JSON.stringify(shard));
  s.reason = clip(s.reason, cfg.reason);
  s.errors = (s.errors ?? []).slice(0, cfg.errMax).map((e) => clip(e, cfg.errText)).filter((e) => e !== null);
  const partReason = (obj) => {
    if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, 'reason')) return;
    if (cfg.partReason) { obj.reason = clip(obj.reason, cfg.partReason); return; }
    // 文本被裁：删掉 reason 键 + **显式标记**（绝不伪装成"本就没有缺失原因"）
    delete obj.reason;
    obj.reasonTrimmed = true;
  };
  for (const k of Object.keys(s.items?.pendingTodo?.parts ?? {})) partReason(s.items.pendingTodo.parts[k]);
  for (const k of Object.keys(s.items?.assetAnomalies?.parts ?? {})) partReason(s.items.assetAnomalies.parts[k]);
  if (!cfg.l0Text) {
    if (s.items?.autonomy) { delete s.items.autonomy.l0Reason; delete s.items.autonomy.l0Unavailable; }
  }
  return s;
}

/** 折叠映射（**键数随数据量增长**的那部分）不进片；`byLevelKnown` 是状态位、保留。 */
function dropShardMaps(shard) {
  const s = JSON.parse(JSON.stringify(shard));
  if (s.items?.autoActionsToday) {
    delete s.items.autoActionsToday.byKind;
    delete s.items.autoActionsToday.byStatusToday;
    // 【⑥-2】`byKindQuota` 与老 `byKind` 同族（键数 = 动作种类数）⇒ 同一条纪律；且**默认就不进片**
    //   （见 buildShard 注释：片预算已近饱和）。此处仍删一次，防将来有人把它加回片里。
    if (s.items.autoActionsToday.quotaGate) delete s.items.autoActionsToday.quotaGate.byKindQuota;
  }
  if (s.items?.pendingTodo?.parts?.watchUnacked) delete s.items.pendingTodo.parts.watchUnacked.byLevel;
  // 【V2-B 接线返工 · 真实缺陷】`autonomy.unexpectedDisabled` 是"异常关闭模块 id 名单"——
  //   **变长数组**，是原阶梯终止性论证（"只剩固定键名 + 数字/短枚举"）里唯一漏掉的一项：
  //   2026-09-14 接线后实测（沙箱夹具 4 个 id）使 trimLevel=2 档仍达 1843 B，
  //   逼近 2048 B 硬线；模块异常数再多就会破线（V2-B 卡实测暴露，非 A1/A2 测试所能覆盖）。
  //   处置：2/3 档裁**列表**、**保留计数**（计数是状态，裁掉就变成"没有异常关闭"的假值）。
  if (s.items?.autonomy && Array.isArray(s.items.autonomy.unexpectedDisabled)) {
    s.items.autonomy.unexpectedDisabledCount = s.items.autonomy.unexpectedDisabled.length;
    delete s.items.autonomy.unexpectedDisabled;
  }
  return s;
}

/**
 * 片级硬上限：逐档试，**第一个 ≤ `SHARD_BUDGET_BYTES` 的档胜出**，并如实带上 `trimLevel`。
 *
 * 终止性论证（这是"数据量无关"的根据，不是"实测够小"）：第 3 档已无任何随数据量增长的成分
 *   —— 全部字段都是固定键名 + 数字/短枚举（`asOf.sources` 是有限枚举集合、`unavailableParts`
 *   是固定分项名），故其尺寸有与输入无关的上界（实测 ~1.5 KB < 2 KB）⇒ 循坏必然在某一档返回。
 * 降级只碰**文本与折叠映射**：available / value / count / 状态 / 片级 asOf 一字不动（R5 比对仍成立）。
 */
function enforceShardBudget(shard) {
  const withLevel = (o, lv) => ({ ...o, trimLevel: lv });
  const tryLevel = (obj, lv) => {
    const cand = withLevel(obj, lv);
    return shardBytes(cand) <= SHARD_BUDGET_BYTES ? cand : null;
  };
  const l0 = tryLevel(shard, 0);
  if (l0) return l0;
  const l1 = tryLevel(clipShardTexts(shard, { reason: 24, errMax: 1, errText: 32, partReason: 16, l0Text: false }), 1);
  if (l1) return l1;
  const noMaps = dropShardMaps(shard);
  const l2 = tryLevel(clipShardTexts(noMaps, { reason: 16, errMax: 1, errText: 24, partReason: 0, l0Text: false }), 2);
  if (l2) return l2;
  return withLevel(clipShardTexts(noMaps, { reason: 0, errMax: 0, errText: 0, partReason: 0, l0Text: false }), 3);
}

/** 对外入口（保持 A1 冻结的调用形状）：构造 → 预算保险丝。 */
function toShard(m) {
  return enforceShardBudget(buildShard(m));
}

/** 源归一化：`input.sources` 优先，其次把入参本身当源容器（兼容扁平调用）。 */
function normalizeSources(input) {
  const roots = [];
  if (input && typeof input === 'object') {
    if (input.sources && typeof input.sources === 'object') roots.push(input.sources);
    roots.push(input);
  }
  const get = (k) => {
    for (const r of roots) {
      if (r && Object.prototype.hasOwnProperty.call(r, k) && r[k] !== undefined) return r[k];
    }
    return null;
  };
  return {
    watch: get('watch'),
    board: get('board'),
    autoActions: get('autoActions'),
    autonomy: get('autonomy'),
    assets: get('assets'),
    tasks: get('tasks'),
    falsePositive: get('falsePositive'),
    tickd: get('tickd'),
    quotaGate: get('quotaGate'),   // 【⑥-2】额度闸（护栏限额 + 降级台账 + checkDailyLimit 同源输出）
  };
}

export default collectMetrics;
