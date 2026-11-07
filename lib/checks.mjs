// dsh-butler-panel / lib/checks.mjs —— M3 日报新增四段采集（卡 [3b]，2026-09-09）
// 方案：docs\大管家v2方案-从只读到真管家-20260909.md §4 M3（改动 2/3/5/7）
//
// 纯只读、0 token；每一段独立 try/catch → 失败降级「不可探测」，绝不中断日报。
// 被 report.mjs（日报）/ report-weekly.mjs（周报）引用；不参与插件运行时，改本文件不需要重新部署插件。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import { isAuditE2eNoise, SESSION_LOG_RE } from './state.js';
// 仓体积 / Gitee 配额口径 —— **单一真源**（tools/dsh-butler/lib/repo-volume-thresholds.mjs）
//  2026-09-16 拷问 P1：日报此前完全没有"仓体积 vs 配额"这一行，仓2 从换仓后的 180MB 涨回 ~600MB
//  一路无人知道；本段把 `.git` 占用比 + 增速 + 预计撞线时间铺进「📡 同步健康」。
//  ❗2026-09-16 部署事故：这里原来是**相对路径** `../../dsh-butler/lib/…` ——
//   在仓库里跑（tools/dsh-butler-panel/lib/）恰好等于 tools/dsh-butler/lib/，自测全绿；
//   一旦部署到 ~/.dsh/profiles/web/node_modules/dsh-butler-panel/lib/，就解析成
//   node_modules/dsh-butler/lib/…，而该包在 profile 里**根本不存在**（dsh-butler 是工具目录、不是插件包）
//   → 静态 import 解析失败 → 整个 plugin tree 加载失败 → `dsh web` 启动即崩。
//   约定（同 lib/index.js、lib/audit-guard.js）：插件内引用 butler lib 一律用 file:/// 绝对 URL。
import { importButlerLib, importButlerFile, importToolLib, workspaceRoot, toolLib, docsDir, statePathResolver } from './butler-root.mjs';
const { judgeRepoVolume, measureGitVolume, estimateGrowth } = await importButlerLib('repo-volume-thresholds.mjs');
// 【2c · 2c-B5】状态路径统一入口（legacy 期解析结果与 path.join(home, name) 逐字节相同）。
const resolveStatePath = await statePathResolver();

// DSH 数据根：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（与 tools/lib/dsh-home.mjs 同源）。
// ★2026-09-14 环境边界修复：原为 `const HOME = os.homedir()`（模块加载期求值），
//   测试/金丝雀实例里日报会去读**生产** home（会话数/审计流水/外部信号全指生产）。
//   改为函数现读；不设环境变量时路径与改造前逐字节一致。
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
const DSH_ROOT = workspaceRoot();
// 仓备份 / 冷备盘：全部走环境变量，未配置时退化成「一定不存在的路径」⇒ 相关检查自然降级为
// 「不可探测」，而不是悄悄指向别人的目录。DSH_OFFSYNC_ROOT / DSH_COLD_KEY_FILE 两个变量名
// 就是这两个位置的唯一真源（README 的「怎么接上自己的备份」一节按此写）。
const OFFSYNC = (process.env.DSH_OFFSYNC_ROOT ?? '').trim() || path.join(DSH_ROOT, '.offsync-not-configured');
const BACKUP_ROOT = path.join(OFFSYNC, 'git-backup');
const KEY_FILE = path.join(BACKUP_ROOT, 'keys', 'dsh-core.key');
const COLD_KEY = (process.env.DSH_COLD_KEY_FILE ?? '').trim() || path.join(DSH_ROOT, '.cold-key-not-configured');

/** 磁盘低水位（GB）——9/9 大扫除前 D 盘曾只剩 ~1GB。env 覆盖仅用于单测注入。 */
export const DISK_WARN_GB = Number(process.env.DSH_BUTLER_DISK_WARN_GB ?? 15) || 15;
/** 仓新鲜度阈值（天）——超过则提示该 -Push。 */
export const REPO_STALE_DAYS = 3;
/** 未分组会话数阈值。 */
export const UNGROUPED_WARN = 3;
/** 未 ack 超时（小时）→ 计为疑似误报。 */
export const UNACK_SUSPECT_HOURS = 4;
/** 裸跑期放行门槛（方案 §3.7.1 / §5）。 */
export const FP_GATE_RATE = 0.05;
export const FP_WARN_RATE = 0.10;
export const FP_MIN_SAMPLES = 50;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch { return null; }
}
function fmtGB(gb) {
  if (!Number.isFinite(gb)) return '?';
  return gb >= 100 ? `${gb}GB` : `${gb}GB`;
}
function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function daysAgo(ms) { return (Date.now() - ms) / 86400000; }

/** TCP 端口探测（127.0.0.1），超时即判关。 */
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, '127.0.0.1'); } catch { finish(false); }
  });
}

/** 磁盘可用空间（Node ≥18.15 的 fs.statfsSync）。 */
function diskFree() {
  const out = {};
  for (const d of ['C', 'D']) {
    try {
      const s = fs.statfsSync(d + ':\\');
      out[d] = { ok: true, gb: Math.round((s.bavail * s.bsize) / 1e9) };
    } catch (e) {
      out[d] = { ok: false, error: String(e?.message ?? e) };
    }
  }
  return out;
}

/** cloudflared 进程：true / false / null（不可探测）。 */
function cloudflaredRunning() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    if (r?.error) return null;
    if (typeof r?.stdout !== 'string' || r.stdout.trim() === '') return null;
    if (/INFO: No tasks/i.test(r.stdout)) return false;
    return /cloudflared\.exe/i.test(r.stdout);
  } catch { return null; }
}

/**
 * 局域网 IPv4：排除回环 / APIPA(169.254.*) / 未就绪地址；私有段优先（192.168 > 10 > 172.16-31）。
 * 手机扫码要连的是能通的那个，169.254 link-local 基本连不上。
 */
function lanIPv4() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(os.networkInterfaces() ?? {})) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (/^169\.254\./.test(a.address)) continue;
        out.push({ name, address: a.address, rank: ipRank(a.address) });
      }
    }
  } catch { /* ignore */ }
  out.sort((x, y) => x.rank - y.rank);
  return out;
}
function ipRank(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/** 手机隧道状态文件（dsh-phone-tunnel.ps1 写入）。 */
function tunnelState() {
  const f = path.join(dshHome(), 'phone-tunnel-state.json');
  const j = readJsonSafe(f);
  if (!j) return { ok: false, file: f };
  return { ok: true, file: f, url: j.url ?? null, at: j.at ?? null, pid: j.pid ?? null, alive: j.alive !== false };
}

/** git 命令包装（超时 / 失败都不抛）。 */
function gitOut(cwd, args, timeout = 8000) {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout, windowsHide: true });
    if (r?.error) return { ok: false, error: String(r.error.message ?? r.error) };
    if (r?.status !== 0) return { ok: false, error: ((r?.stderr ?? '') + (r?.stdout ?? '')).trim() || ('exit ' + r?.status) };
    return { ok: true, out: (r?.stdout ?? '').trim() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 异步 git 探测（只判可达性，不取输出；stdio=ignore 避免管道占用）。
 * 日报要「8-15s 内出结果」→ 远端探测必须并行 + 短超时。
 */
function gitProbe(cwd, args, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    let child;
    try {
      child = spawn('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'ignore' });
    } catch (e) { return finish({ ok: false, error: String(e?.message ?? e) }); }
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, error: 'timeout' }); }, timeout);
    child.on('error', (e) => { clearTimeout(t); finish({ ok: false, error: String(e?.message ?? e) }); });
    child.on('close', (code) => { clearTimeout(t); finish({ ok: code === 0, error: code === 0 ? null : ('exit ' + code) }); });
  });
}

// ---------------------------------------------------------------------------
// 段 1 · 🛠 开工预检（方案改动 2）
// 5 项纯只读：C/D 盘余量 / 代理 7897 / 本地生图栈 8199+8188 / dsh 3080 / 📱 手机通道
// 只报状态不告警的项（代理 / 生图栈 / 手机）level 恒为 'info'，磁盘低水位才标黄。
// ---------------------------------------------------------------------------
export async function collectPreflight() {
  const items = [];

  // ① C/D 盘余量
  try {
    const d = diskFree();
    const parts = [];
    let low = [];
    for (const k of ['C', 'D']) {
      const x = d[k];
      if (!x?.ok) { parts.push(`${k}: 不可探测`); continue; }
      const warn = x.gb < DISK_WARN_GB;
      if (warn) low.push(k);
      parts.push(`${k}: 余 ${fmtGB(x.gb)}${warn ? ' ⚠️' : ''}`);
    }
    items.push({
      label: '磁盘余量',
      value: parts.join(' / ') + (low.length ? `（<${DISK_WARN_GB}GB 告警：${low.join('/')}）` : ''),
      level: low.length ? 'yellow' : 'green'
    });
  } catch (e) {
    items.push({ label: '磁盘余量', value: '不可探测（' + String(e?.message ?? e) + '）', level: 'gray' });
  }

  // ② 代理 7897（按需开 → 只报状态）
  try {
    const on = await probePort(7897);
    items.push({ label: '代理 7897', value: on ? '开' : '关', level: 'info' });
  } catch {
    items.push({ label: '代理 7897', value: '不可探测', level: 'gray' });
  }

  // ③ 本地生图栈 8199（桥）+ 8188（ComfyUI）——按需启动 → 只报状态
  try {
    const [bridge, comfy] = await Promise.all([probePort(8199), probePort(8188)]);
    items.push({
      label: '本地生图栈',
      value: `8199 桥${bridge ? '开' : '关'} / 8188 ComfyUI${comfy ? '开' : '关'}`,
      level: 'info'
    });
  } catch {
    items.push({ label: '本地生图栈', value: '不可探测', level: 'gray' });
  }

  // ④ dsh 本体 3080
  // 设计上就指生产，不随环境改道（2026-09-14 环境边界判定）：本项读的是「生产 DSH 本体在不在跑」，
  // 面板/日报里这一格永远报告**生产**实例；改成可改道反而会让测试实例把自己当成生产来报。
  try {
    const on = await probePort(3080);
    items.push({ label: 'dsh 本体', value: on ? '运行中' : '未运行', level: on ? 'green' : 'info' });
  } catch {
    items.push({ label: 'dsh 本体', value: '不可探测', level: 'gray' });
  }

  // ⑤ 📱 手机通道：3081 局域网代理 + cloudflared + 局域网 IP + 隧道 URL
  try {
    const on3081 = await probePort(3081);
    const cf = cloudflaredRunning();
    const ips = lanIPv4();
    const tun = tunnelState();
    const lan = ips.length ? ips.map((x) => x.address).join(', ') : '无';
    const cfLabel = cf === null ? '不可探测' : (cf ? '在线' : '离线');
    const parts = [
      `3081 ${on3081 ? '开' : '关'}`,
      `隧道 ${cfLabel}`,
      `局域网 IP ${lan}`
    ];
    if (tun.ok && tun.url) parts.push(`隧道地址 ${tun.url}${tun.at ? `（${fmtTime(tun.at)}）` : ''}`);
    else if (tun.ok) parts.push('隧道地址 未记录');
    else parts.push('隧道地址 无状态文件');
    if (ips.length) parts.push(`连 http://${ips[0].address}:3081`);
    items.push({ label: '📱 手机通道', value: parts.join(' · '), level: 'info' });
  } catch (e) {
    items.push({ label: '📱 手机通道', value: '不可探测（' + String(e?.message ?? e) + '）', level: 'gray' });
  }

  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// 段 2 · 🏗 结构健康（方案改动 3）
// ① junction 目标存在（外移清单，断链 🔴）② 未分组会话数 >3 🟡 ③ profile 版本漂移 🟡
// ---------------------------------------------------------------------------
/** 已外移的大目录（persona 目录铁律；示例配置 6 条，别的机器可能更多 → 再自动发现补充）。 */
export const OUTSOURCED_DIRS = ['_archive', '_tmp', 'backups', 'generated', 'logs', 'snapshots'];

/** 扫 `<workspace>` 直属的 reparse point（junction）并验证目标。 */
export function scanJunctions(root = DSH_ROOT) {
  const found = [];
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) {
    return { ok: false, error: String(e?.message ?? e), items: [] };
  }
  for (const e of ents) {
    const p = path.join(root, e.name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isSymbolicLink()) continue;
    let target = null;
    try { target = fs.readlinkSync(p); } catch { /* 读不到目标 */ }
    let exists = false;
    let isDir = false;
    try { const t = fs.statSync(p); exists = true; isDir = t.isDirectory(); } catch { /* 断链 */ }
    found.push({ name: e.name, target, exists, isDir });
  }
  // 期望清单与实扫合并：期望项即使不是链接也要报（可能被改成实体目录）
  const map = new Map(found.map((x) => [x.name.toLowerCase(), x]));
  const items = [];
  for (const name of OUTSOURCED_DIRS) {
    const hit = map.get(name.toLowerCase());
    if (hit) {
      items.push({
        name, kind: 'expected', target: hit.target, exists: hit.exists,
        level: hit.exists ? 'green' : 'red',
        note: hit.exists ? '' : '断链（目标不存在）'
      });
    } else {
      const p = path.join(root, name);
      let existsAny = false;
      try { existsAny = fs.existsSync(p); } catch { /* ignore */ }
      items.push({
        name, kind: 'expected', target: null, exists: false,
        level: existsAny ? 'yellow' : 'gray',
        note: existsAny ? '未外移（实体目录，非 junction）' : '缺失'
      });
    }
  }
  for (const x of found) {
    if (OUTSOURCED_DIRS.some((n) => n.toLowerCase() === x.name.toLowerCase())) continue;
    items.push({
      name: x.name, kind: 'extra', target: x.target, exists: x.exists,
      level: x.exists ? 'green' : 'red', note: x.exists ? '' : '断链（目标不存在）'
    });
  }
  return { ok: true, items, root };
}

/** 未分组会话数（复用 fix-workspace-local.mjs 的 workspace.json + sessions 组判定）。 */
export function ungroupedSessions() {
  const wsFile = path.join(dshHome(), 'storages', 'workspace.json');
  const sessionsRoot = path.join(dshHome(), 'sessions');
  const ws = readJsonSafe(wsFile);
  if (!ws) return { ok: false, reason: 'workspace.json 不可读（' + wsFile + '）' };
  const ids = new Set();
  const wsIds = ws?.global?.workspaceIds ?? [];
  for (const id of wsIds) {
    const o = ws?.tables?.workspaces?.[id];
    for (const s of o?.sessionIds ?? []) ids.add(s);
  }
  let total = 0;
  const ungrouped = [];
  let groups;
  try { groups = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch (e) {
    return { ok: false, reason: 'sessions 目录不可读：' + String(e?.message ?? e) };
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    let ents;
    try { ents = fs.readdirSync(path.join(sessionsRoot, g.name), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      total++;
      if (!ids.has(e.name)) ungrouped.push({ id: e.name, group: g.name });
    }
  }
  return { ok: true, total, ungrouped: ungrouped.length, samples: ungrouped.slice(0, 5), workspaces: wsIds.length };
}

/** profile 版本漂移（声明 vs 实体；同生态面板 upgrade.js collectLocalFacts 口径，实体优先）。 */
export function profileDrift() {
  const prof = path.join(dshHome(), 'profiles', 'web');
  const pkg = readJsonSafe(path.join(prof, 'package.json'));
  if (!pkg) return { ok: false, reason: 'profiles/web/package.json 不可读' };
  const deps = pkg?.dependencies ?? {};
  const nm = path.join(prof, 'node_modules');
  const drift = [];
  let checked = 0;
  for (const [name, declared] of Object.entries(deps)) {
    const seg = name.startsWith('@') ? name.split('/') : [name];
    const entPkg = readJsonSafe(path.join(nm, ...seg, 'package.json'));
    if (!entPkg?.version) continue;
    checked++;
    if (typeof declared === 'string' && /^\d/.test(declared) && declared !== entPkg.version) {
      drift.push({ name, declared, entity: entPkg.version });
    }
  }
  return { ok: true, checked, drift };
}

/**
 * 闭包指向检查（2026-09-13 新增 · 卡「金丝雀闭包污染收尾」· 只读）
 *
 * 看什么：`<home>/profiles/node_modules` 下是否有链接指向「测试/金丝雀闭包」
 * （DSH-test* / canary）—— 一旦有，未来版主包随时会把共享闭包整体改写，
 * 生产重启即加载错版本包（2026-09-11 实测：414 个链接被改指 0.1.5-rc.2 闭包 →
 * dshmarket / imagegen / task-board-local 启动崩）。
 *
 * 判据单一真源 = `<workspace>/tools/lib/closure-links.mjs`（**勿在本文件另造口径**）：
 *   干净态 = 全部链接指向 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\*`。
 * 动态 import + 失败降级：库缺失只让本行「不可探测」，绝不影响日报其余段落。
 */
export async function collectClosureLinks(opts = {}) {
  try {
    const lib = await importToolLib('closure-links.mjs');
    const scan = lib.scanClosureLinks({ linkRoot: opts.linkRoot, sourceRoot: opts.sourceRoot });
    if (!scan.ok) return { ok: false, reason: scan.reason ?? '扫描不可用' };
    return {
      ok: true,
      level: scan.level,
      linkRoot: scan.linkRoot,
      physicalRoot: scan.physicalRoot,
      sourceRoot: scan.sourceRoot,
      total: scan.total,
      matched: scan.matched,
      polluted: scan.polluted.length,
      broken: scan.broken.length,
      other: scan.other.length,
      samples: (opts.samples ?? 5) > 0
        ? scan.polluted.slice(0, opts.samples ?? 5).map((l) => ({ rel: l.rel, target: l.target, targetExists: l.targetExists }))
        : [],
    };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}

export function collectStructure() {
  let junction;
  try { junction = scanJunctions(); } catch (e) { junction = { ok: false, error: String(e?.message ?? e), items: [] }; }
  let ungrouped;
  try { ungrouped = ungroupedSessions(); } catch (e) { ungrouped = { ok: false, reason: String(e?.message ?? e) }; }
  let drift;
  try { drift = profileDrift(); } catch (e) { drift = { ok: false, reason: String(e?.message ?? e) }; }
  return { ok: true, junction, ungrouped, drift };
}

// ---------------------------------------------------------------------------
// 段 3 · 📡 同步健康（方案改动 5）
// 两仓新鲜度（>3 天 🟡）/ git-crypt key（缺失/0 字节 🔴）/ 远端可达（只报状态）/ 双机交接提示
// ---------------------------------------------------------------------------
/** 最近 N 分钟内被写过的会话数（双开判定用，纯 mtime 扫描）。
 *  ★2026-09-24 修（卡「修·V3判据②」）：原先写死旧名 `session.jsonl.zstd`，而主包 0.1.5 起
 *    会话日志换代成 `session.v3.jsonl.zstd`（生产实测 227/227 只有新名）⇒ 本计数**恒 0**，
 *    「同步健康」段的双开提示等于没有。现改为按同族名扫、取 **mtime 最新**那份（= 该会话
 *    最后被写的时间），正则复用 lib/state.js#SESSION_LOG_RE（与闸门侧 restart.mjs 同源，单一判据）。 */
export function activeSessionCount(minutes = 30) {
  const root = path.join(dshHome(), 'sessions');
  const cut = Date.now() - minutes * 60000;
  let n = 0;
  let groups;
  try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    let ents;
    try { ents = fs.readdirSync(path.join(root, g.name), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      // ⚠️ `session-` 前缀过滤是**有意**的：subagent 子会话目录是纯 uuid（不该算"主人在用的会话"），
      //    与 state.js#listSessionFiles 同口径。
      if (!e.isDirectory() || !e.name.startsWith('session-')) continue;
      const dir = path.join(root, g.name, e.name);
      let newest = 0;
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!SESSION_LOG_RE.test(f)) continue;
        try {
          const st = fs.statSync(path.join(dir, f));
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        } catch { /* 单文件 stat 失败不影响其它同名族文件 */ }
      }
      if (newest >= cut) n++;
    }
  }
  return n;
}

/** 解析 `## master...origin/master [ahead 1, behind 2]`。 */
function parseTracking(line) {
  const m = /\[(.+?)\]/.exec(line ?? '');
  const out = { ahead: 0, behind: 0 };
  if (!m) return out;
  const a = /ahead (\d+)/.exec(m[1]);
  const b = /behind (\d+)/.exec(m[1]);
  if (a) out.ahead = +a[1];
  if (b) out.behind = +b[1];
  return out;
}

// ---------------------------------------------------------------------------
// 段 3 附 · 交接健康 + 记忆库 RPO（P9 §17.2 T5 / T6 · 2026-09-15）
//   为什么在这里：T6 的落差是"时钟门拒绝态**没有任何一处界面说过**"（主人只看到 🔴、交接实际瘫痪而不自知），
//   T5 的落差是"记忆库 RPO 从未登记"（方案 §5.7 只有「会话 RPO」一行，而记忆库是 A 类不可重建）。
//   落点刻意**复用「📡 同步健康」段**（§5.5 可见性铁律），判定口径单一真相在
//   `tools\dsh-butler\lib\handoff-health.mjs`（纯函数）—— 本文件只做 IO 采集 + 降级，不复制任何判据。
//   动态 import + 存在性判定：测试/金丝雀实例（DSH_HOME 重定向）下 tools 路径可能不同，
//   取不到就降级"不可探测"，**绝不让日报因它崩段**。
//   ❗路径必须是绝对 file:/// URL（2026-09-16 事故：相对路径部署后必然解析到不存在的
//   node_modules/dsh-butler/lib/，功能静默降级成"不可探测"，界面上一句提示都没有）。
// ---------------------------------------------------------------------------
let _handoffHealthMod = null;
async function loadHandoffHealth() {
  if (_handoffHealthMod !== null) return _handoffHealthMod;
  try {
    _handoffHealthMod = await importButlerLib('handoff-health.mjs');
  } catch {
    _handoffHealthMod = false;
  }
  return _handoffHealthMod;
}

let _collectFailMod = null;
async function loadCollectFailureLedger() {
  if (_collectFailMod !== null) return _collectFailMod;
  try {
    _collectFailMod = await importButlerLib('collect-failure-ledger.mjs');
  } catch {
    _collectFailMod = false;
  }
  return _collectFailMod;
}

// ---------------------------------------------------------------------------
// 段 3 附⓪ · 跨机同步总开关读取器（2026-10-14 口径打架修复）
//   为什么在这里：见 collectSync ⓪ 段注释。动态 import + 存在性判定 + 降级，
//   **与 loadHandoffHealth / loadCollectFailureLedger 同形**（测试/金丝雀实例下 tools
//   路径可能不同、该件跨机分发可能滞后 ⇒ 取不到只降级，绝不让日报崩段）。
// ---------------------------------------------------------------------------
let _syncTopologyMod = null;
async function loadSyncTopology() {
  if (_syncTopologyMod !== null) return _syncTopologyMod;
  try {
    _syncTopologyMod = await importButlerLib('sync-topology.mjs');
  } catch {
    _syncTopologyMod = false;
  }
  return _syncTopologyMod;
}

/**
 * 段 3 附② · 采集失败台账（卡 AT16 · 2026-09-16）
 *   为什么在这里：仓1/仓3（AT15）、仓2（AT16）的采集降级后，失败只落在
 *   `<workspace>/logs/backup-collect-failures-*.json` 台账里 —— 无人值守时**没有任何界面说过**
 *   "本轮采集不完整"。落点同样**复用「📡 同步健康」段**（§5.5 可见性铁律），判定唯一真相在
 *   `tools\dsh-butler\lib\collect-failure-ledger.mjs`（纯函数 + 薄 IO），本文件只做转发与降级。
 *   零噪音契约：台账全 0 / 台账陈旧超窗 → lines 为空 → 日报不产生任何行（卡 AT16 验收③）。
 * @param {{now?:number, logsDir?:string}} [opts]
 * @returns {Promise<object>} 判定结果（level/lines/rows/…）；库不可用 → {ok:false, reason}
 */
export async function collectCollectFailures(opts = {}) {
  const mod = await loadCollectFailureLedger();
  if (!mod || typeof mod.collectCollectFailures !== 'function') {
    return { ok: false, reason: 'collect-failure-ledger 库不可用（不可探测）' };
  }
  // 台账目录：env DSH_BUTLER_COLLECT_LEDGER_DIR 优先（夹具/测试隔离），否则 <workspace>/logs
  const logsDir = opts.logsDir ?? process.env.DSH_BUTLER_COLLECT_LEDGER_DIR ?? path.join(DSH_ROOT, 'logs');
  return await mod.collectCollectFailures({ now: opts.now ?? Date.now(), logsDir });
}

/** 文件 stat（不存在/不可读 → null）。 */
function statOrNull(p) {
  try { const st = fs.statSync(p); return { path: p, mtimeMs: st.mtimeMs, bytes: st.size }; }
  catch { return null; }
}

/**
 * 采集交接健康（本机交接单 + 本机记忆库 + 仓1 副本记忆库）→ 交给纯函数判定。
 * @param {{now?:number, recordFile?:string, localMemoryFile?:string, repoMemoryFile?:string}} [opts]
 * @returns {Promise<object>} 判定结果（含 level / summary / lines / reasons / facts）；失败 → {ok:false, reason}
 */
export async function collectHandoffHealth(opts = {}) {
  const home = dshHome();
  const recordFile = opts.recordFile ?? resolveStatePath('butler-handoff.json', { home }).path;
  const localMemoryFile = opts.localMemoryFile ?? path.join(home, 'memory', 'memory.db');
  // 仓1 工作副本里的记忆库 = 「记忆库**真正被搬进仓**」的时刻（asOf 口径 = file-mtime，与面板片的
  // `asOf.memory = fileAsOf(memory.db)` 同源 —— 不另造一套 asOf 口径）。
  const repoMemoryFile = opts.repoMemoryFile ?? path.join(BACKUP_ROOT, 'dsh-core', 'dsh', 'memory', 'memory.db');
  const mod = await loadHandoffHealth();
  const record = readJsonSafe(recordFile);
  const localMemory = statOrNull(localMemoryFile);
  const repoMemory = statOrNull(repoMemoryFile);
  if (!mod || typeof mod.judgeHandoffHealth !== 'function') {
    return { ok: false, reason: 'handoff-health 库不可用（不可探测）', recordFile, localMemoryFile, repoMemoryFile };
  }
  // 对端交接单（仓1 `dsh/butler-handoff/<host>.json`）：**双开嫌疑只看对端**（§17.2 T4 口径），
  // 本机心跳新于本机上次完整交接是正常形态（热采每 30min 更新）→ 拿本机判必误报。
  const peerDir = opts.peerDir ?? path.join(BACKUP_ROOT, 'dsh-core', 'dsh', 'butler-handoff');
  const localHost = os.hostname().toLowerCase();
  let peerRecord = null; let peerHost = null;
  try {
    for (const n of fs.readdirSync(peerDir)) {
      if (!n.toLowerCase().endsWith('.json')) continue;
      const h = n.replace(/\.json$/i, '');
      if (h.toLowerCase() === localHost) continue;
      const j = readJsonSafe(path.join(peerDir, n));
      if (j) { peerRecord = j; peerHost = h; break; }
    }
  } catch { /* 对端交接单还没有（首次交接前）→ 不判、不告警 */ }
  const hh = mod.judgeHandoffHealth({ now: opts.now ?? Date.now(), record, peerRecord, peerHost, localMemory, repoMemory });
  return { ok: true, ...hh, recordFile, localMemoryFile, repoMemoryFile, peerHost };
}

// ---------------------------------------------------------------------------
// P9 H4 · 日报「🤝 交接」段采集（M3）
//   §5.5 可见性铁律：Arrive/Depart 结束**无条件**播报一行「交接状态 + 数据新鲜度截止时间（asOf）+
//   未推项数」；§5.4 R6 的体积超阈也在这里可见。**判定不在这里**：
//     · 窗口（进行中 / 中断 / TTL） → tools\dsh-butler\lib\handoff-window.mjs
//     · 新鲜度两档 + 记忆库 RPO      → tools\dsh-butler\lib\handoff-health.mjs（本文件 collectHandoffHealth 已用）
//   本函数只读交接单 + 铺行，失败降级「不可探测」，绝不中断日报。
// ---------------------------------------------------------------------------
/**
 * @param {{now?:number, recordFile?:string}} [opts]
 * @returns {Promise<{ok:boolean, present:boolean, level?:string, lines:string[], facts:object, reason?:string}>}
 */
export async function collectHandoffSection(opts = {}) {
  const now = opts.now ?? Date.now();
  const recordFile = opts.recordFile ?? resolveStatePath('butler-handoff.json', { home: dshHome() }).path;
  const lines = [];
  const facts = {
    asOf: null, asOfAgeMs: null, role: null, result: null, finishedAt: null,
    unpushedCount: 0, skipped: [], deferred: [], alerts: 0, redAlerts: 0,
    volumesOver: [], running: false, runMode: null, timedOut: false,
  };
  let record = null;
  try { record = readJsonSafe(recordFile); } catch { record = null; }
  // 窗口判定（单一真相）；库取不到 → 只降级窗口行，不影响其余
  let run = null;
  try {
    const m = await importButlerLib('handoff-window.mjs');
    run = m.judgeHandoffRun(record, { now, home: dshHome() });
  } catch { run = null; }
  if (run) {
    facts.running = run.active === true;
    facts.runMode = run.mode ?? null;
    facts.timedOut = run.timedOut === true;
  }
  if (!record) {
    lines.push('- ❔ 本机无交接单（状态目录下没有交接状态文件）—— 交接从未跑过或已被清理');
    return { ok: true, present: false, lines, facts, reason: 'no-record' };
  }
  facts.role = record.role ?? null;
  facts.result = record.result ?? null;
  facts.finishedAt = record.finishedAt ?? null;
  // 心跳（§5.7：陈旧 90min 🟡 / 本机 Arrive 中被更新 = 双开嫌疑 🔴）
  facts.lastHeartbeatAt = record.lastHeartbeatAt ?? null;
  const hbMs = record.lastHeartbeatAt ? Date.parse(record.lastHeartbeatAt) : null;
  facts.heartbeatAgeMs = Number.isFinite(hbMs) ? now - hbMs : null;
  facts.heartbeatStale = Number.isFinite(facts.heartbeatAgeMs) ? facts.heartbeatAgeMs > 90 * 60000 : null;
  // 体积（§5.4 R6：仓1 200MB / 仓2 1.5GB / 仓3 400MB，超阈 → 面板红条）
  const volsAll = Array.isArray(record.volumes) ? record.volumes : [];
  facts.volumes = volsAll.map((v) => ({
    repo: v.repo ?? null, sizeBytes: v.sizeBytes ?? null, thresholdBytes: v.thresholdBytes ?? null,
    overThreshold: v.overThreshold === true,
  }));
  facts.asOf = record.lastSuccessfulHandoffAt ?? null;
  const asOfMs = facts.asOf ? Date.parse(facts.asOf) : null;
  facts.asOfAgeMs = Number.isFinite(asOfMs) ? now - asOfMs : null;
  const alerts = Array.isArray(record.alerts) ? record.alerts : [];
  facts.alerts = alerts.length;
  facts.redAlerts = alerts.filter((a) => a?.level === 'alert' || a?.level === 'error').length;
  const deferred = Array.isArray(record.deferred) ? record.deferred : [];
  facts.deferred = deferred.slice(0, 10);
  const applied = Array.isArray(record.applied) ? record.applied : [];
  // ⚠️ 口径（2026-09-28 实测修正）：`unchanged`（与仓内一致）**不是跳过**——它是"无需分发"的正常态。
  //   首版把 status!=='ok' 全算跳过 ⇒ 现场 366 项里 365 项是 unchanged，"未推项数"完全失真
  //   （而 §5.5 要的正是这个数）。真·跳过 = 交接器 planDispatch 的 `skipped-*`（缺源 / 缺 BOM /
  //   无基线 / 本机已改动）与失败态；其中 `skipped-diverged` / `skipped-unrecorded` / `skipped-no-bom`
  //   属**需人工裁决**，单独计数。
  const isSkipStatus = (s) => /^skipped[-_]/i.test(s) || /^(diverged|failed|error)$/i.test(s);
  const needsHuman = (s) => /^skipped-(diverged|unrecorded|no-bom|missing-src)$/i.test(s);
  const skipped = applied.filter((a) => a && typeof a.status === 'string' && isSkipStatus(a.status))
    .map((a) => ({ key: a.key ?? null, status: a.status, reason: a.reason ?? null, needsHuman: needsHuman(a.status) }));
  facts.skipped = skipped.slice(0, 10);
  facts.skippedCount = skipped.length;
  facts.skippedNeedsHuman = skipped.filter((s) => s.needsHuman).length;
  facts.unchangedCount = applied.filter((a) => a?.status === 'unchanged').length;
  const vols = Array.isArray(record.volumes) ? record.volumes : [];
  facts.volumesOver = vols.filter((v) => v?.overThreshold === true)
    .map((v) => ({ repo: v.repo ?? null, sizeBytes: v.sizeBytes ?? null, thresholdBytes: v.thresholdBytes ?? null }));
  facts.unpushedCount = deferred.length + skipped.length;
  // 红条（§5.5 可见性铁律）：交接陈旧 >24h / 心跳陈旧 >90min / 体积超阈 / 致命告警 / 交接中断
  facts.redBar = [];
  if (facts.redAlerts > 0) facts.redBar.push(`交接单致命告警 ${facts.redAlerts} 条`);
  if (facts.unpushedCount > 0) facts.redBar.push(`未推项 ${facts.unpushedCount}`);
  if (facts.heartbeatStale === true) facts.redBar.push(`心跳陈旧 ${Math.round(facts.heartbeatAgeMs / 60000)}min`);
  for (const v of facts.volumesOver) facts.redBar.push(`仓体积超阈 ${v.repo ?? '?'}`);

  // ---- 渲染
  const mb = (n) => (Number.isFinite(Number(n)) ? `${(Number(n) / 1048576).toFixed(1)}MB` : '?');
  const age = (() => {
    const a = facts.asOfAgeMs;
    if (!Number.isFinite(a)) return '—';
    const h = a / 3600000;
    if (h < 1) return `${Math.round(a / 60000)}min`;
    if (h < 48) return `${h.toFixed(1)}h`;
    return `${(h / 24).toFixed(1)}d`;
  })();
  if (run?.active === true) {
    lines.push(`- ⏳ 交接**进行中**：role=${facts.role ?? '?'}（${run.reason ?? ''}）—— 此刻 P0 闸门回 busy、磁盘层审计暂停处置`);
  } else if (facts.timedOut) {
    lines.push('- 🟡 交接**中断**（未收尾超 TTL）→ 暂停态已自动恢复（§17.2 T8）');
  }
  const staleLevel = (() => {
    const a = facts.asOfAgeMs;
    if (!Number.isFinite(a)) return 'none';
    if (a > 72 * 3600000) return 'red';
    if (a > 24 * 3600000) return 'yellow';
    return 'ok';
  })();
  const asOfIcon = staleLevel === 'red' ? '🔴' : (staleLevel === 'yellow' ? '🟡' : '✅');
  if (staleLevel === 'red') facts.redBar.push('上次完整交接超 72h');
  else if (staleLevel === 'yellow') facts.redBar.push('上次完整交接超 24h');
  if (facts.timedOut) facts.redBar.push('交接中断（暂停态已自动恢复）');
  if (facts.asOf) {
    lines.push(`- ${asOfIcon} 上次完整交接：**${fmtTime(asOfMs)}**（${age} 前）· role=${facts.role ?? '?'} · result=${facts.result ?? '?'}`
      + `${staleLevel === 'red' ? '（**超 72h**，换机前先跑一次完整 Depart/Arrive）' : (staleLevel === 'yellow' ? '（超 24h 面板红条阈值）' : '')}`);
  } else {
    lines.push('- ❔ 上次完整交接时间不可判（`lastSuccessfulHandoffAt` 空缺）');
  }
  if (facts.redAlerts > 0) {
    const reds = alerts.filter((a) => a?.level === 'alert' || a?.level === 'error').slice(0, 3).map((a) => a?.code ?? a?.message ?? '?');
    const uniq = [...new Set(reds)];
    lines.push(`- 🔴 **最近一份交接单**（${facts.finishedAt ? fmtTime(Date.parse(facts.finishedAt)) : '—'}）含 **${facts.redAlerts}** 条致命告警`
      + `（${uniq.join('、')}${facts.redAlerts > uniq.length ? '…' : ''}）—— 需人工裁决；下次成功交接会覆盖它`);
  }
  if (facts.unpushedCount > 0) {
    lines.push(`- 🟡 **未推项 ${facts.unpushedCount} 项**：deferred ${deferred.length} 项`
      + `${deferred.length ? `（${deferred.slice(0, 3).map((d) => String(d).slice(0, 40)).join('；')}）` : ''}`
      + ` · 落地跳过 ${facts.skippedCount ?? skipped.length} 项（其中**需人工裁决 ${facts.skippedNeedsHuman ?? 0} 项**）`
      + `｜另有 ${facts.unchangedCount ?? 0} 项内容一致未分发（正常，不计入）`);
    for (const s of skipped.filter((x) => x.needsHuman).slice(0, 5)) lines.push(`  - ⚠️ 需裁决：\`${s.key ?? '?'}\`（${s.status}${s.reason ? ` · ${String(s.reason).slice(0, 60)}` : ''}）`);
  } else {
    lines.push(`- ✅ 未推项 0 项 · 落地跳过 0 项（${facts.unchangedCount ?? 0} 项内容一致未分发，正常）`);
  }
  if (facts.volumesOver.length) {
    for (const v of facts.volumesOver) {
      lines.push(`- 🔴 仓体积超阈：\`${v.repo ?? '?'}\` ${mb(v.sizeBytes)} > ${mb(v.thresholdBytes)}（§5.4 R6 → 面板红条 + 走治理规程）`);
    }
  }
  const level = (facts.redAlerts > 0 || staleLevel === 'red' || facts.volumesOver.length)
    ? 'red'
    : ((facts.unpushedCount > 0 || staleLevel === 'yellow' || facts.timedOut) ? 'yellow' : 'ok');
  return { ok: true, present: true, level, lines, facts, recordFile };
}

export async function collectSync(opts = {}) {
  const probeRemote = opts.probeRemote !== false;
  const activeSessions = opts.activeSessions ?? null;

  // ⓪ 跨机同步总开关（`~/.dsh/butler-sync-topology.json`）—— **停推仓不是"该推没推"**
  //   2026-10-14 口径打架：仓2 自 2026-10-12 起 `repo2.push=false`（停推是开关刻意为之，
  //   见 docs\方案-跨机骨架三柱与统一开关-20261010-v2.md §5.1 + §6.5-D1），而本函数此前
  //   **只看本地 git 状态**（最后提交时间 + `.git` 体积）⇒ 停推仓因为"不动"反而天天被判
  //   stale（>3 天未推送 → 该 -Push）+ 🔴 配额，将来分不清「新坏 / 旧坏」，还可能误导人
  //   去推一个已被配额撑爆的仓。⇒ 这里只**只读**开关，把「停推仓」从"待办"里摘出来。
  //   ⚠️ 读取器 = tools\dsh-butler\lib\sync-topology.mjs（唯一真源）；取不到 ⇒ 降级为
  //      `pushStopped` 空集，**行为与改动前逐字一致**（绝不因开关读不到而改变判定）。
  //   ⚠️ 为什么动态 import（而非静态）：该件跨机分发可能滞后（同 hot-collect.mjs L471-483
  //      的处置），静态 import 一旦解析失败会让**整份日报崩**（checks.mjs L15-19 的事故注释）。
  let topologyNote = null;
  const pushStopped = new Map();      // 目录名 → 仓键（该仓已按总开关停推）
  try {
    const m = await loadSyncTopology();
    if (!m) {
      topologyNote = 'sync-topology 读取器不可用（停推仓未识别）';
    } else {
      // ⚠️ 2026-10-14 对拍实测修正（候选补丁的 bug）：`topologyPath()` 把入参当**用户 home**，
      //   内部再拼一层 ".dsh"（`path.join(home, ".dsh", TOPOLOGY_FILE_NAME)`）⇒ 传 `dshHome()`
      //   会解析成 `<home>\.dsh\.dsh\butler-sync-topology.json`（不存在）⇒ 永远走降级分支、
      //   **静默不生效**（实测：首轮改后日报里 dsh-sessions 仍印「该 -Push」）。
      //   改用**显式路径**：既尊重 `dshHome()`（测试/金丝雀实例的 DSH_HOME 覆盖），
      //   又用读取器自带的文件名常量（文件名单一真源，不在这里再写一遍字面量）。
      const t = m.readTopology({ path: resolveStatePath(m.TOPOLOGY_FILE_NAME ?? 'butler-sync-topology.json', { home: dshHome() }).path });
      if (!t.ok) {
        topologyNote = `同步拓扑开关不可用（${t.reason}）⇒ 停推仓未识别`;
      } else {
        for (const dir of Object.keys(m.TOPOLOGY_REPO_OF_DIR ?? {})) {
          const r = m.repoPushForDir(t, dir);
          if (r.known && r.push === false) pushStopped.set(dir, r.repo);
        }
      }
    }
  } catch (e) {
    topologyNote = `同步拓扑读取失败（停推仓未识别）：${String(e?.message ?? e).slice(0, 120)}`;
  }

  // ① 各仓新鲜度（自动发现，覆盖 dsh-core / dsh-sessions / dsh-workspace）
  const repos = [];
  let repoErr = null;
  try {
    const ents = fs.readdirSync(BACKUP_ROOT, { withFileTypes: true });
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(BACKUP_ROOT, e.name);
      if (!fs.existsSync(path.join(p, '.git'))) continue;
      const last = gitOut(p, ['log', '-1', '--format=%ci']);
      const stt = gitOut(p, ['status', '-sb']);
      let lastAt = null;
      if (last.ok && last.out) {
        const t = Date.parse(last.out);
        if (Number.isFinite(t)) lastAt = t;
      }
      const tracking = stt.ok ? parseTracking(stt.out.split('\n')[0]) : { ahead: 0, behind: 0 };
      let dirty = 0;
      if (stt.ok) dirty = stt.out.split('\n').slice(1).filter((l) => l.trim()).length;
      repos.push({
        name: e.name,
        lastAt,
        lastLabel: lastAt ? fmtTime(lastAt) : null,
        ahead: tracking.ahead,
        behind: tracking.behind,
        dirty,
        // 停推仓（`topology#repoN.push=false`）：**最后提交陈旧是预期形态，不是待办**
        //   ⇒ stale 强制 false（渲染层据 pushOff 出「已按总开关停推」），原判据留在 staleRaw
        //   备查（面板/将来的消费者仍能拿到"裸判据"，不丢信息）。
        staleRaw: lastAt === null ? null : daysAgo(lastAt) > REPO_STALE_DAYS,
        pushOff: pushStopped.has(e.name),
        pushOffKey: pushStopped.has(e.name) ? `${pushStopped.get(e.name)}.push=false` : null,
        stale: pushStopped.has(e.name) ? false : (lastAt === null ? null : daysAgo(lastAt) > REPO_STALE_DAYS),
        error: last.ok ? null : last.error,
        // 体积 / 配额（2026-09-16 拷问 P1）：口径 = `.git`（与 Gitee 1024MB 配额同量纲），
        // 增速取自热采运行键的 volumeHistory（30 分钟一采样），算"预计 N 小时到 80% 线"。
        volume: (() => {
          try {
            const gitBytes = measureGitVolume(p).bytes;
            // 本地冷备仓（换仓时把老工作副本改名成 `<repo>-old-<yyyymmdd>`）不计 Gitee 配额：
            // ❗它的 `.git/config` 里 remote 仍然在，所以**不能用 remote 判据**（首版就是这么被骗的：
            //   1136.6MB 的老仓被报成 🔴「111% 随时被硬拒」）。判据 = 目录名带 `-old-<8位日期>`。
            const isColdCopy = /-old-\d{8}/.test(e.name);
            if (isColdCopy) {
              return {
                ok: true, repo: e.name, gitBytes, treeBytes: null, noRemote: true,
                thresholdBytes: null, overThreshold: false, quotaBytes: null, quotaRatio: null,
                remainBytes: null, level: 'ok', why: '本地冷备仓（改名 <repo>-old-<日期>），不计 Gitee 配额',
                growth: { mbPerHour: null, hoursToTarget: null, sampleCount: 0, windowHours: null },
              };
            }
            const v = judgeRepoVolume({ repo: e.name, gitBytes });
            let growth = { mbPerHour: null, hoursToTarget: null, sampleCount: 0, windowHours: null };
            try {
              const snap = JSON.parse(fs.readFileSync(resolveStatePath('butler-handoff-hot.json', { home: dshHome() }).path, 'utf8'));
              growth = estimateGrowth(snap?.volumeHistory?.[e.name], gitBytes);
            } catch { /* 运行键缺失/坏 → 只报当前值，不猜增速（绝不编造） */ }
            return { ok: true, ...v, growth };
          } catch (err) {
            return { ok: false, reason: String(err?.message ?? err) };
          }
        })(),
      });
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    repoErr = String(e?.message ?? e);
  }

  // ② git-crypt key
  let key;
  try {
    const st = fs.statSync(KEY_FILE);
    key = { ok: true, exists: true, size: st.size, mtime: st.mtimeMs, level: st.size > 0 ? 'green' : 'red' };
  } catch {
    key = { ok: true, exists: false, size: 0, level: 'red' };
  }
  key.file = KEY_FILE;
  key.cold = COLD_KEY;
  key.coldExists = (() => { try { return fs.existsSync(COLD_KEY); } catch { return false; } })();

  // ③ 远端可达（只报状态；网络未就绪属正常，不告警）——并行探测，单仓 3s 超时
  let remote = { ok: false, reason: '未探测' };
  if (probeRemote) {
    const results = await Promise.all(
      repos.map(async (r) => {
        const p = path.join(BACKUP_ROOT, r.name);
        const g = await gitProbe(p, ['ls-remote', '--heads', 'origin'], 3000);
        return { name: r.name, reachable: g.ok, error: g.ok ? null : g.error };
      })
    );
    remote = { ok: true, anyOk: results.some((x) => x.reachable), results };
  }

  // ④ 双机交接提示（疑似双开）
  const hints = [];
  const behind = repos.filter((r) => r.behind > 0);
  if (behind.length) {
    hints.push(`${behind.map((r) => `${r.name}(落后 ${r.behind})`).join('、')} —— 远端有新内容，换机前先跑 -Pull`);
  }
  if (activeSessions !== null && activeSessions > 0 && behind.length) {
    hints.push(`本机最近 30 分钟有 ${activeSessions} 个会话在写，且远端有未合并内容 → **疑似双开**（两台机同时用 DSH？）`);
  }
  // ⑤ 交接健康 + 记忆库 RPO（P9 §17.2 T5/T6 · 2026-09-15）
  //   **复用本段**（不另造段）：判定口径全在 tools\dsh-butler\lib\handoff-health.mjs，这里只做 IO 采集。
  //   失败降级（ok:false + reason）→ 日报段里显式标注"不可探测"，绝不静默省略。
  let handoff = null;
  try { handoff = await collectHandoffHealth({ now: Date.now() }); }
  catch (e) { handoff = { ok: false, reason: String(e?.message ?? e) }; }
  // ⑥ 采集失败台账（卡 AT16）：同一段复用；判定在 tools\dsh-butler\lib\collect-failure-ledger.mjs
  let collectFailures = null;
  try { collectFailures = await collectCollectFailures({ now: Date.now() }); }
  catch (e) { collectFailures = { ok: false, reason: String(e?.message ?? e) }; }
  return { ok: true, repos, repoError: repoErr, key, remote, hints, activeSessions, handoff, collectFailures };
}

// ---------------------------------------------------------------------------
// 段 4 · 📊 误报率（方案改动 7，v2.4 顺序修正 · 裸跑期依赖）
// 数据源 = butler-watch-state.json（P2 watch 状态）+ butler-falsepositives.jsonl（[3a] 产出）
// [3a] 未完工 → 返回 ok:false，日报渲染「数据源未就绪」空段（schema 就绪后自动生效）。
// ---------------------------------------------------------------------------
/**
 * 从 watch state 里尽力取告警条目。
 * 已对齐 [3a] P2 真实 schema（2026-09-09 实测）：
 *   events: { '<eventKey>': { lastValue, lastSeenAt, lastReportAt, ackToken } }
 *   daily:  { day, pushed, reportOnly, items:[{id, at, level, kind}] }
 *   lastTick: { at, quiet, fired[], pushed[], reportOnly[], deferred[], escalated[], suppressed[] }
 * 兼容旧/未来形态：alerts / items / active 数组或字典。
 */
function extractAlerts(state) {
  const out = [];
  if (!state || typeof state !== 'object') return out;
  const push = (key, v) => {
    if (!v || typeof v !== 'object') return;
    const at = Number(v.at ?? v.ts ?? v.lastSeenAt ?? v.lastReportAt ?? v.lastNotifyAt ?? v.firstAt ?? 0) || null;
    const ackedAt = Number(v.ackedAt ?? v.ackAt ?? 0) || null;
    // 【口径修正 · 2026-09-15 主人拍板「甲」】pushed = 曾真正推送过（需要人 ack）的条目。
    //   依据 P2 权威口径（watch-policy.mjs）：「只有真正推送过的记录（lastNotifyAt > 0）才需要 ack；
    //   🟡 只进日报、无 lastNotifyAt → 不在此列」。旧实现把"只进日报"的事件也算作疑似，疑似数虚高。
    const pushed = Number(v.lastNotifyAt ?? 0) > 0 || v.kind === 'push' || Boolean(v.ackToken);
    out.push({ key: v.key ?? v.id ?? key, at, ackedAt, level: v.level ?? null, pushed });
  };
  const buckets = [state.events, state.alerts, state.items, state.active];
  for (const b of buckets) {
    if (Array.isArray(b)) b.forEach((v, i) => push(String(i), v));
    else if (b && typeof b === 'object') for (const [k, v] of Object.entries(b)) push(k, v);
  }
  // 当天告警流（daily.items）只在 events/alerts 都为空时兜底，避免与事件表重复计数
  if (out.length === 0 && Array.isArray(state.daily?.items)) {
    state.daily.items.forEach((v, i) => push(String(i), v));
  }
  return out;
}

export function collectFalsePositive(opts = {}) {
  const watchFile = opts.watchFile ?? resolveStatePath('butler-watch-state.json', { home: dshHome() }).path;
  const fpFile = opts.fpFile ?? resolveStatePath('butler-falsepositives.jsonl', { home: dshHome() }).path;
  const hasWatch = fs.existsSync(watchFile);
  const hasFp = fs.existsSync(fpFile);
  if (!hasWatch && !hasFp) {
    return {
      ok: false,
      ready: false,
      watchFile, fpFile,
      reason: '数据源未就绪（P2 观测状态与误报台账由卡 [3a] P2 产出）'
    };
  }
  const state = hasWatch ? readJsonSafe(watchFile) : null;
  const alerts = extractAlerts(state);
  const fpLines = hasFp ? (readLines(fpFile) ?? []) : [];
  const fpRecords = [];
  for (const l of fpLines) {
    try { fpRecords.push(JSON.parse(l)); } catch { /* 坏行跳过 */ }
  }
  const fpKeys = new Set();
  for (const r of fpRecords) {
    const k = r?.key ?? r?.eventKey ?? r?.id ?? null;
    if (k) fpKeys.add(String(k));
  }
  const now = Date.now();
  const cut = now - UNACK_SUSPECT_HOURS * 3600000;
  let marked = 0;
  let suspect = 0;
  for (const a of alerts) {
    const isMarked = (a.key && fpKeys.has(String(a.key))) || (a.level === 'false-positive');
    if (isMarked) { marked++; continue; }
    // 疑似 = **曾推送过**且未标误报、未 ack、超 4h（口径同 tools\dsh-butler\barewatch-tick.mjs，2026-09-15 甲）
    if (a.pushed && !a.ackedAt && a.at && a.at < cut) suspect++;
  }
  // 未匹配到事件键的误报记录也算标记数（宽松口径，避免丢计数）
  const unmatchedFp = fpRecords.filter((r) => {
    const k = r?.key ?? r?.eventKey ?? r?.id ?? null;
    return !k || !alerts.some((a) => String(a.key) === String(k));
  }).length;
  const markedTotal = marked + unmatchedFp;
  const totalAlerts = alerts.length;
  // 累计告警数：优先 P2 的计数器；没有则退化为「当前事件数」并标注口径（[3a] 后续补 counters 自动生效）
  let cumulative = Number(state?.counters?.alerts ?? state?.counters?.totalAlerts ?? state?.totalAlerts ?? 0) || 0;
  let cumulativeSource = 'P2 counters';
  if (!cumulative) {
    const d = Number(state?.daily?.cumulative ?? state?.daily?.total ?? 0) || 0;
    if (d) { cumulative = d; cumulativeSource = 'P2 daily'; }
  }
  if (!cumulative) { cumulative = totalAlerts; cumulativeSource = '当前事件数（P2 未提供累计计数器）'; }
  const rate = totalAlerts > 0 ? markedTotal / totalAlerts : null;
  const suspectRate = totalAlerts > 0 ? suspect / totalAlerts : null;
  const enough = cumulative >= FP_MIN_SAMPLES;
  let verdict = '样本不足（累计告警 <' + FP_MIN_SAMPLES + '）→ 不放行 P3';
  if (enough) {
    if (rate !== null && rate > FP_WARN_RATE) verdict = '超警戒线（>10%）→ 回头调判定规则';
    else if (suspectRate !== null && suspectRate > FP_WARN_RATE) verdict = '疑似误报超警戒线（>10%）→ 不放行 P3';
    else if (rate !== null && rate < FP_GATE_RATE && (suspectRate ?? 1) <= FP_WARN_RATE) verdict = '达标（<5%）→ 可考虑放行 P3（需主人拍板）';
    else verdict = '未达标 → 继续裸跑调规则';
  }
  return {
    ok: true,
    ready: true,
    watchFile, fpFile, hasWatch, hasFp,
    totalAlerts, marked: markedTotal, suspect, rate, suspectRate,
    cumulative, cumulativeSource, enough, verdict,
    watchSchema: state?.schemaVersion ?? null
  };
}

// ---------------------------------------------------------------------------
// 段 5 · 📊 干活统计（改动 6，周报用）
// 本周完成/失败卡数（ledger）+ 中断会话数（快照）+ token 周环比（P3 归因，未就绪则降级）
// + 主人干预次数（P5 审计流水按窗口过滤，口径同 lib/state.js collectAuditStats）
// ---------------------------------------------------------------------------
const AUDIT_DIR = path.join(dshHome(), 'butler-audit');
/** P3 归因用量日志（方案 §4 P3：数据落 docs\变更流水 旁）——未完工时读不到即降级。 */
export const TOKEN_USAGE_FILE = resolveStatePath('butler-token-usage.json', { home: dshHome() }).path;

/** 审计流水窗口统计（只读 JSONL；按 at 过滤）。 */
export function collectInterventions({ startMs = 0, endMs = Date.now() } = {}) {
  const out = { ok: true, blocks: 0, passes: 0, postBlocks: 0, pauses: 0, forces: 0, files: 0, records: 0, e2eSkipped: 0 };
  let names;
  try { names = fs.readdirSync(AUDIT_DIR).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().slice(-3); } catch {
    return { ...out, ok: false, reason: '审计流水目录不可读' };
  }
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(AUDIT_DIR, n), 'utf8'); } catch { continue; }
    out.files++;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.type !== 'audit-guard') continue;
      const at = Date.parse(rec.at ?? '');
      if (!Number.isFinite(at) || at < startMs || at > endMs) continue;
      // e2e 自测探针记录滤除（口径与 lib/state.js collectAuditStats 同源，判据不复制）
      if (isAuditE2eNoise(rec)) { out.e2eSkipped++; continue; }
      out.records++;
      switch (rec.action) {
        case 'block': out.blocks++; break;
        case 'post-block': out.postBlocks++; break;
        case 'pass': out.passes++; break;
        case 'audit-pause': out.pauses++; break;
        case 'audit-resume': break;
        case 'issue-token': if (rec.forced) out.forces++; break;
        default: break;
      }
    }
  }
  return out;
}

/**
 * token 周环比（P3 归因数据）。
 * 契约：`~/.dsh/butler-token-usage.json` = `{ schemaVersion:1, days: { "YYYY-MM-DD": { total, bySession?, cacheRead?, reasoning? } } }`
 * P3 未完工 → 文件不存在 → 返回 ok:false（周报降级一行「数据源未就绪」）。
 */
export function collectTokenWeekly({ startMs, endMs, prevStartMs, prevEndMs } = {}) {
  if (!fs.existsSync(TOKEN_USAGE_FILE)) {
    return { ok: false, ready: false, file: TOKEN_USAGE_FILE, reason: '数据源未就绪（P3 归因未完工）' };
  }
  const j = readJsonSafe(TOKEN_USAGE_FILE);
  const days = j?.days ?? {};
  const sum = (a, b) => Object.entries(days)
    .filter(([d]) => { const t = Date.parse(d); return Number.isFinite(t) && t >= a && t <= b; })
    .reduce((acc, [, v]) => acc + (Number(v?.total) || 0), 0);
  const cur = sum(startMs ?? 0, endMs ?? Date.now());
  const prev = sum(prevStartMs ?? 0, prevEndMs ?? 0);
  const delta = prev > 0 ? (cur - prev) / prev : null;
  return { ok: true, ready: true, file: TOKEN_USAGE_FILE, cur, prev, delta };
}
/**
 * 段 6 · 🌐 外部信号（P6 会望风，卡 [7]）
 * 契约：`~/.dsh/butler-external-state.json` 的 `digest`（由 butler-external.mjs 每轮写）。
 * P6 未部署 → 文件不存在 → 返回 ok:false（日报降级一行「数据源未就绪」）。
 * 只读，不触发采集、不推任何东西（采集归计划任务 DSH-Butler-External）。
 * 2026-09-12：路径支持 `DSH_BUTLER_EXTERNAL_STATE_FILE` 覆盖 —— **仅供端到端夹具**（隔离 home 验收
 *   「造新凭证 → 日报出现探源建议」时留的显式注入点）。
 * 2026-09-14：本模块的 DSH 数据根改走 dshHome()（BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）现读解析，
 *   测试/金丝雀实例下不再需要该覆盖变量也能读到自己的 home（覆盖变量保留、优先级不变）。
 */
/**
 * 【2c · S4 前置 · 2026-10-19】外部信号状态路径（唯一解析器 = `state-paths.mjs#resolveStatePath`）：
 *   `DSH_BUTLER_EXTERNAL_STATE_FILE` 夹具覆盖优先（既有契约，端到端验收依赖它），其余走统一解析。
 *   legacy / 双名并存期解析结果与原来的 path.join(home, name) 逐字节相同；
 *   S4 切 mode=new 后自动跟到 `ops-external-state.json`。
 */
export function externalStateFilePath() {
  return process.env.DSH_BUTLER_EXTERNAL_STATE_FILE
    || resolveStatePath('butler-external-state.json', { home: dshHome() }).path;
}
/** 兼容旧导出（模块加载期快照）；运行时读数请用 externalStateFilePath()。 */
export const EXTERNAL_STATE_FILE = externalStateFilePath();
/** 旧单文件名（兼容期回退用）；本机实际注册表见 resolveExternalSourcesFile()。 */
export const EXTERNAL_SOURCES_FILE = path.join(dshHome(), 'external-sources.json');

/**
 * 本机源注册表路径（host 分文件，2026-09-11）：
 *   `external-sources-<host>.json` 存在则用它（新写法）；否则回落旧单文件名
 *   （对端侧升级前 / 本地还没跑过新版 tick）。判定口径与 dsh-butler/lib/host-tag.mjs 一致。
 */
export function resolveExternalSourcesFile() {
  const tag = String(os.hostname() ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  const hostFile = path.join(dshHome(), `external-sources-${tag}.json`);
  try { if (fs.existsSync(hostFile)) return hostFile; } catch { /* 回退旧名 */ }
  return EXTERNAL_SOURCES_FILE;
}

export function collectExternal({ now = Date.now() } = {}) {
  // 【2c · S4 前置】每次现解析（下方判定 / 文案一字未动：局部名沿用旧常量名）
  const EXTERNAL_STATE_FILE = externalStateFilePath();
  if (!fs.existsSync(EXTERNAL_STATE_FILE)) {
    return { ok: false, ready: false, file: EXTERNAL_STATE_FILE, reason: '数据源未就绪（P6 会望风未部署）', items: [], failing: [] };
  }
  const st = readJsonSafe(EXTERNAL_STATE_FILE);
  if (!st || typeof st !== 'object') {
    return { ok: false, ready: false, file: EXTERNAL_STATE_FILE, reason: '状态文件不可读或不是合法 JSON', items: [], failing: [] };
  }
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const digest = st.digest ?? {};
  const items = (digest.day === today ? (digest.items ?? []) : []).map((x) => ({
    id: x.id, level: x.level ?? 'yellow', title: x.title ?? '', detail: x.detail ?? '', url: x.url ?? null,
    at: x.at ?? null, delivered: x.delivered ?? null,
  }));
  const sources = (digest.sources ?? []).map((s) => ({
    id: s.id, ok: s.ok !== false, skipped: s.skipped === true, failCount: Number(s.failCount ?? 0), note: s.note ?? null,
  }));
  const failing = sources.filter((s) => s.failCount >= 3);
  let sourceCount = 0;
  let enabledCount = 0;
  try {
    const reg = readJsonSafe(resolveExternalSourcesFile());
    sourceCount = (reg?.sources ?? []).length;
    enabledCount = (reg?.sources ?? []).filter((s) => s.enabled !== false).length;
  } catch { /* 注册表不可读不影响本段 */ }
  return {
    ok: true,
    ready: true,
    file: EXTERNAL_STATE_FILE,
    lastTickAt: st.lastTickAt ?? null,
    tickCount: Number(st.tickCount ?? 0),
    day: digest.day ?? null,
    items,
    reds: items.filter((x) => x.level === 'red').length,
    yellows: items.filter((x) => x.level === 'yellow').length,
    failing,
    suppressed: Number(digest.suppressed ?? 0),
    muted: digest.muted ?? [],
    sourceCount,
    enabledCount,
    // 自动探源（2026-09-12）：候选 / 未知供应商 / 未覆盖渠道 —— 只读 state.discovery，不做任何探测
    discovery: readDiscovery(st, now),
  };
}

/** 自动探源摘要（只读；7 天内的复核结果才展示，免天天占日报一行）。 */
export function readDiscovery(st, now = Date.now()) {
  const d = st?.discovery;
  if (!d || typeof d !== 'object') return null;
  const lastRunAt = Number(d.lastRunAt ?? 0);
  if (!lastRunAt || now - lastRunAt > 7 * 86_400_000) return null;
  const candidates = (d.probed ?? []).filter((p) => p.ok).map((p) => ({ id: p.id, detail: p.detail ?? null, url: p.url ?? null, kind: p.kind ?? null }));
  const unknown = d.unknown ?? [];
  const unmatched = (d.unmatchedChannels ?? []).map((u) => ({ provider: u.provider, baseURL: u.baseURL ?? null, keyRef: u.keyRef ?? null, candidates: (u.candidates ?? []).map((c) => c.url) }));
  const pending = Number(d.pending ?? 0);
  if (!candidates.length && !unknown.length && !unmatched.length && !pending) return null;
  return { lastRunAt, reason: d.reason ?? null, candidates, unknown, unmatched, pending, failures: Number(d.failures ?? 0) };
}

// ---------------------------------------------------------------------------
// ⏳ 待你操作（2026-09-17 新增 · 主人拍板「日报加一段」）
// 痛点：会话标题的【完成】只表示"这一轮说完了"，≠"活闭环"；真正等主人动手的事
//（换机器执行 / 点 GUI / 拍板授权）散落在看板卡 description、交接文档、给对端机的执行单里。
// 数据源 = docs\待你操作-<设备>.md（由 tools\owner-todo-scan.mjs --write 生成）；本函数只读它 + 统计。
export function collectOwnerTodos() {
  // 设备标签：可用 DSH_DEVICE_TAG 显式指定，否则用主机名（文件名形如 `待你操作-<标签>.md`）。
  const dev = (process.env.DSH_DEVICE_TAG ?? '').trim() || os.hostname();
  const file = path.join(DSH_ROOT, 'docs', `待你操作-${dev}.md`);
  try {
    if (!fs.existsSync(file)) return { ok: true, dev, exists: false, file };
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, 'utf8');
    const secCounts = [...text.matchAll(/^## [^\n]*·\s*(\d+)\s*[张份项]/gm)].map((m) => Number(m[1]));
    return {
      ok: true, dev, exists: true, file,
      gen: (text.match(/生成 \*\*([^*]+)\*\*/) || [])[1] ?? null,
      ageHours: (Date.now() - st.mtimeMs) / 3600000,
      total: secCounts.reduce((a, b) => a + b, 0),
      entries: [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1]).slice(0, 6),
    };
  } catch (e) {
    return { ok: false, dev, file, error: String(e?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------
// 📜 文档纪律 · 豁免台账（家规第 10 条）—— C4·卡乙 · 2026-09-28 新增
// 背景：台账 `~/.dsh/butler-doc-discipline.json` 此前**零读取器**（备料 §四 G-3 实证：
//   `recallDueBy` 全工具面只出现 1 次、就在一句注释里）⇒「7 天未补审 ⇒ 告警」的到期账没人算。
// 本函数 = 日报段的**取数半边**（渲染在 report.mjs）；口径与算法**复用同一份真源实现**
//   （`tools\dsh-butler\butler-doc-discipline-cli.mjs`，动态 import ⇒ 取不到就降级「不可探测」，
//    绝不让插件启动链/日报因为一个工具文件缺失而崩）。
// 只读：不改台账、不查卡状态（卡状态不在只读面）；任何失败降级，绝不中断日报。
// opts.ledgerPath / opts.today 仅用于单测注入（生产不传）。
export async function collectDocDiscipline(opts = {}) {
  const home = (process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || '').trim();
  const file = opts.ledgerPath ?? resolveStatePath('butler-doc-discipline.json', { home: home ? path.resolve(home) : path.join(os.homedir(), '.dsh') }).path;
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const today = opts.today ?? `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
  try {
    const { readLedger, evaluateRecord } = await importButlerFile('butler-doc-discipline-cli.mjs');
    const led = readLedger(file);
    if (!led.ok) return { ok: false, file, today, error: led.error };
    const recs = led.records.map((r) => evaluateRecord(r, today));
    const due = recs.filter((r) => r.status === 'overdue' || r.status === 'due-today');
    const dated = recs.filter((r) => r.daysLeft !== null).sort((a, b) => a.daysLeft - b.daysLeft);
    const nearest = dated[0] ?? null;
    return {
      ok: true, file, today, bytes: led.bytes, shape: led.shape, count: recs.length,
      overdue: due.filter((r) => r.status === 'overdue').length,
      dueToday: due.filter((r) => r.status === 'due-today').length,
      pending: recs.filter((r) => r.pendingCard).length,
      hardBad: recs.filter((r) => r.missingHard.length).length,
      nearest: nearest ? { recallCardId: nearest.recallCardId, recallDueBy: nearest.recallDueBy, daysLeft: nearest.daysLeft, status: nearest.status } : null,
      alarmTexts: [...new Set(due.map((r) => r.alarm).filter(Boolean))],
    };
  } catch (e) {
    return { ok: false, file, today, error: String(e?.message ?? e) };
  }
}

export async function collectDailyExtras() {
  const [preflight, structure, sync, falsePositive, external] = await Promise.all([
    collectPreflight().catch((e) => ({ ok: false, error: String(e?.message ?? e), items: [] })),
    Promise.resolve().then(collectStructure).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    Promise.resolve().then(() => collectSync({ activeSessions: safeActive() })).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    Promise.resolve().then(collectFalsePositive).catch((e) => ({ ok: false, reason: String(e?.message ?? e) })),
    Promise.resolve().then(() => collectExternal()).catch((e) => ({ ok: false, reason: String(e?.message ?? e), items: [], failing: [] }))
  ]);
  const closure = await collectClosureLinks().catch((e) => ({ ok: false, reason: String(e?.message ?? e) }));
  structure.closure = closure;
  let ownerTodos;
  try { ownerTodos = collectOwnerTodos(); } catch (e) { ownerTodos = { ok: false, error: String(e?.message ?? e) }; }
  let docDiscipline;
  try { docDiscipline = await collectDocDiscipline(); } catch (e) { docDiscipline = { ok: false, error: String(e?.message ?? e) }; }
  return { preflight, structure, sync, falsePositive, external, ownerTodos, docDiscipline };
}
function safeActive() {
  try { return activeSessionCount(30); } catch { return null; }
}
