// ============================================================================
//  dsh-butler-panel / lib/urgent-quota.js
//  【G33·加急档 · A4 可见性 · 2026-09-29 · 本机】
//
//  为什么有这个文件（自包含背景）：
//    · 加急档 A4 已放行 —— `~/.dsh/butler-restart-policy.json` = `{"urgentEscalateMs":1200000}`
//      （排队 20 分钟自动升档，2026-09-28 生效）。
//    · A4 **前置**卡（2026-09-28，done）交付的是复审 R-4 要求的「计数器 + 闸门 + 可见性」三件，
//      其中前两件已落地（`lib\restart.mjs#resolveUrgentDailyQuota` / `#gateUrgentEscalation`
//      ＋ `restart-coordinator.mjs#readUrgentDaily`/`#bumpUrgentDaily`），**可见性只做了
//      state 段 / CLI 打印 / tick 决策日志三处，面板 GUI 从未渲染过**（该卡登记的待拍 P1）。
//    · 窗口批清单 `docs\窗口批-面板待部署清单-20260929.md` §5-W4 明确点名这个缺口 ⇒ 本模块是它的落点。
//
//  数据源（唯一）：`~/.dsh/butler-restart-state.json` **顶层 `urgent` 段**，
//    字段 `{day, escalated, explicit, denied, limit, lastAt, lastKind}`（写入侧 = `bumpUrgentDaily`）。
//    ⚠️ **该段不存在是常态**：一次自动升档都没发生过时协调器根本不写这一键
//       （生产实测：顶层只有 schemaVersion/heartbeat/queue/pendingNotify/lastBatch/counters/reminded）
//       ⇒ 空态必须被当成"正常"，绝不能渲染成错误、更不许出现 `?` / `undefined` / `NaN`。
//
//  四条硬约束（本文件存在的全部意义）：
//    ① **路径解析走唯一源** `tools\lib\dsh-home.mjs#resolveDshHome`
//       （BUTLER_DSH_HOME > DSH_HOME > ~/.dsh；本仓已统一去 `os.homedir()` 硬编码，不在这里另造一份）。
//    ② **上限与"是否已达上限"交给判据层纯函数** `lib\restart.mjs#resolveUrgentDailyQuota`
//       —— 默认值回落（5）也在那一处 ⇒ 本文件**不抄 5 这个数字**，改口径只需改一处。
//    ③ **日切同源**：`lib\restart.mjs#localDayKey`（本地时区 YYYY-MM-DD）。跨日 ⇒ 当日计数归零
//       （与协调器"读时归零、写时开新一天，无清零任务"完全同口径）。
//    ④ **fail-open**：文件缺失 / JSON 坏 / 段不存在 / 策略读不出 ⇒ **一律不抛错**，
//       返回可渲染的降级文案。额度读不出来只影响这一行，绝不让整个面板 state 挂掉。
//
//  ⚠️ 本模块**零写操作**：不建目录、不写任何文件、不动开关、不 import 任何执行类组件。
//  ⚠️ 跨包引用走 `./butler-root.mjs` 解析（目录由环境变量决定，源码里不留本机绝对目录）；
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';

import { importButlerLib, importToolLib } from './butler-root.mjs';
const { resolveDshHome } = await importToolLib('dsh-home.mjs');
const { localDayKey, loadRestartPolicy, resolveUrgentDailyQuota } = await importButlerLib('restart.mjs');
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 path.join(home, name) 逐字节相同）。
const { resolveStatePath } = await importButlerLib('state-paths.mjs');

/** 本视图的口径版本（改文案/字段时同步 bump，便于报告追溯；不参与任何判定）。 */
export const URGENT_QUOTA_VERSION = '0.1.0';

/** 计数器落点绝对路径（接统一状态入口；文件名常量与协调器同源）。 */
const restartStatePathOf = (home) => resolveStatePath(RESTART_STATE_FILE_NAME, { home }).path;
/** 计数器落点文件名（`<home>\butler-restart-state.json`，与协调器同源，不另起新根）。 */
export const RESTART_STATE_FILE_NAME = 'butler-restart-state.json';

/** `lastKind` → 人话（取值域 = 协调器 `bumpUrgentDaily` 的 kind 白名单）。 */
export const URGENT_KIND_LABELS = Object.freeze({
  escalated: '自动升档',
  explicit: '人显式加急',
  denied: '被上限挡下',
});

/** 本地时间 `HH:MM`（展示用；日切判定一律走 localDayKey，别用这个）。 */
export function formatHm(ts) {
  // ⚠️ 先挡 null/undefined/空串：`Number(null) === 0` 且 `Number('') === 0` 都是**有限数**，
  //    漏挡会把"没有最近一次"渲染成 08:00（UTC+8 的 epoch）—— 单测 §2/§4 实测抓到的假值。
  if (ts === null || ts === undefined || ts === '') return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 严格读 `butler-restart-state.json`（**不吞错误**，把"为什么读不到"带出来）。
 *
 * 【为什么不复用 `lib\state.js#readJsonFile`】那个 helper 把"文件不存在 / JSON 坏 / 空文件"
 *   一律吞成同一个 `fallback`（null）⇒ 面板只能显示"额度不可读"而说不出原因，
 *   也无法把"空态是常态"与"真读不出来"分开。本函数把三态分开成 `kind`。
 *
 * @param {string} file 状态文件绝对路径
 * @returns {{kind:'ok'|'absent'|'unreadable', state:object|null, reason:string|null, file:string}}
 *   · `ok` = 读到了且顶层是对象；`absent` = 文件不存在（协调器尚未跑过，**正常态**）；
 *   · `unreadable` = 空文件 / JSON 坏 / 顶层不是对象 / 读权限失败（**才**是异常）。
 */
export function readRestartStateRaw(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { kind: 'absent', state: null, reason: '状态文件尚未生成（协调器还没跑过）', file };
    }
    return { kind: 'unreadable', state: null, reason: `状态文件读不出来（${e?.code ?? e?.message ?? e}）`, file };
  }
  if (!text.trim()) return { kind: 'unreadable', state: null, reason: '状态文件为空（0 字节）', file };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { kind: 'unreadable', state: null, reason: `状态文件解析失败（${e?.message ?? e}）`, file };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', state: null, reason: `状态文件顶层必须是对象（实得 ${Array.isArray(parsed) ? 'array' : typeof parsed}）`, file };
  }
  return { kind: 'ok', state: parsed, reason: null, file };
}

/**
 * 归纳「加急档当日额度」视图（**纯函数** · 单测主入口）。
 *
 * @param {{raw?:object, policyResult?:object|null, now?:number, file?:string}} [input]
 *   · `raw` = `readRestartStateRaw()` 的返回值（缺省 = 空态）；
 *   · `policyResult` = `loadRestartPolicy()` 的返回值（缺省 ⇒ 由 `resolveUrgentDailyQuota`
 *     内部回落 `DEFAULT_POLICY`，**默认值仍只有一处**）；
 *   · `now` = 注入时钟（跨日用例唯一入口；缺省 = 当前时刻）。
 * @returns {{ok:boolean, state:'ok'|'empty'|'unreadable', day:string, counterDay:string|null,
 *            used:number, escalated:number, explicit:number, denied:number,
 *            limit:number, reached:boolean, lastAt:number|null, lastKind:string|null, lastText:string|null,
 *            policySource:string|null, file:string|null, reason:string|null, display:string}}
 *
 * 【display 三态（前端**直接用**，不重算、不补字）】
 *   · 空态（段不存在 / 文件尚未生成）→ `尚未发生自动升档（当日 0/<limit>）[ · 状态文件尚未生成]`
 *   · 有数据 → `自动升档已用 N/<limit> · 人显式 X 次 · 被上限挡下 Y 次（最近一次 HH:MM · 类型）[ · 已达上限…]`
 *   · 不可读 → `额度不可读（<原因摘要>）`
 */
export function summarizeUrgentQuota(input = {}) {
  const nowRaw = Number(input.now);
  const now = Number.isFinite(nowRaw) ? nowRaw : Date.now();
  const today = localDayKey(now);
  const raw = (input.raw && typeof input.raw === 'object')
    ? input.raw
    : { kind: 'absent', state: null, reason: null, file: null };
  const file = input.file ?? raw.file ?? null;
  const policyResult = (input.policyResult && typeof input.policyResult === 'object') ? input.policyResult : null;
  // 策略对象缺省 = `{}` ⇒ `resolveUrgentDailyQuota` 内部以 DEFAULT_POLICY 打底（上限默认值单一真源）
  const policy = (policyResult?.policy && typeof policyResult.policy === 'object') ? policyResult.policy : {};

  const base = {
    ok: false, state: 'unreadable', day: today, counterDay: null,
    used: 0, escalated: 0, explicit: 0, denied: 0,
    limit: null, reached: false,
    lastAt: null, lastKind: null, lastText: null,
    policySource: policyResult?.source ?? null,
    file, reason: null, display: '',
  };

  // ① 不可读态：只有"真读不出来"才走这里（文件不存在 ≠ 不可读，见 ②）
  if (raw.kind === 'unreadable') {
    const reason = raw.reason || '状态文件不可读';
    return { ...base, ok: false, state: 'unreadable', reason, display: `额度不可读（${reason}）` };
  }

  const stateObj = (raw.kind === 'ok' && raw.state && typeof raw.state === 'object') ? raw.state : null;
  const seg = (stateObj && typeof stateObj.urgent === 'object' && stateObj.urgent !== null) ? stateObj.urgent : null;
  const segDay = (typeof seg?.day === 'string' && seg.day) ? seg.day : null;
  const sameDay = segDay !== null && segDay === today;

  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);
  // 跨日归零（与协调器 readUrgentDaily 同口径：不做清零任务，读时视为 0）
  const used = sameDay ? n(seg?.escalated) : 0;
  const explicit = sameDay ? n(seg?.explicit) : 0;
  const denied = sameDay ? n(seg?.denied) : 0;
  const lastAtRaw = sameDay ? Number(seg?.lastAt) : NaN;
  const lastAt = Number.isFinite(lastAtRaw) ? lastAtRaw : null;
  const lastKind = (sameDay && typeof seg?.lastKind === 'string' && seg.lastKind) ? seg.lastKind : null;

  // 上限 + 闸门结论 = 判据层纯函数（本文件不抄默认值、不自算 reached）
  const quota = resolveUrgentDailyQuota({
    policy,
    urgentDaily: { ok: true, day: today, used, escalated: used, explicit, denied },
  });
  const limit = quota.limit;
  const anyToday = used > 0 || explicit > 0 || denied > 0;

  let display;
  if (!anyToday) {
    display = `尚未发生自动升档（当日 0/${limit}）`
      + (limit === 0 ? '（上限 0 = 显式全禁）' : '')
      + (raw.kind === 'absent' ? ' · 状态文件尚未生成' : '');
  } else {
    display = `自动升档已用 ${used}/${limit} · 人显式 ${explicit} 次 · 被上限挡下 ${denied} 次`;
    const kindLabel = lastKind ? (URGENT_KIND_LABELS[lastKind] ?? lastKind) : null;
    const hm = formatHm(lastAt);
    if (hm) display += `（最近一次 ${hm}${kindLabel ? ' · ' + kindLabel : ''}）`;
    else if (kindLabel) display += `（最近一次类型 ${kindLabel}）`;
    if (quota.reached) display += ' · 已达上限（今日不再自动升档）';
  }

  return {
    ...base,
    ok: true,
    state: seg ? 'ok' : 'empty',
    counterDay: segDay,
    used, escalated: used, explicit, denied,
    limit, reached: quota.reached === true,
    lastAt, lastKind, lastText: formatHm(lastAt),
    reason: null,
    display,
  };
}

/**
 * 生产入口（IO 组合）：解析路径 → 严格读状态 → 读生效策略 → 归纳。**永不抛错**。
 *
 * @param {{home?:string, now?:number, stateFile?:string, policyFile?:string}} [opts]
 *   · `home` 缺省 = `resolveDshHome()`（唯一源）；`stateFile`/`policyFile` 仅单测注入用。
 */
export function collectUrgentQuota(opts = {}) {
  const home = opts.home ?? resolveDshHome();
  const nowRaw = Number(opts.now);
  const now = Number.isFinite(nowRaw) ? nowRaw : Date.now();
  const file = opts.stateFile ?? restartStatePathOf(home);

  let raw;
  try {
    raw = readRestartStateRaw(file);
  } catch (e) {
    // 兜底：readRestartStateRaw 自身已不抛错，这里防"未来改动引入的抛错"影响面板整体
    raw = { kind: 'unreadable', state: null, reason: `读取异常（${e?.message ?? e}）`, file };
  }

  let policyResult = null;
  try {
    policyResult = loadRestartPolicy({ home, file: opts.policyFile ?? null });
  } catch (e) {
    // 策略读不出来**不挡**额度行：resolveUrgentDailyQuota 会回落 DEFAULT_POLICY（上限仍是权威默认值）
    policyResult = null;
  }

  return summarizeUrgentQuota({ raw, policyResult, now, file });
}
