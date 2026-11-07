/**
 * 日报 · 第二柱（远端盘阈值 + 告警）摘要行 —— **D3**（`方案-跨机骨架三柱与统一开关-20261010-v2.md` §6.5-D3）
 *
 * 为什么存在：D3 拍板 = 「第二柱告警**接进日报**，但**只加一行摘要**」。理由（实测）：不接 ⇒ 第二柱告警的
 *   人类可见面只剩"周报 md"（要人主动翻）≈ **0 可见面**；接 ⇒ 抬头就能看见一行。
 *
 * 口径与约束：
 *   · **只读**：读 `<home>/butler-session-mirror.json`（唯一真源），不 ssh、不写盘、不调 alert()。
 *   · **不复制判定**：level 由镜像脚本按 `tools/dsh-butler/lib/remote-space.mjs` 的 `levelOf()` 落进状态文件，
 *     本模块**只渲染**它落下的值（阈值也原样读状态文件里的 `warnFreeBytes` / `alertFreeBytes`）。
 *   · **fail-loud**：读不到 / 解析失败 / 无字段 ⇒ 显式成行打 `❔ 不可探测（原因）`，**绝不静默变绿**。
 *   · **单写口**（v2 §4.5）：本模块**不写**状态文件；`remoteSpace` 与 `#lastAudit` 均由镜像推送 job 单方落盘。
 *   · 状态文件里**同时**有顶层 `remoteSpace` 与 `lastAudit.remoteSpace`（两处都是推送 job 落的）⇒ 取
 *     `checkedAt` **更新**的那一处（相同则优先顶层），避免"读了旧的那份"。
 *   · 文件系统：**缺省用 `node:fs`**（生产调用不必注入）；单测可传 `fsMod` 白盒替换。
 */
import nodeFs from 'node:fs';
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 `<home>/butler-session-mirror.json` 逐字节相同）。
import { statePathResolver, dshHome as stateDshHome } from './butler-root.mjs';
const resolveStatePath = await statePathResolver();

/** 状态文件绝对路径（接统一状态入口；缺省 home 与 state-paths 同源）。 */
export const mirrorStatePathOf = (home = stateDshHome()) => resolveStatePath('butler-session-mirror.json', { home }).path;
/** 状态文件名（与镜像脚本同口径；真源 `tools/dsh-session-mirror.mjs`）。 */
export const MIRROR_STATE_NAME = 'butler-session-mirror.json';

/** 读数"陈旧"阈值（小时）。超此值 ⇒ 行尾标 ⚠️ 陈旧 —— 镜像断线时"读数还在、其实是旧的"，必须看得见。 */
export const STALE_HOURS = 26;

/** 四态 → 图标（与日报既有口径一致：✓/⚠️/🔴/❔）。 */
export const LEVEL_ICON = Object.freeze({ ok: '✅', warn: '⚠️', alert: '🔴', unknown: '❔' });

/** 告警文案截断长度（摘要行只留一行，别被长 message 撑爆）。 */
export const ALERT_TEXT_CAP = 60;

export function levelIcon(level) {
  return LEVEL_ICON[String(level ?? '')] ?? '❔';
}

/** GiB 渲染（1 位小数；非有限值 ⇒ `null`）。与 `remote-space.mjs#fmtGiB` 同口径。 */
export function fmtGiB(bytes) {
  return Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) : null;
}

/** 本地时间 `MM-DD HH:mm`（不依赖 locale / 不引第三方）。 */
export function fmtLocal(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 从状态文件读 `remoteSpace` 现值 + `alerts[]`（**纯读，绝不写**）。
 * @param {string} statePath 状态文件绝对路径
 * @returns {{ok:true, remoteSpace:object|null, alerts:Array<object>, asOfMs:number|null, source:string}
 *          | {ok:false, reason:string}}
 */
export function readMirrorSpace(statePath, fsMod) {
  const fs = fsMod ?? nodeFs;             // 生产路径不必注入；注入只为单测白盒
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (e) {
    return { ok: false, reason: '状态文件不可读（' + String(e?.code ?? e?.message ?? e) + '）' };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '状态文件解析失败（非法 JSON）' };
  }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: '状态文件形状异常（非对象）' };

  const top = obj.remoteSpace && typeof obj.remoteSpace === 'object' ? obj.remoteSpace : null;
  const inAudit = obj.lastAudit && typeof obj.lastAudit === 'object' && obj.lastAudit.remoteSpace
    && typeof obj.lastAudit.remoteSpace === 'object' ? obj.lastAudit.remoteSpace : null;
  const atOf = (rs) => (rs && typeof rs.checkedAt === 'string' && Number.isFinite(Date.parse(rs.checkedAt))
    ? Date.parse(rs.checkedAt) : null);

  let remoteSpace = null;
  let source = 'none';
  if (top && inAudit) {
    const a = atOf(top); const b = atOf(inAudit);
    if (b !== null && (a === null || b > a)) { remoteSpace = inAudit; source = 'lastAudit'; }
    else { remoteSpace = top; source = 'top'; }
  } else if (top) { remoteSpace = top; source = 'top'; }
  else if (inAudit) { remoteSpace = inAudit; source = 'lastAudit'; }

  if (!remoteSpace) return { ok: false, reason: '状态文件里没有 remoteSpace 字段' };

  const alerts = obj.lastAudit && Array.isArray(obj.lastAudit.alerts) ? obj.lastAudit.alerts : [];
  return { ok: true, remoteSpace, alerts, asOfMs: atOf(remoteSpace), source };
}

/**
 * 渲染**一行**摘要（D3 全部人类可见面）。
 * @param {object} o
 * @param {string} o.statePath  状态文件绝对路径
 * @param {object} [o.fsMod]    `node:fs`（注入以便单测白盒）
 * @param {number} [o.now]      当前时间（ms；单测注入）
 * @param {number} [o.staleHours] 陈旧阈值（小时；缺省 {@link STALE_HOURS}）
 * @returns {string} 一行 markdown（**永不抛错**；失败降级成"不可探测"行）
 */
export function mirrorSpaceLine(o = {}) {
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleHours = Number.isFinite(o.staleHours) ? o.staleHours : STALE_HOURS;
  const read = readMirrorSpace(String(o.statePath ?? ''), o.fsMod);
  if (!read.ok) return `- 🛰 远端盘（第二柱）：❔ 不可探测（${read.reason}）`;

  const rs = read.remoteSpace;
  const level = String(rs.level ?? 'unknown');
  const icon = levelIcon(level);
  const vol = typeof rs.volume === 'string' && rs.volume ? rs.volume : '?';
  const freeG = fmtGiB(rs.freeBytes);
  const warnG = fmtGiB(rs.warnFreeBytes);
  const alertG = fmtGiB(rs.alertFreeBytes);

  const bits = [];
  if (level === 'unknown') {
    const streak = Number.isFinite(rs.unknownStreak) ? Math.floor(rs.unknownStreak) : 0;
    bits.push('读数未知' + (streak > 0 ? `（连续 ${streak} 次取不到）` : ''));
  } else {
    bits.push(`**${freeG ?? '?'}** GiB 可用`);
  }
  if (warnG !== null || alertG !== null) {
    bits.push(`阈值 warn ${warnG ?? '?'} / alert ${alertG ?? '?'} GiB`);
  }
  const alerts = read.alerts ?? [];
  const alertBit = alerts.length
    ? `告警 **${alerts.length}** 条（最近：${String(alerts[alerts.length - 1]?.message ?? '').slice(0, ALERT_TEXT_CAP)}）`
    : '告警 **0** 条';
  bits.push(alertBit);

  const atLocal = fmtLocal(read.asOfMs);
  if (atLocal) {
    const ageH = read.asOfMs !== null ? (now - read.asOfMs) / 3600e3 : null;
    const stale = ageH !== null && ageH >= staleHours;
    bits.push(`核对于 ${atLocal}${stale ? ` ⚠️ 读数陈旧 ${Math.floor(ageH)}h` : ''}`);
  }
  if (rs.enabled === false) bits.push('已关回');

  return `- 🛰 远端盘（第二柱 · ${vol}）：${icon} ${bits.join(' · ')}`;
}
