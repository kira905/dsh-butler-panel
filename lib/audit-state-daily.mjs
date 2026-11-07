// dsh-butler-panel / lib/audit-state-daily.mjs —— 日报「审计状态」**一行**的渲染层（R-071① · 2026-10-20）
//
// 由来：2026-10-19 23:48 本机 ~/.dsh 与 D:\DSH 遭大规模误删（4000+ 件）。
//   R-071 = 误删三道防线（① 进程审计 ② 定时快照 + 异地镜像 ③ 大量消失告警），本件只管第 ① 件。
//   事故档：`<workspace>/docs/事故-20261020-DSH数据被清-自查与补齐.md`
//
// 分工（**判定与渲染分离，口径只此一处**）：
//   · 判定唯一入口 = `tools\dsh-butler\audit-state-check.mjs` 的 `checkAuditState()`（本文件不复制任何判据）
//   · 渲染唯一入口 = 本文件（日报 report.mjs 只 push 它给的那一行）
//   · 开关（L2 模块） = `~/.dsh/butler-autonomy.json` 的 `modules['audit-state']`
//     登记表 = `tools\dsh-butler\lib\autonomy-modules.mjs#MODULE_IDS`；默认 **on**（infra + failSafe:baseline）
//     变更走 `butler-autonomy-cli.mjs module on|off audit-state`（**别手改 JSON**）；off ⇒ 该行不出现（不是空行）
//
// 【红线】
//   · 纯只读：本文件不写任何文件、不改审计策略、不重启任何东西（子命令也只有 reg query / auditpol / wevtutil qe）
//   · 非管理员 ⇒ 判定一律 unknown（reason 写 needs-admin）—— **绝不误报 off**（假警报比没警报更坏）
//   · fail-open：取数/渲染失败**只**降级成一行 unknown，绝不抛给日报调用方、绝不拖垮其余段

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceRoot } from './butler-root.mjs';

export const AUDIT_MODULE_ID = 'audit-state';
/** 工具根（夹具可注入；与 rulecheck-daily.mjs 同款口径） */
const DEFAULT_TOOL_ROOT = workspaceRoot();

function resolveHome(opts = {}) {
  return opts.home
    || process.env.BUTLER_DSH_HOME
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

function resolveToolRoot(opts = {}) {
  return opts.toolRoot || process.env.BUTLER_TOOLS_ROOT || process.env.DSH_WORKSPACE || DEFAULT_TOOL_ROOT;
}

/** 读模块开关（登记表缺失 / 未登记 ⇒ 判关；读不到配置时 infra 走 baseline=开）。 */
export async function readAuditStateGate(opts = {}) {
  const toolRoot = resolveToolRoot(opts);
  const home = resolveHome(opts);
  const modFile = path.join(toolRoot, 'tools', 'dsh-butler', 'lib', 'autonomy-modules.mjs');
  const mod = await import(pathToFileURL(modFile).href);
  const r = mod.isModuleEnabled(AUDIT_MODULE_ID, { home });
  return { enabled: r.enabled === true, known: r.known, source: r.source, reason: r.reason, label: r.label };
}

/** 现跑自检器（只读）。异常不吞：交给 auditStateDailyLine 统一降级成一行 unknown。 */
export async function collectAuditState(opts = {}) {
  const toolRoot = resolveToolRoot(opts);
  const checkFile = path.join(toolRoot, 'tools', 'dsh-butler', 'audit-state-check.mjs');
  const mod = await import(pathToFileURL(checkFile).href);
  if (typeof mod.checkAuditState !== 'function') throw new Error('audit-state-check.mjs 没有导出 checkAuditState');
  return mod.checkAuditState();
}

/**
 * 渲染那一行（**始终只有一行**，理由与旁证都塞在括号里）。
 * 图标口径跟 report.mjs 的 ICON 一致：✅ green / ⚠️ yellow / 🔴 red。
 */
export function renderAuditStateLine(st) {
  if (!st || typeof st !== 'object') return '- ❔ 审计：unknown（自检器没有返回结论）';
  const icon = st.ok === 'ok' ? '✅' : st.ok === 'off' ? '🔴' : '⚠️';
  const verdict = st.ok === 'ok' ? 'ok' : st.ok === 'off' ? 'off' : 'unknown';
  const parts = [st.reason || '无原因'];
  // 管理员现跑取证（audit-verify.cmd 的产物）——只作旁证，**不改变 ok/off/unknown 判定**
  const ev = st.evidence;
  if (ev?.present && ev.verdict) {
    const age = typeof ev.ageHours === 'number' ? `${ev.ageHours} h 前` : '时间未知';
    const stale = typeof ev.ageHours === 'number' && ev.ageHours > 24 ? '· 已超 24h 建议重跑' : '';
    parts.push(`最近管理员取证 ${ev.verdict}（MARKER_FOUND=${ev.markerFound ?? '?'} · ${age}${stale}）`);
  } else if (st.ok === 'unknown') {
    parts.push('尚无管理员取证：主人右键 `桌面\\DSH鲸落地\\audit-verify.cmd` 跑一次即可');
  }
  return `- ${icon} 审计：${verdict}（${parts.join('｜')}）`;
}

/**
 * 日报唯一入口：先判开关，再取数，再渲染。
 * @returns {Promise<{line:string|null, reason?:string, state?:object, gate?:object}>}
 */
export async function auditStateDailyLine(opts = {}) {
  let gate = null;
  try {
    gate = await readAuditStateGate(opts);
    if (!gate.enabled) return { line: null, reason: `开关关（${AUDIT_MODULE_ID} · ${gate.reason}）`, gate };
    const state = await collectAuditState(opts);
    return { line: renderAuditStateLine(state), state, gate };
  } catch (e) {
    // fail-open：绝不抛给日报；但也不静默 —— 渲染成一行诚实的 unknown（「不知道」不等于「没事」）
    const why = String(e?.message ?? e).slice(0, 120);
    return {
      line: `- ⚠️ 审计：unknown（自检器不可用：${why}）`,
      reason: `判定不可用（fail-open）：${why}`,
      gate,
    };
  }
}
