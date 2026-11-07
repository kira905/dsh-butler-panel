// dsh-butler-panel / lib/audit-guard.js —— P5 写入守门人（host 侧）
//
// 方案：docs\大管家v2方案-从只读到真管家-20260909.md §4 P5（行 775-855）
// 主人 2026-09-09 拍板：双层 + 抗升级措施。
//
// ① A 层 fs 门（fs/write-intent + fs/edit-intent，**prepend** 注册）
//    —— 方案甲凭证模式：无凭证 → 抛 AUDIT_NOT_PASSED；有凭证 → 放行并消耗（一次性）。
//    ⚠️ spike 实证：fs/* 是单槽 waterfall，普通 ctx.on 注册**完全收不到事件**（被官方
//       dsh-fs-observation-policy veto）→ 必须 { prepend: true }，且必须调 next() 保留官方语义。
// ② A+ 层 tools/pre-execute 门（prepend 注册，官方 dsh-tool-jobs 同款姿势）
//    —— 拿得到 write/edit 的**待写入内容** → hash 与凭证比对 → 真内容级写前拦截。
// ③ B 层写前备份 + 写后 1s 审计 + 违规回滚（docs / 保护区）。
// ④ 逃生舱：暂停开关（~/.dsh/butler-audit-off.json）+ 单次 force（仅主会话 / 面板）。
//
// 通道限制（方案 v2.4 阻断级结论，必须接受）：fs/* 与 tools/* 门只覆盖 DSH 的 write / edit 工具；
//   pwsh + node writeFileSync 完全绕过 → P5 = 防手滑 + 事后审计，**不宣称防绕过**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { importButlerLib, importToolLib } from './butler-root.mjs';
const {
  AuditTokenStore, readAuditOff, writeAuditOff, judgeForce, CODES, blockMessage,
} = await importButlerLib('audit-token.mjs');
const { decideFsIntent, decideToolCall, resolveAuditTarget } = await importButlerLib('audit-guard.mjs');
const { normalizePath } = await importButlerLib('protected-paths.mjs');
const { appendAudit } = await importButlerLib('audit.mjs');
const { alert } = await importButlerLib('alert.mjs');
// 【R-065 三件套 · 锁6-E1（2026-10-19）】删除 / 搬移唯一口：dry-run 第一道门 + reparse 拒删 + 白名单拒跑。
//   共享闸 = 动态 import（可选依赖）：本文件在 tools 目录损坏时也要能跑；加载失败 ⇒ 拒动作（fail-closed），绝不裸删。
//   ⚠️ 2026-10-19（卡 d37c1aec · S4 前置）：原为相对路径 `../../lib/production-guard.mjs` —— 仓库里解析
//     到 tools\lib\ 恰好对，但部署到 profile 后解析成 node_modules\lib（不存在）⇒ 部署门禁①拒部署；
//     即便绕过也会静默 catch(null) 让 P5 守门人全部动作拒跑。改为与同文件其它跨包 import 同形的 file:/// 绝对 URL。
const PG_DESTRUCTIVE = await importToolLib('production-guard.mjs').catch(() => null);
function guardedDestructive({ targets, whitelist, op = '删', reason, dryRun = false, action }) {
  const list = targets.map((t) => (typeof t === 'string' ? { path: t, label: reason } : t));
  if (dryRun === true) { try { console.log('[plan] ' + op + ' ' + list.map((t) => t.path).join(' ; ')); } catch {} return false; }
  if (!PG_DESTRUCTIVE) throw new Error('R-065 闸不可用（production-guard.mjs 加载失败）⇒ 拒绝' + op);
  const g = PG_DESTRUCTIVE.gateDestructive({
    targets: list, whitelist, op, scope: ['file'], requires: ['file'], dryRun: false,
    allowProduction: true, allowReparse: false, ledgerBypass: false, reason,
  });
  if (!g.ok) throw new Error('R-065 拒' + op + '（' + (g.code ?? 'blocked') + '）：' + String(g.reason).split('\n')[0]);
  if (typeof action === 'function') action();
  return true;
}

const { loadRules } = await importButlerLib('audit-cli.mjs');
const { classifyActor } = await importButlerLib('session-header.mjs');
// 宿主适配层副本（唯一源 tools\lib\host-adapter.mjs；P1 收敛 2026-09-15）——P5 门的事件名走这里（R4）
import { EV } from './host-adapter.mjs';

export const AUDIT_GUARD_VERSION = '0.1.1';

// ─────────────────────────────────────────────────────────────────────────────
// 【卡「冲刺600·补面板残余」· gap-1-07 · 2026-10-10】失败策略表 §3.6.4 第 1 行落地：
//   「P5 写入拦截器（host 未加载 / 崩溃）→ **fail-open**（写入放行：拦死 DSH 比放过一次更糟），
//     但**必须告警"守门人不在岗"** —— 比拦截失败更危险的是**不知道自己没在拦**」。
//   落地形态（**零新增状态文件**：只走既有告警通道 lib/alert.mjs → `~/.dsh/butler-alert.log`）：
//     · 挂载成功 → `level=info` + `detail.kind='guard-mounted'`（在岗报到）
//     · 挂载失败 → `level=error` + `detail.kind='guard-missing'` + message 含固定串「守门人不在岗」
//   日报红项出口 = `tools\dsh-butler\lib\control-room-verdict.mjs` 的 `VERDICT_SOURCES` 源 `audit-guard`
//   （**唯一判定入口**，按「最后一条报到」判：missing ⇒ 🔴 红项；mounted ⇒ 清红；
//    从无报到 ⇒ 显式 `unavailable`（不假红、也不假绿））。
//   ⚠️ 改这两个 kind 字符串 = 必须同时改上面那处 `VERDICT_SOURCES`，勿只改一边。
export const GUARD_STATUS_KIND = Object.freeze({ mounted: 'guard-mounted', missing: 'guard-missing' });
/** 告警文案固定串（§3.6.4 原文；grep 判据也是它）。 */
export const GUARD_MISSING_MARK = '守门人不在岗';

/**
 * 报到守门人挂载状态（**绝不抛** —— 告警通道自身故障也不得拖垮面板）。
 * @param {{ok:boolean, stage?:string, error?:unknown, version?:string, logger?:object, home?:string}} [p]
 * @returns {{ok:boolean, file:string|null, error?:string, detail:object}}
 */
export function reportGuardMount(p = {}) {
  const detail = {
    kind: p.ok ? GUARD_STATUS_KIND.mounted : GUARD_STATUS_KIND.missing,
    stage: p.stage ?? 'mount',
    version: p.version ?? AUDIT_GUARD_VERSION,
    pid: process.pid,
    error: p.ok ? null : String(p.error?.message ?? p.error ?? 'unknown'),
  };
  const message = p.ok
    ? `守门人在岗（P5 写入拦截器已挂载 · v${detail.version} · pid ${detail.pid}）`
    : `${GUARD_MISSING_MARK}：P5 写入拦截器未挂载（fail-open —— 保护区写入**当前不被拦截**，B 层写后审计也不在跑）· 失败于 ${detail.stage} · ${detail.error}`;
  let r = { ok: false, file: null, error: 'alert-threw' };
  try {
    r = alert({ level: p.ok ? 'info' : 'error', source: 'butler-audit-guard', message, detail },
      { home: p.home ?? dshHome(), silent: true });
  } catch { /* 告警通道故障不影响主流程 */ }
  try {
    const line = r.ok ? message : `${message}（⚠️ 告警落盘失败：${r.error}）`;
    p.logger?.[p.ok ? 'info' : 'error']?.(`[butler-audit] ${line}`);
  } catch { /* ignore */ }
  return { ...r, detail };
}
// DSH 数据根：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（与 tools/lib/dsh-home.mjs 同源）。
// ★2026-09-14 环境边界修复：原为 `const DSH_HOME = path.join(os.homedir(), '.dsh')` +
//   模块加载期求值 → 测试/金丝雀实例里的守门人读写的仍是**生产** ~/.dsh（暂停开关、
//   审计流水、告警日志全落生产 home）。改为函数、每次现读；不设环境变量时结果不变。
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
const BAK_DIR = path.join(os.tmpdir(), 'butler-audit-bak');
const OFF_CACHE_MS = 3000;
const VERIFY_DELAY_MS = 1000;
const BAK_KEEP = 40;

/** 热路径用的暂停开关缓存（避免每次工具调用都读盘）。 */
function makeOffReader() {
  let cache = { at: 0, value: null };
  return function off(force = false) {
    const now = Date.now();
    if (force || now - cache.at > OFF_CACHE_MS || !cache.value) {
      let v;
      try {
        v = readAuditOff({ home: dshHome(), now });
      } catch {
        v = { active: false, off: false, reason: null, file: null };
      }
      cache = { at: now, value: v };
    }
    return cache.value;
  };
}

/** FsError 动态导入（抗升级：导出被改名/移除时退化为自造 Error，绝不让插件崩）。 */
let FsErrorCtor;
let fsErrorProbed = false;
async function probeFsError() {
  if (fsErrorProbed) return FsErrorCtor;
  fsErrorProbed = true;
  try {
    const m = await import('@deepseek-ai/dsh-fs');
    FsErrorCtor = typeof m?.FsError === 'function' ? m.FsError : null;
  } catch {
    FsErrorCtor = null;
  }
  return FsErrorCtor;
}
function makeFsError(code, message) {
  if (FsErrorCtor) {
    try { return new FsErrorCtor(message, 'FS_PERMISSION_DENIED'); } catch { /* fallback */ }
  }
  const e = new Error(message);
  e.name = 'FsError';
  e.code = 'FS_PERMISSION_DENIED';
  e.auditCode = code;
  return e;
}

/** 相对路径 → 绝对（write/edit 的 file_path 可能是相对 workspace 的路径）。 */
function resolveTargetPath(raw, exec) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const p = raw.trim();
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return p;
  const cwd = exec?.agent?.session?.header?.cwd ?? exec?.agent?.session?.cwd ?? process.cwd();
  return path.resolve(cwd, p);
}

/** 写前备份（B 层回滚素材）。只备份存在且是普通文件的目标。 */
function backupBeforeWrite(rawPath) {
  try {
    if (!rawPath) return null;
    const st = fs.statSync(rawPath);
    if (!st.isFile()) return null;
    fs.mkdirSync(BAK_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const base = path.basename(rawPath);
    const file = path.join(BAK_DIR, `${stamp}-${process.pid}-${base}`);
    fs.copyFileSync(rawPath, file);
    // 只留最近 BAK_KEEP 个备份
    const all = fs.readdirSync(BAK_DIR).filter((n) => n.endsWith(base)).sort();
    for (const n of all.slice(0, Math.max(0, all.length - BAK_KEEP))) {
      try { guardedDestructive({ targets: [path.join(BAK_DIR, n)], whitelist: [BAK_DIR], op: '删', reason: 'audit-guard: rotate write-ahead backups', action: () => fs.unlinkSync(path.join(BAK_DIR, n)) }); } catch { /* ignore */ }
    }
    return file;
  } catch {
    return null;
  }
}

/** 找某目标最近一次的写前备份。 */
function latestBackup(rawPath) {
  try {
    const base = path.basename(rawPath);
    const all = fs.readdirSync(BAK_DIR).filter((n) => n.endsWith(base)).sort();
    if (!all.length) return null;
    return path.join(BAK_DIR, all[all.length - 1]);
  } catch {
    return null;
  }
}

/** 跑规则（B 层写后审计）。 */
async function runRulesOn(text, target) {
  const rules = loadRules();
  const findings = [];
  for (const r of rules) {
    try {
      const mod = await r.loader();
      const def = mod?.default ?? mod?.rule ?? null;
      if (!def || typeof def.check !== 'function') continue;
      const raw = await def.check({ mode: 'post-write', file: target, target, text, sha256: null, bytes: Buffer.byteLength(text, 'utf8'), truncated: false, meta: { basename: path.basename(target) } });
      const list = Array.isArray(raw) ? raw : (raw && raw.ok === false ? [raw] : []);
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        findings.push({ rule: def.id ?? r.id, level: item.level ?? def.level ?? 'warn', message: item.message ?? '命中' });
      }
    } catch (e) {
      findings.push({ rule: r.id, level: 'error', message: `规则执行失败：${e?.message ?? e}` });
    }
  }
  return findings;
}

/**
 * 注册守门人（由 lib/index.js 的 apply 调用）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{logger?:object, home?:string}} [opts]
 */
export function registerAuditGuard(ctx, opts = {}) {
  const tokens = new AuditTokenStore();
  const off = makeOffReader();
  const log = (m) => { try { opts.logger?.info?.(`[butler-audit] ${m}`); } catch { /* ignore */ } };
  /** 待写后校验：pathKey → {at, raw, tier, backup} */
  const pending = new Map();
  const timers = new Set();

  const record = (entry) => {
    try { appendAudit({ type: 'audit-guard', ...entry }, { home: dshHome(), silent: true }); } catch { /* 审计失败不影响主流程 */ }
  };
  const notify = (level, message, detail) => {
    try { alert({ level, source: 'butler-audit-guard', message, detail }, { home: dshHome(), silent: true }); } catch { /* ignore */ }
  };

  probeFsError().then((c) => log(`FsError ${c ? '可用（真 FsError）' : '不可用（退化为自造 Error，抗升级兜底）'}`));

  // ---------------- ① fs 门（写前拦截 + 写前备份 + 登记待校验）
  const fsHandler = (eventName) => async (target, actor, next) => {
    let decision;
    try {
      decision = decideFsIntent({ target, tokens, off: off(), event: eventName, opts: { home: dshHome() } });
    } catch (e) {
      // 判定自身异常 → fail-closed（拦住），但不崩
      record({ action: 'block', code: 'GUARD_ERROR', event: eventName, error: String(e?.message ?? e) });
      throw makeFsError('GUARD_ERROR', `AUDIT_GUARD_ERROR: 审计判定异常，已 fail-closed 拦截（${e?.message ?? e}）`);
    }
    if (decision.action === 'block') {
      record({ action: 'block', code: decision.code, event: eventName, path: decision.pathKey, zone: decision.hit?.id });
      notify('warn', `写入被审计拦截：${path.basename(decision.pathKey)}（${decision.code}）`, { path: decision.pathKey });
      throw makeFsError(decision.code, decision.message);
    }
    // 放行：审计对象（A/B 层）先做写前备份 + 登记写后校验
    const rawPath = target?.displayPath ?? target?.targetKey ?? null;
    if (rawPath) {
      const auditTarget = resolveAuditTarget(target, { home: dshHome() });
      if (auditTarget?.exempted) {
        // 自指豁免（方案 §4 P4 v2.4）：大管家自身写入的路径（坑库 / 管家报告 / 变更流水渲染视图 /
        // 审计 JSONL / butler-* 状态文件）不做 B 层写后审计——否则 P4 自动写坑库会被自己判违规并回滚（死循环）。
        record({ action: 'exempt', path: rawPath, zone: auditTarget.id, rule: auditTarget.exemptRule, via: eventName });
      } else if (auditTarget) {
        const backup = backupBeforeWrite(rawPath);
        pending.set(normalizePath(rawPath), { at: Date.now(), raw: rawPath, tier: auditTarget.tier, zone: auditTarget.id, backup, event: eventName });
      }
    }
    if (decision.reason === 'token-consumed') {
      record({ action: 'pass', code: null, event: eventName, path: decision.pathKey, zone: decision.hit?.id, via: 'fs-token' });
    } else if (decision.reason === 'audit-off') {
      record({ action: 'allow', code: CODES.OFF, event: eventName, path: decision.pathKey, zone: decision.hit?.id });
    }
    return await next();
  };
  ctx.on(EV.FS_WRITE_INTENT, fsHandler(EV.FS_WRITE_INTENT), { prepend: true });
  ctx.on(EV.FS_EDIT_INTENT, fsHandler(EV.FS_EDIT_INTENT), { prepend: true });

  // ---------------- ② tools/pre-execute 内容门
  ctx.on(EV.TOOLS_PRE_EXECUTE, async (exec, next) => {
    const toolName = String(exec?.name ?? '');
    if (toolName !== 'write' && toolName !== 'edit') return await next();
    let decision;
    try {
      const abs = resolveTargetPath(exec?.arguments?.file_path, exec);
      const patched = abs ? { ...exec, arguments: { ...(exec.arguments ?? {}), file_path: abs } } : exec;
      decision = decideToolCall({
        exec: patched,
        tokens,
        off: off(),
        opts: { home: dshHome() },
        readFile: (p) => fs.readFileSync(p, 'utf8'),
      });
    } catch (e) {
      record({ action: 'block', code: 'GUARD_ERROR', event: EV.TOOLS_PRE_EXECUTE, tool: toolName, error: String(e?.message ?? e) });
      return { kind: 'deny', reason: `AUDIT_GUARD_ERROR: 审计判定异常，已 fail-closed 拦截（${e?.message ?? e}）` };
    }
    if (decision.action === 'block') {
      record({ action: 'block', code: decision.code, event: EV.TOOLS_PRE_EXECUTE, tool: toolName, path: decision.pathKey, zone: decision.hit?.id, degraded: decision.degraded ?? null });
      notify('warn', `写入被审计拦截（内容门）：${path.basename(decision.pathKey)}（${decision.code}）`, { path: decision.pathKey, tool: toolName });
      return { kind: 'deny', reason: decision.message };
    }
    if (decision.reason === 'token-hash-match') {
      record({ action: 'pass', code: null, event: EV.TOOLS_PRE_EXECUTE, tool: toolName, path: decision.pathKey, zone: decision.hit?.id, via: 'content-hash' });
    } else if (decision.reason === 'token-path-match' && decision.degraded) {
      record({ action: 'pass', code: null, event: EV.TOOLS_PRE_EXECUTE, tool: toolName, path: decision.pathKey, via: 'path-only', degraded: decision.degraded });
    }
    return await next();
  }, { prepend: true });

  // ---------------- ③ B 层：fs/observed 后延迟 1s 写后审计 + 违规回滚
  ctx.on(EV.FS_OBSERVED, (target, observation, actor) => {
    if (!target) return;
    const key = normalizePath(target.targetKey ?? target.displayPath ?? '');
    const entry = pending.get(key);
    if (!entry) return;
    if (observation?.kind === 'absent') { pending.delete(key); return; }
    pending.delete(key);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void postAudit(key, entry);
    }, VERIFY_DELAY_MS);
    timers.add(timer);
    if (typeof timer.unref === 'function') timer.unref();
  });

  async function postAudit(key, entry) {
    const file = entry.raw;
    let text;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(file);
      mtimeMs = st.mtimeMs;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // 文件被删/不可读 → 不审计
    }
    // 写入没发生（mtime 早于登记时刻）→ 跳过，避免误判旧内容
    if (mtimeMs + 50 < entry.at) return;
    const findings = await runRulesOn(text, file);
    const blocked = findings.filter((f) => f.level === 'block' || f.level === 'error');
    if (!blocked.length) {
      if (findings.length) record({ action: 'post-warn', path: key, zone: entry.zone, findings: findings.slice(0, 5) });
      return;
    }
    record({ action: 'post-block', path: key, zone: entry.zone, findings: blocked.slice(0, 5) });
    // 回滚
    let rolledBack = false;
    if (entry.backup) {
      try {
        fs.copyFileSync(entry.backup, file);
        rolledBack = true;
      } catch (e) {
        record({ action: 'rollback-failed', path: key, error: String(e?.message ?? e) });
      }
    }
    notify('error', `写后审计发现违规：${path.basename(file)}（${blocked.map((b) => b.message).join('；').slice(0, 160)}）${rolledBack ? ' 已回滚' : ' 回滚失败/无备份'}`,
      { path: file, findings: blocked.slice(0, 5), rolledBack, backup: entry.backup });
  }

  ctx.effect(() => () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pending.clear();
  }, 'butler-audit-guard teardown');

  log(`守门人已挂载（fs/* + tools/pre-execute prepend；凭证 TTL ${tokens.ttlMs}ms）`);
  // 【gap-1-07】在岗报到（info）：「最后一条报到」= 日报与面板的判定依据 —— mounted 清红、missing 判红。
  reportGuardMount({ ok: true, stage: 'mount', version: AUDIT_GUARD_VERSION, logger: opts.logger, home: opts.home });

  // ---------------- 对外接口（路由 / 面板用）
  return {
    tokens,
    off: (force = false) => off(force),
    setOff: (input) => {
      const r = writeAuditOff({ home: dshHome(), ...input });
      off(true);
      record({
        action: input?.off === false ? 'audit-resume' : 'audit-pause',
        reason: r.reason, by: r.by, until: r.until,
        // 【卡「冲刺600 · audit-off 限时」】把 TTL 实况一起记进审计（被 clamp 过 = 一眼可见）
        ttlMs: r.ttlMs ?? null, ttlClamped: r.ttlClamped === true, ttlRequested: r.ttlRequested ?? null,
      });
      // 【卡「冲刺600 · audit-off 限时」③】暂停/恢复都进**既有告警通道**（lib/alert.mjs → ~/.dsh/butler-alert.log，
      //   不新造通道、不新增状态文件）。暂停 = warn（保护降级必须有人看得见）；恢复 = info。
      if (r.off === true) {
        notify('warn',
          `写入审计已暂停（逃生舱）· 理由：${r.reason ?? '(未记)'}`
          + (r.until ? ` · 将于 ${new Date(r.until).toLocaleString('zh-CN', { hour12: false })}（本机时区）自动恢复` : ' · ⚠️ 无到期时间（异常，应立即排查）'),
          { until: r.until ?? null, ttlMs: r.ttlMs ?? null, clamped: r.ttlClamped === true, requested: r.ttlRequested ?? null, by: r.by });
      } else {
        notify('info', `写入审计已恢复：保护区写入重新需要审计凭证 · 理由：${r.reason ?? '(未记)'}`, { by: r.by });
      }
      return r;
    },
    issueToken: (pathKey, hash, meta) => {
      const e = tokens.issue(pathKey, hash, meta);
      record({ action: 'issue-token', path: pathKey, hash: e.hash, actor: e.actor, source: e.source, forced: Boolean(meta?.reason) });
      return e;
    },
    judgeForce: (input) => {
      const actor = input?.viaPanel ? { viaPanel: true } : classifyActor(input?.actorSession, dshHome());
      return { ...judgeForce({ ...actor, viaPanel: input?.viaPanel === true }), actor };
    },
    stats: () => ({ tokens: tokens.stats(), off: off(true), pending: pending.size, bakDir: BAK_DIR }),
  };
}

export { CODES, blockMessage, judgeForce };
