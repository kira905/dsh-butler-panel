// dsh-butler-panel / lib/state.js
// 大管家只读聚合：① 任务看板在途/待办/挂起超时 ② 被打断的会话（时间窗口 + 回合未闭合双判据）
// ③ 变更流水尾部（v0.2.0 起倒序渲染，最新在最上）④ 记忆脉搏（node:sqlite 只读）
// ⑤ 健康监控（v0.2.0 新增：会话自动归档状态 + 升级体检汇总，均只读）。
// 零 npm 依赖（Node ≥22 自带 node:sqlite）。供 lib/index.js（route）与 verify.mjs（standalone）复用；
// 任何一段失败都降级不影响整体。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
// 宿主适配层（**唯一允许出现主包事件名/服务名的地方**）。
// 本文件用的是它的**派生副本**（由 tools/sync-host-adapter.mjs 幂等生成，R5 守门副本 sha
// 与唯一源一致，勿手改）——同 dshHome() 内联的因：插件实体可能被单独拷到别的机器，必须独立可跑。
// 迁移（2026-09-14，卡「升级 B2」①，adapter 方案 P1 批）：本文件原有的事件名白名单 /
// 回合外集合 / 正常收尾 kind / 尾部中文标签五处字面量全部改为消费适配层词表与族判定。
import * as eva from './host-adapter.mjs';
// 会话日志文件名判据 / 「取哪份」取法 —— **生态唯一源**（★2026-09-24 本批统一，见下方 newestSessionLog 上方长注）。
// 跨包一律走 ./butler-root.mjs 解析（路径由环境变量决定，源码里不留本机绝对目录；
// 相对 import 会在部署到 profile 后解析成不存在的包 ⇒ 门禁①直接挡）。
import { importButlerLib, importToolLib, workspaceRoot, butlerLibPath, asUrl, statePathResolver } from './butler-root.mjs';
const { SESSION_FILE_RE, pickSessionFileInDir } = await importToolLib('session-file-name.mjs');
// 【2c · 2c-B5】状态路径统一入口（legacy 期与 path.join(dshHome(), name) 逐字节相同）。
const resolveStatePath = await statePathResolver();
// 【G33·加急档 · A4 可见性 · 2026-09-29】「加急档当日额度」只读视图（`butler-restart-state.json`
//   顶层 `urgent` 段 → 一行文案）。路径解析走 `tools\lib\dsh-home.mjs`（唯一源）、上限与闸门结论走
//   `dsh-butler\lib\restart.mjs#resolveUrgentDailyQuota`（判据层纯函数，不抄默认值）；fail-open，
//   空态（段不存在 = 常态）与不可读态都有显式文案。本体在 lib\urgent-quota.js（自带单测）。
import { collectUrgentQuota } from './urgent-quota.js';

export const API_PREFIX = '/api/dsh-butler';
export const PANEL_ID = 'dsh-butler-panel';

// ---------------------------------------------------------------------------
// 路径（全环境变量，双机同构）
//
// dshHome()：DSH 数据根**单点解析**，口径 = BUTLER_DSH_HOME > DSH_HOME > ~/.dsh
//   （与 tools/lib/dsh-home.mjs 的 resolveDshHome、tools/dsh-butler/lib/paths.mjs 的
//     dshHome() 同源；本文件刻意内联这一行而不 import，是因为插件实体可能被单独拷到
//     别的机器、必须独立可跑，import 会引入 tools\ 树的存在性依赖）。
//   ★2026-09-14 环境边界修复（卡：自研组件去 os.homedir() 硬编码）：此前是
//     `const HOME = os.homedir()` + **模块加载期求值**，于是测试/金丝雀实例
//     （DSH_HOME=D:\DSH-offsync\DSH-test\.dsh）加载本插件时，读写的仍是**生产 ~/.dsh**
//     —— 面板显示的会话数/看板/记忆全是生产数据，环境边界等于没生效。
//     现改为**每次调用现读**（进程 env 在启动时已注入，现读即可见），
//     且不设环境变量时结果与改造前逐字节一致（~/.dsh）。
// ---------------------------------------------------------------------------
function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}
/**
 * 工作区根（放 docs\ 的那棵树）：$DSH_WORKSPACE > 由 home 推导（**仅当 home 被环境变量
 * 重定向到 <某目录>\.dsh 这种"测试实例"形态**）> <用户主目录>/DSH。
 * ⚠️ 判据是「env 显式指向了非默认 home」，不是"路径层数够"——默认 home 也是
 * <用户主目录>\.dsh（3 层），按层数判会把 workspace 错推成 <用户主目录>。
 */
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
/** 管家报告目录：$BUTLER_REPORT_DIR（既有先例）> <workspace>\docs\管家报告。 */
function reportDir() {
  const override = process.env.BUTLER_REPORT_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dshWorkspace(), 'docs', '管家报告');
}
const CHANGELOG_DIR = path.join(dshWorkspace(), 'docs', '变更流水');
const REPORT_DIR = reportDir();
// 常用数据文件：一律**调用时求值**（测试实例改 DSH_HOME 后立刻落在自己的 home）
const sessionsRoot = () => path.join(dshHome(), 'sessions');
const ledgerFile = () => path.join(dshHome(), 'task-board', 'ledger-v2.json');
const memoryDb = () => path.join(dshHome(), 'memory', 'memory.db');
// v1.1：忽略清单（主人标记"已处理/别烦我"的会话与卡）+ 管家报告档案目录
// 【2c · S4 前置 · 2026-10-19】路径改走统一解析（`dsh-butler/lib/state-paths.mjs#resolveStatePath`）：
//   legacy / 双名并存期按 mtime 取（= 仍在被写的旧名，与裸 join 指向同一个文件）；
//   S4 切 mode=new 后旧名不再更新 ⇒ 自动跟到 `ops-ignored.json`（不再静默退化）。
//   ⚠️ 调用时求值：面板长期驻留，不必等下次重启才跟随模式切换。
/** 忽略清单路径（**唯一口径**；index.js 的写口复用本函数，绝不另写一套）。 */
export function ignoreFilePath() {
  return resolveStatePath('butler-ignored.json', { home: dshHome() }).path;
}
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// 挂起超时阈值（todo/backlog 卡 N 天没动 → 提醒）
const OVERDUE_DAYS = 3;
// "疑似中断/挂起"会话窗口：最后活动距今 5 分钟 ~ 3 天 = "最近干过但现在停了"。
// 5 分钟下界排除正在活跃的会话（回合写入持续刷新 mtime）；3 天上界排除老会话
// （GUI 列表一眼即知，不需管家提醒）。不依赖 dsh 启动时刻 → standalone 与服务端一致。
const STALE_MIN_MS = 5 * 60 * 1000;
const STALE_MAX_MS = 3 * 24 * 60 * 60 * 1000;
// 疑似中断清单上限（按最后活动时间倒序取前 N）
const INTERRUPT_CAP = 10;
// v1.4.2 回合闭合判据（2026-09-09 主人点破"闭环一个刷新还是 10 个"后加的）：
// 旧口径只看"5 分钟~3 天内有活动"→ 本机 64 个会话里 60 个都落窗口，CAP=10 恒满额，
// 处理掉一个第 11 个立刻补位，数字永远 10；且已正常收尾的会话也被算成"中断"。
// 实测尾部事件：正常收尾 = turn/end / session/end-seed / session/title；
// 被打断（dsh 重启断活）= tool/call、assistant/chunk、user/message 等"回合中间"事件。
// 采用 OPEN 白名单（保守）：只有尾部明确是回合中间事件才算中断，未知类型一律不算（宁少报不误报）。
//
// 2026-09-14（卡「升级 B2」①）：白名单从"逐个事件名"改为**族前缀**（`assistant/`、`tool/`、
// `step/`、`request/`、`user/`）——主包 0.1.5 删了 `assistant/chunk`、改用 `assistant/attempt`
// 承载同语义，写死名字在 0.1.5 上会让本判据**静默少报**（面板「被打断会话」变 0）。
// 族化后两线同覆盖；族的**语义全集**仍由适配层判定（`isTurnInterior`），面板只保留
// "只认这几族"这一条**策略**（策略归 caller，见 adapter 方案 §3.2）。
const PANEL_OPEN_PREFIXES = ['assistant/', 'tool/', 'step/', 'request/', 'user/'];
// 更早期形态的裸名（无斜杠前缀，现网已不出现），保留以维持旧口径的逐条等价。
const PANEL_OPEN_LEGACY = new Set(['text-chunks', 'tool-call-chunks', 'reasoning-chunks', 'usage']);
function isPanelOpenTail(type) {
  if (typeof type !== 'string' || type === '') return false;
  if (PANEL_OPEN_LEGACY.has(type)) return true;
  for (const p of PANEL_OPEN_PREFIXES) if (type.startsWith(p)) return true;
  return false;
}
// v1.4.4（2026-09-11 修「被打断检测失效」）：回合外事件——出现在 turn/end 之后属正常，
//   判定折叠时**透明跳过**（不当作尾巴）。session/end-seed 尤其关键：它是重启/停机时
//   主包给当时活跃会话补写的收尾标记，常落在被打断会话的最后一条，把真尾巴盖在后面。
//   （集合本身在适配层：`eva.isSessionLevel`）
// turn/end 的「正常收尾」reason.kind（口径同 tools/dsh-butler/lib/restart.mjs）：
//   实测被打断/异常时主包写 turn/end{reason:{kind:'interrupted'|'aborted'|'error'}}，
//   旧实现把 turn/end 一律当"已收尾"→ 被硬杀打断的会话全被漏报。
//   （口径在适配层：`eva.NORMAL_TURN_END_KINDS`）
// 尾部事件类型 → 人话标签（前端显示"卡在哪"）；事件名一律取自适配层词表/族，本文件不写死。
function tailLabelOf(type) {
  if (type === eva.EV.TOOL_CALL) return '工具调用中';
  if (type === eva.EV.TOOL_RESULT) return '工具结果未回';
  if (eva.isAssistantProduction(type)) return '回答写到一半';
  if (type === eva.EV.USER_MESSAGE) return '消息发出无回复';
  if (typeof type === 'string' && type.startsWith('step/')) return '步骤未收尾';
  if (typeof type === 'string' && type.startsWith('request/')) return '请求发出未返回';
  if (PANEL_OPEN_LEGACY.has(type)) return '计费事件未收尾';
  return '回合未收尾';
}
/**
 * 「被打断会话」的人话标签（v1.4.4 细分，主人 2026-09-11 提「要分清是重启害的、还是我自己停的」）。
 * 实测尾巴三种：turn/end{kind:'interrupted'}（重启/停机硬杀）、
 *   turn/end{kind:'aborted', reason:{kind:'user'}}（主人在 GUI 点停止）、
 *   turn/end{kind:'error', error:{message}}（异常结束，曾见 SQLite 损坏）。
 */
export function interruptTailLabel(f) {
  if (f?.state !== 'interrupted') return tailLabelOf(f?.tailType);
  const kind = f.kind ?? 'interrupted';
  if (kind === 'interrupted') return '被硬杀 / 重启打断（turn/end interrupted）';
  if (kind === 'aborted' && f.subKind === 'user') return '主人手动中止（aborted · user）';
  if (kind === 'aborted') return `回合被中止（turn/end aborted${f.subKind ? ' · ' + f.subKind : ''}）`;
  if (kind === 'error') {
    const msg = f.errMsg ? '：' + String(f.errMsg).replace(/\s+/g, ' ').slice(0, 60) : '';
    return `回合异常结束（turn/end error${msg}）`;
  }
  return `回合被中断（turn/end ${kind}）`;
}
// 变更流水“今日有记”判定：行首 “- HH:MM” 或 “## MM-DD” 匹配今天
// 【卡 0 · B6①（2026-09-14 修）】原先是 `const TODAY = new Date()` —— **模块加载期求值一次**：
//   面板进程（dsh 内插件）与 tickd 都是长跑进程，跨零点后「今日」永远停在启动那天，
//   表现为日报/面板整夜报「变更今日无」（跨零点判定永久错误，且无法单测）。
//   现在收敛成下面三个**纯函数**（可注入 now），「今日有记」与「今日段」判定共用同一口径；
//   调用方一律**每次现算**（默认参数 = Date.now()），不再有模块级时间常量。
/** 本地时区日键 `YYYY-MM-DD`（无效输入 → null）。跨零点判定的唯一口径。 */
export function localDayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 两个时间戳是否落在同一个**本地**自然日（now 可注入 → 可单测跨零点，不许靠真实等待）。 */
export function isSameLocalDay(a, b = Date.now()) {
  const ka = localDayKey(a);
  return ka !== null && ka === localDayKey(b);
}
/** 变更流水「今日有记」判据：文件 mtime 与 now 是否同本地日。 */
export function changedTodayOf(mtimeMs, now = Date.now()) {
  if (mtimeMs === null || mtimeMs === undefined) return false;
  return isSameLocalDay(mtimeMs, now);
}

// ---------------------------------------------------------------------------
// 小工具（各段 try/catch 降级）
// ---------------------------------------------------------------------------
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/**
 * 会话接力（阶段 1）· 面板**只读展示**（2026-09-22 卡 S1 新增）。
 *
 * 边界（守"只加只读展示、不动告警逻辑"）：
 *   · **不做任何判定** —— 闸门/孤儿/宽限期等判定一律在 `<workspace>/tools/session-relay.mjs`；
 *     这里只**照原样读出**台账两个载体与锁文件计数（`?parts=` 分片路径用 `relayPanelSummary()`，两者同名字段）。
 *   · 零写动作、零网络；读不到 ⇒ 字段保持 null / 0（面板显示"不可探测"）。
 */
function readRelayPanelLite() {
  const home = dshHome();
  const out = { asOf: new Date().toISOString(), pendingHandoff: null, inFlight: null, lockFiles: 0, note: '只读展示；判定在 session-relay.mjs' };
  try {
    const led = JSON.parse(fs.readFileSync(resolveStatePath('butler-relay.json', { home }).path, 'utf8'));
    out.pendingHandoff = led?.pendingHandoff ?? null;
    out.inFlight = led?.inFlight ?? null;
  } catch { /* 无台账 / 解析失败 ⇒ 保持 null（面板显示不可探测） */ }
  try {
    out.lockFiles = fs.readdirSync(home)
      .filter((n) => n.startsWith('butler-relay.') && n.endsWith('.inflight')).length;
  } catch { /* 读不到目录 ⇒ 0 */ }
  return out;
}
const DAY = 24 * 60 * 60 * 1000;
function ago(ts, now = Date.now()) {
  if (!ts) return '';
  const d = Math.floor((now - ts) / DAY);
  if (d <= 0) {
    const h = Math.floor((now - ts) / 3600000);
    if (h <= 0) return '刚刚';
    return `${h} 小时前`;
  }
  return `${d} 天前`;
}
function shortDate(ts) {
  try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

// ---------------------------------------------------------------------------
// ① 任务看板（直读 ledger-v2.json —— Host 原子 rename 写，只读读到的是完整版本）
// ---------------------------------------------------------------------------
const TASK_FIELDS = (t) => ({
  id: t.id,
  title: t.title || '(无标题)',
  status: t.status,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  schedule: t.schedule?.enabled ? (t.schedule.cron ?? '') : '',
  perm: t.permission ?? ''
});

function collectTasks() {
  const ledger = readJson(ledgerFile());
  if (!ledger || !Array.isArray(ledger.tasks)) return { revision: 0, tasks: [] };
  const now = Date.now();
  const all = (ledger.tasks ?? []).map(TASK_FIELDS);
  const by = (s) => all.filter((t) => t.status === s).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const pending = all.filter((t) => t.status === 'todo' || t.status === 'backlog');
  const overdue = pending.filter((t) => (t.updatedAt ?? 0) < now - OVERDUE_DAYS * DAY)
    .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)); // 最久没动的在前
  const recentClosed = all.filter((t) => (t.status === 'done' || t.status === 'failed') && (t.updatedAt ?? 0) > now - 7 * DAY)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return {
    revision: ledger.revision ?? 0,
    running: by('running').slice(0, 10),
    todo: pending.filter((t) => t.status === 'todo').slice(0, 12),
    backlog: by('backlog').slice(0, 6),
    overdue: overdue.slice(0, 12),
    recentClosed: recentClosed.slice(0, 8)
  };
}

// ---------------------------------------------------------------------------
// ② 疑似中断/挂起会话检测（客观时间戳，不依赖任何会话活着，也不依赖 dsh 启动时刻）
//   sessions/<workspace-slug>/session-<id>/<同族日志> 的 mtime
//   落在 (now-3天, now-5分钟) → "最近干过但现在停了"（被 dsh 重启打断 / 挂起忘续）。
// ---------------------------------------------------------------------------
// 同族日志文件名的**唯一判据** —— ★2026-09-24（大管家之外·收尾清账批）：面板此前**自造了第二份正则**
//   （`/^session(\.[A-Za-z0-9]+)?\.jsonl\.zstd$/`），与生态真源 `tools\lib\session-file-name.mjs`
//   成"两份实现"：改一处忘另一处就是判据静默过期（同类静默失效本生态已多次发生）。现改为**直接消费唯一源**：
//   ① 判据 `SESSION_FILE_RE`（唯一源 L46）；② 取法 `pickSessionFileInDir`（唯一源 L108）。
//   **行为差异（有意收窄）**：面板旧正则还认 `session.<任意字母数字>.jsonl.zstd` 这类**脏名**，
//   唯一源只认 `session.jsonl.zstd` / `session.v<N>.jsonl.zstd`（生产实测 0 例脏名触发 ⇒ 收窄无影响）。
//   主包 0.1.5 起会话日志换代 —— 旧 `session.jsonl.zstd` → 新 `session.v3.jsonl.zstd`。
//   一个会话目录里同族文件可能同时存在（换代期），一律取 **mtime 最新**那份：它才是"这个会话最后
//   被写"的那份，下游 tailEvents(file) 必须跟着它走（唯一源内含确定性平局：代际大者 → 名字典序小者）。
//   ⚠️ 别再写死单个名字：2026-09-24 生产实测 227 个会话目录**全部只有**新名 ⇒ 写死旧名时本列表
//      恒 0 条（面板「被打断会话」整整一代主包都是空的），而同一判据换名后应报 12 条。
// 本常量**导出**给 lib/checks.mjs#activeSessionCount 复用（同一个判据、同一份实现，别复制第二份）。
export const SESSION_LOG_RE = SESSION_FILE_RE;

/** 会话目录里同族日志文件中 mtime 最新的那份（无则 null）。取法走唯一源（含确定性平局）。 */
function newestSessionLog(dir) {
  const file = pickSessionFileInDir(dir);
  if (!file) return null;
  try { return { file, mtimeMs: Math.round(fs.statSync(file).mtimeMs) }; } catch { return null; }
}

function listSessionFiles(root = sessionsRoot()) {
  const out = [];
  let groups;
  try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupDir = path.join(root, g.name);
    let dirs;
    try { dirs = fs.readdirSync(groupDir, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      // ⚠️ `session-` 前缀过滤是**有意**的，不是历史残留：subagent 子会话目录是纯 uuid
      //    （header.origin === 'subagent'，2026-09-24 实测生产 25/227），它们不该进主人可见的
      //    「被打断会话」清单。放宽前缀会把子会话混进来 —— 别顺手改。
      if (!d.isDirectory() || !d.name.startsWith('session-')) continue;
      const hit = newestSessionLog(path.join(groupDir, d.name));
      if (!hit) continue;
      out.push({
        sessionId: d.name.slice('session-'.length),
        group: g.name,
        mtime: hit.mtimeMs,
        file: hit.file
      });
    }
  }
  return out;
}

// 会话「尾部事件链」：从文件尾部往前找完整 zstd 帧 → 解出最近 N 条事件（新 → 旧）。
// 只读尾部 4MB（足够）；缓存键=路径，mtime+size 都变才重扫；
// v1.4.4（2026-09-11）：旧实现 lastEvent 只取"最后一条事件的 type"，两个坑：
//   ① 重启/停机补写的 session/end-seed 无回合语义却排在最后 → 真正的尾巴被盖住；
//   ② turn/end 的 reason.kind 看不到 → 被打断（interrupted/aborted/error）被判成正常收尾。
//   → 改为取多条自己折叠（见 classifyTailChain）。
const TAIL_CACHE = new Map();
export function tailEvents(file, want = 6) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cached = TAIL_CACHE.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.want >= want) return cached;
  const span = Math.min(st.size, 4 * 1024 * 1024);
  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, st.size - span);
    fs.closeSync(fd);
  } catch { return null; }
  const starts = [];
  for (let i = 0; ;) {
    const idx = buf.indexOf(ZSTD_MAGIC, i);
    if (idx === -1) break;
    starts.push(idx);
    i = idx + 4;
  }
  const events = [];
  for (let k = starts.length - 1; k >= 0 && events.length < want; k--) {
    const from = starts[k];
    // v1.4.4：单帧起解（不再按"下一个 magic"截断）——同 scanSessionTitle 的因：
    //   截断点常常就是下一帧帧头，而压缩数据里出现假 magic 时还会把真帧切坏；
    //   zstd 解压器只解第一帧、忽略尾部剩余字节，所以这样更稳。
    let dec;
    try { dec = zstdDecompressSync(buf.subarray(from)).toString('utf8'); } catch { continue; }
    const lines = dec.split('\n');
    for (let j = lines.length - 1; j >= 0 && events.length < want; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && typeof o.type === 'string') {
          const reason = o?.data?.reason ?? null;
          events.push({
            type: o.type, seq: o.seq ?? null, time: o.time ?? null,
            kind: reason?.kind ?? null,
            // v1.4.4 细分用：aborted 的子原因（user = 主人手动中止）/ error 的错误摘要
            subKind: reason?.reason?.kind ?? null,
            errMsg: reason?.error?.message ?? null,
          });
        }
      } catch { /* 半行（正在写），继续往前找 */ }
    }
  }
  const rec = { mtimeMs: st.mtimeMs, size: st.size, want, events };
  TAIL_CACHE.set(file, rec);
  return rec;
}

/** 兼容旧接口：只取最后一条事件（单测与其它消费者用）。 */
export function lastEvent(file) {
  const t = tailEvents(file, 1);
  if (!t) return null;
  const e = t.events[0] ?? null;
  return { mtimeMs: t.mtimeMs, size: t.size, type: e?.type ?? null, seq: e?.seq ?? null, time: e?.time ?? null };
}

/**
 * 尾部回合折叠（面板自包含实现，口径与 tools/dsh-butler/lib/restart.mjs 的 classifyTail 对齐——
 * 插件不跨目录 import tools，两处改动必须同步）：
 *   - turn/end → 读 reason.kind：completed/stop（或无 kind 的老日志）→ closed；
 *                其余（interrupted / aborted / error / …）→ interrupted（回合结束了，但被打断）
 *   - turn/start → open
 *   - session/end-seed → 标记"已终结"后**继续往前找**（重启补写的收尾标记，不具回合语义）
 *   - 回合中间事件（isPanelOpenTail：族前缀）→ open
 *   - 回合外事件（适配层 isSessionLevel：title/goal/change/…）→ 透明跳过
 *   - 扫完仍未命中边界：若见过 end-seed → closed（种子会话已终结，保持旧语义，实测本机
 *     38/38 个 end-seed 会话其前一条回合事件都是 turn/end）；否则 unknown。
 *   - 未知事件类型 → unknown（宁少报不误报，不往前翻旧事件）。
 * ⚠️ 事件名一律经适配层（`eva`）：本文件不再出现主包事件名字面量（R4；2026-09-14 卡「升级 B2」①）。
 * @returns {{state:'open'|'interrupted'|'closed'|'unknown', tailType:string|null, kind:string|null}}
 */
export function classifyTailChain(events) {
  const list = Array.isArray(events) ? events : [];
  let seedSeen = false;
  for (const e of list) {
    if (!e || typeof e.type !== 'string') continue;
    if (eva.isTurnEnd(e.type)) {
      const kind = typeof e.kind === 'string' && e.kind ? e.kind : null;
      const abnormal = kind !== null && !eva.NORMAL_TURN_END_KINDS.has(kind);
      return {
        state: abnormal ? 'interrupted' : 'closed',
        tailType: e.type,
        kind,
        // v1.4.4 细分：aborted 的子原因（user = 主人手动中止）/ error 的错误摘要
        subKind: (typeof e.subKind === 'string' && e.subKind) ? e.subKind : null,
        errMsg: (typeof e.errMsg === 'string' && e.errMsg) ? e.errMsg : null,
      };
    }
    if (eva.isTurnStart(e.type)) return { state: 'open', tailType: e.type, kind: null };
    if (eva.isSessionEnd(e.type)) { seedSeen = true; continue; }
    if (eva.isSessionLevel(e.type)) continue;
    if (isPanelOpenTail(e.type)) {
      // end-seed 是会话终结标记，优先于"回合未闭合"（种子会话本来就可能没有 turn/end）
      return { state: seedSeen ? 'closed' : 'open', tailType: e.type, kind: null };
    }
    // 未知类型（主包将来新增的事件）：宁少报不误报 → 直接判 unknown，不再往前翻旧事件
    return { state: 'unknown', tailType: e.type, kind: null };
  }
  if (seedSeen) return { state: 'closed', tailType: null, kind: null };
  return { state: 'unknown', tailType: null, kind: null };
}

export function detectInterrupted(root = sessionsRoot()) {
  const now = Date.now();
  const lo = now - STALE_MAX_MS;   // 3 天前
  const hi = now - STALE_MIN_MS;   // 5 分钟前
  const files = safe(() => listSessionFiles(root), []);
  const inWindow = files.filter((f) => f.mtime > lo && f.mtime < hi);
  // v1.4.2：窗口内再筛「回合没正常结束」的（尾部事件属于回合中间）→ 真·被打断
  // v1.4.3（2026-09-10）：窗口复核改用「会话内最后事件时间」而非文件 mtime——
  //   mtime 会被外部搬动刷新（仓2 -Sync 把归档会话回流进 sessions，94 个 8 月老会话
  //   的 mtime 变成搬入当天 → 全被误报成"刚被打断"）。eff = 尾部事件 time，缺失才退 mtime。
  // v1.4.4（2026-09-11 修「被打断检测失效」）：
  //   ① 尾巴不再只看最后一条 —— 重启/停机补写的 session/end-seed、标题事件会被跳过；
  //   ② turn/end 读 reason.kind —— interrupted/aborted/error 不再算"已正常收尾"。
  //   实测（本机 96 个窗口内会话）：旧判据报 2 个，新判据报 10 个（漏报 8，含「生图插件画廊画作消失」）。
  const TAIL_EVENT_WANT = 8;
  const open = [];
  let endedRecent = 0;
  let unreadable = 0;
  let staleReflow = 0;
  let interruptedTailCount = 0;
  for (const f of inWindow) {
    const tail = safe(() => tailEvents(f.file, TAIL_EVENT_WANT), null);
    if (!tail || !tail.events.length) { unreadable++; continue; }
    const newest = tail.events[0];
    const eff = typeof newest.time === 'number' && newest.time > 0 ? newest.time : f.mtime;
    if (eff <= lo || eff >= hi) { staleReflow++; continue; }
    const cls = safe(() => classifyTailChain(tail.events), { state: 'unknown', tailType: null, kind: null });
    if (cls.state === 'open' || cls.state === 'interrupted') {
      if (cls.state === 'interrupted') interruptedTailCount++;
      open.push({
        ...f, tailType: cls.tailType ?? newest.type, state: cls.state, eff,
        kind: cls.kind ?? null, subKind: cls.subKind ?? null, errMsg: cls.errMsg ?? null,
      });
    } else endedRecent++;
  }
  const hit = open
    .sort((a, b) => b.eff - a.eff)
    .slice(0, INTERRUPT_CAP);
  // 各工作区最近活跃（供“最近都在哪干活”参考）
  const groupLatest = new Map();
  for (const f of files) {
    const cur = groupLatest.get(f.group) ?? 0;
    if (f.mtime > cur) groupLatest.set(f.group, f.mtime);
  }
  const activeGroups = [...groupLatest.entries()]
    .map(([group, last]) => ({ group, last }))
    .sort((a, b) => b.last - a.last)
    .slice(0, 6);
  return {
    interrupted: hit.map((f) => {
      const eff = f.eff ?? f.mtime;
      const d = Math.floor((now - eff) / 3600000);
      return {
        id: f.sessionId.slice(0, 8),
        fullId: f.sessionId,
        group: f.group,
        title: f.file ? scanSessionTitle(f.file) : '',
        lastActiveAt: eff,
        lastActiveLabel: shortDate(eff),
        idleLabel: d < 1 ? Math.floor((now - eff) / 60000) + ' 分钟前' : d + ' 小时前',
        tailType: f.tailType,
        tailState: f.state ?? 'open',
        tailKind: f.kind ?? null,
        tailSubKind: f.subKind ?? null,
        tailError: f.errMsg ?? null,
        tailLabel: interruptTailLabel(f)
      };
    }),
    activeGroups: activeGroups.map((g) => ({ group: g.group, lastLabel: ago(g.last), last: g.last })),
    // 参考信息：窗口内已正常收尾的会话数（不再进中断清单，只做对比）
    endedRecent,
    scanned: inWindow.length,
    unreadable,
    // v1.4.3：mtime 落在窗口内、但会话内部最后事件时间已超窗的（=被搬动刷新的老会话）
    staleReflow,
    // v1.4.4：其中尾部明确是 turn/end(interrupted/aborted/error) 的（=被硬杀打断，而非回合中间停住）
    interruptedTail: interruptedTailCount
  };
}

// ---------------------------------------------------------------------------
// ③ 变更流水（docs\变更流水\YYYY-MM.md，取最新修改文件尾部）
//   v1.4：除 raw tail 外再解析结构化 items（供前端逐行卡片式渲染，替代一大坨等宽 code）
//   行格式：分组 `## MM-DD`；条目 `- HH:MM 干了啥｜文件/位置｜备份 xxx｜恢复：yyy`（｜分段宽松）；
//   其余 `#`/`>` 归 note（弱化说明）、裸文本归 text。
//   v0.2.0（2026-09-09 主人定「和记忆一样最新在最上面」）：items 输出改倒序——天分组倒序 +
//   组内条目倒序；条目后的续行（`  ↳ ...` 等）归入该条目的 extra，倒序时整块跟着走不串位。
// ---------------------------------------------------------------------------
const CHANGELOG_TAIL = 20;
function parseChangelogLines(lines) {
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const day = line.match(/^##\s*(\d{2}-\d{2})$/);
    if (day) { items.push({ type: 'day', date: day[1] }); continue; }
    const entry = line.match(/^-\s*(\d{1,2}:\d{2})\s*(.*)$/);
    if (entry) {
      const segs = entry[2].split('｜').map((s) => s.trim()).filter(Boolean);
      items.push({ type: 'entry', time: entry[1], main: segs[0] ?? '', meta: segs.slice(1), extra: [] });
      continue;
    }
    const text = /^#+\s*/.test(line) ? line.replace(/^#+\s*/, '').slice(0, 200)
      : line.startsWith('>') ? line.replace(/^>\s*/, '').slice(0, 200)
        : line.slice(0, 200);
    // 续行（紧跟在条目后的说明/缩进行）归上一条 entry，倒序渲染时不会与主条目分离
    const last = items[items.length - 1];
    if (last && last.type === 'entry') { last.extra.push(text); continue; }
    items.push({ type: 'note', text: text.slice(0, 120) });
  }
  return items;
}
// 倒序重排（最新在最上）：天分组整体反转 + 组内条目反转；尾部截断出的残组（无 `## MM-DD` 头）
// 加「更早」头并落到最末。
function reorderChangelogItems(items) {
  const groups = [];
  let cur = null;
  for (const it of items) {
    if (it.type === 'day') { cur = { day: it, rest: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { day: null, rest: [] }; groups.push(cur); }
    cur.rest.push(it);
  }
  const out = [];
  for (const g of groups.slice().reverse()) {
    if (g.day) out.push(g.day);
    else if (g.rest.length > 0) out.push({ type: 'day', date: '更早', partial: true });
    for (const it of g.rest.slice().reverse()) out.push(it);
  }
  return out;
}
// 尾部截断落在某天中间时，向上找该天最近的分组头日期（避免倒序后残组被标成「更早」）
function lastDayBefore(lines, start) {
  for (let i = start - 1; i >= 0; i--) {
    const m = lines[i].trim().match(/^##\s*(\d{2}-\d{2})$/);
    if (m) return m[1];
  }
  return null;
}
/** 变更流水段（now 可注入：跨零点单测用；默认现算）。 */
function collectChangelog(now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(CHANGELOG_DIR).filter((n) => n.endsWith('.md')).map((n) => path.join(CHANGELOG_DIR, n)); } catch { return { ok: false }; }
  if (files.length === 0) return { ok: false, dir: CHANGELOG_DIR };
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const file = files[0];
  const st = safe(() => fs.statSync(file), null);
  const text = readText(file) ?? '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 今日有记：文件今天改过（【卡 0】走纯函数 changedTodayOf，now 每次现算）
  const changedToday = changedTodayOf(st?.mtimeMs ?? null, now);
  const tailLines = lines.slice(-CHANGELOG_TAIL);
  let items = parseChangelogLines(tailLines);
  // 残组补日期头（尾部 20 行通常都在最近一天里，day 头被截在更上面）
  if (items.length > 0 && items[0].type !== 'day') {
    const day = lastDayBefore(lines, lines.length - tailLines.length);
    if (day) items.unshift({ type: 'day', date: day });
  }
  items = reorderChangelogItems(items);
  return {
    ok: true,
    file: path.basename(file),
    mtime: st?.mtimeMs ?? null,
    changedToday,
    tail: tailLines,
    // v0.2.0：items 倒序（最新在最上），tail 保留文件原顺序供 verify 打印
    items
  };
}

// ---------------------------------------------------------------------------
// ④ 记忆脉搏（node:sqlite 只读，WAL/无 WAL 都可安全读）
// ---------------------------------------------------------------------------
function collectMemory() {
  let db;
  try {
    db = new DatabaseSync(memoryDb(), { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS total, SUM(pinned) AS pinned FROM memories').get();
    const recent = db.prepare('SELECT id, text, pinned FROM memories ORDER BY id DESC LIMIT 5').all()
      .map((r) => ({ id: r.id, pinned: r.pinned === 1, firstLine: (r.text ?? '').split('\n')[0].slice(0, 90) }));
    return { ok: true, total: row?.total ?? 0, pinned: row?.pinned ?? 0, recent };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// v1.4：记忆全量分页（记忆 Tab 页），id 倒序（最新在前），tags 为空格分隔文本 → 拆数组
export function listMemories({ limit = 50, offset = 0 } = {}) {
  const cap = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.trunc(limit) : 50) || 50);
  const off = Math.max(0, Number.isFinite(offset) ? Math.trunc(offset) : 0) || 0;
  let db;
  try {
    db = new DatabaseSync(memoryDb(), { readOnly: true });
    const totalRow = db.prepare('SELECT COUNT(*) AS n, SUM(pinned) AS p FROM memories').get();
    const rows = db.prepare('SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id DESC LIMIT ? OFFSET ?').all(cap, off);
    return {
      ok: true,
      total: totalRow?.n ?? 0,
      pinned: totalRow?.p ?? 0,
      offset: off,
      items: rows.map((r) => ({
        id: r.id,
        pinned: r.pinned === 1,
        text: r.text ?? '',
        tags: typeof r.tags === 'string' && r.tags.trim() ? r.tags.trim().split(/\s+/).slice(0, 8) : [],
        createdAt: r.created_at ?? null,
        updatedAt: r.updated_at ?? null,
        firstLine: (r.text ?? '').split('\n')[0].slice(0, 90)
      }))
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// v1.1 ⑤ 会话标题读取（zstd 扫 session/title 事件）+ 内存缓存（mtime 变化才重扫）
//   主包把标题作为 type="session/title" 事件 append 进会话日志（dsh-session-title 服务）。
//   无标题会话 fallback：扫首条"真人" user/message（跳过 source.kind=plugin 的系统注入，
//   如 runtime-context/system-reminder/time-context 伪用户消息）取首段文本做显示标题。
//   独立实现不依赖主包内部服务（跨版本稳）；6MB 以上超大文件跳过（快），缓存键=文件路径+mtime。
// ---------------------------------------------------------------------------
const TITLE_CACHE = new Map();
function extractTextParts(content) {
  // content: [{type:'text', text:'..'}, {type:'image',...}] → 取 text 部分拼串
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      out += (out ? ' ' : '') + part.text.trim();
    }
  }
  return out;
}
function scanSessionTitle(file) {
  let st;
  try { st = fs.statSync(file); } catch { return ''; }
  if (st.size > 6 * 1024 * 1024) return '';
  const cached = TITLE_CACHE.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.title;
  let buf;
  try { buf = fs.readFileSync(file); } catch { return ''; }
  let title = '';
  let fallback = '';
  // v1.4.4 修（2026-09-11，主人报「无标题会话点『打开』跳不过去」）：
  //   旧实现取 `end = 下一个 magic 位置` 切帧、并 `i = end + 4` 推进——而 `end` 通常就是
  //   **下一帧的帧头**，+4 恰好把它跳过 → 每处理一帧就漏掉一帧（实测 <session>：
  //   710 帧只读到 355 帧、439/905 条记录，而它的 session/title 与首条真人消息正好落在漏掉
  //   的那一半里 → 面板显示空标题 → 前端没有搜索词可用 → 打开按钮只能退回"复制 ID"）。
  //   改为对每个 magic 候选**单帧起解**（zstd 解压器只解第一帧、忽略尾部剩余字节）：
  //   既修漏帧，也顺带容忍「压缩数据里恰好出现 magic 字节」造成的假帧头截断。
  const starts = [];
  for (let i = 0; ;) {
    const idx = buf.indexOf(ZSTD_MAGIC, i);
    if (idx === -1) break;
    starts.push(idx);
    i = idx + 4;
  }
  for (const from of starts) {
    let dec;
    try { dec = zstdDecompressSync(buf.subarray(from)).toString('utf8'); } catch { continue; }
    for (const line of dec.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === eva.EV.SESSION_TITLE && typeof o.data?.title === 'string' && o.data.title.trim()) {
        title = o.data.title;
      } else if (!fallback && o.type === eva.EV.USER_MESSAGE) {
        const src = o.data?.source;
        const isPlugin = src && typeof src === 'object' && src.kind === 'plugin';
        if (!isPlugin) {
          const text = extractTextParts(o.data?.content);
          if (text) fallback = text;
        }
      }
    }
  }
  const clean = (title || fallback).replace(/\s+/g, ' ').trim().slice(0, 60);
  TITLE_CACHE.set(file, { mtimeMs: st.mtimeMs, title: clean });
  return clean;
}

// ---------------------------------------------------------------------------
// v1.1 ⑥ 忽略清单（只读侧；写入走 POST /api/dsh-butler/ignore）
// ---------------------------------------------------------------------------
function readIgnore() {
  // 【2c · S4 前置】每次现解析（下方判定逻辑 / 文案一字未动，只换"路径怎么来"）
  const IGNORE_FILE = ignoreFilePath();
  const j = readJson(IGNORE_FILE);
  if (j && Array.isArray(j.sessions) && Array.isArray(j.tasks)) {
    return { sessions: j.sessions, tasks: j.tasks, ok: true, error: null, file: IGNORE_FILE, missing: false };
  }
  // 【施工卡 ①-3 · ①-7】读路径**可见化**（①包 §2.5 实测项：原实现读失败即 null ⇒ 清单静默变空、
  //   被忽略项"复活"）。口径：
  //   · 文件**不存在** = 正常空态（还没忽略过任何东西）⇒ ok:true + missing:true；
  //   · 文件存在但**解析失败 / 结构不符** ⇒ ok:false + 原因 ⇒ 前端必须显式渲染，
  //     绝不把"读不到"渲染成"没有忽略项"（否则主人以为忽略生效了，其实失灵）。
  let exists = false;
  try { exists = fs.existsSync(IGNORE_FILE); } catch { exists = false; }
  if (!exists) return { sessions: [], tasks: [], ok: true, error: null, file: IGNORE_FILE, missing: true };
  return {
    sessions: [], tasks: [], ok: false, file: IGNORE_FILE, missing: false,
    error: 'butler-ignored.json 存在但无法解析（JSON 损坏或结构不符）——忽略清单判定不可用，不作"空清单"处理',
  };
}

// ---------------------------------------------------------------------------
// v1.1 ⑦ 报告档案与趋势（读 docs\管家报告\ 日报/周报；trends 供前端 sparkline）
// ---------------------------------------------------------------------------
function parseDigestCounts(txt) {
  const i = txt.indexOf('## 摘要');
  if (i < 0) return null;
  const seg = txt.slice(i, i + 900);
  const m1 = seg.match(/中断[^\d]*?(\d+)/);
  const m2 = seg.match(/记忆库[^\d]*?(\d+)/);
  return { interrupted: m1 ? +m1[1] : null, memories: m2 ? +m2[1] : null };
}
// 【卡 V2-C】导出：`reports` 独立成片（报告 Tab + 管家 Tab 趋势卡按需拉），语义与无参全量一致。
export function collectReports() {
  let names;
  try { names = fs.readdirSync(REPORT_DIR).filter((n) => n.endsWith('.md')); } catch { return { ok: false }; }
  const dailies = [];
  const weeklies = [];
  const externals = [];
  const trends = { dates: [], interrupted: [], memory: [] };
  for (const n of names) {
    const dm = n.match(/^(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9_.-]+))?\.md$/);
    if (dm) { dailies.push({ name: n, date: dm[1], host: dm[2] ?? null, kind: 'daily' }); continue; }
    const wm = n.match(/^周报-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9_.-]+))?\.md$/);   // 2026-09-10：允许设备后缀（双机各一份周报，同名会互覆）
    if (wm) { weeklies.push({ name: n, date: wm[1], host: wm[2] ?? null, kind: 'weekly' }); continue; }
    // P6 会望风（2026-09-10）：外部信号报告 external-<YYYY-MM-DD>[-host].md
    const em = n.match(/^external-(\d{4}-\d{2}-\d{2})(?:-([A-Za-z0-9_.-]+))?\.md$/);
    if (em) externals.push({ name: n, date: em[1], host: em[2] ?? null, kind: 'external' });
  }
  dailies.sort((a, b) => (a.date < b.date ? 1 : -1));
  weeklies.sort((a, b) => (a.date < b.date ? 1 : -1));
  externals.sort((a, b) => (a.date < b.date ? 1 : -1));
  // 趋势图按日期去重（双机同日各一份日报时只取一条，避免 sparkline 出现重复点）
  const seenDay = new Set();
  for (const d of [...dailies].reverse()) {
    if (seenDay.has(d.date)) continue;
    seenDay.add(d.date);
    const t = parseDigestCounts(readText(path.join(REPORT_DIR, d.name)) ?? '') ?? {};
    trends.dates.push(d.date.slice(5));
    trends.interrupted.push(t.interrupted ?? null);
    trends.memory.push(t.memories ?? null);
    if (trends.dates.length >= 14) break;
  }
  return { ok: true, dailies: dailies.slice(0, 14), weeklies: weeklies.slice(0, 6), externals: externals.slice(0, 14), trends };
}

// ---------------------------------------------------------------------------
// P6 会望风（卡 [7]）：外部信号状态（只读 ~/.dsh/butler-external-state.json 的 digest）
//   与日报段 collectExternal 同源口径；采集本身归计划任务 DSH-Butler-External，本面板不触发采集。
// ---------------------------------------------------------------------------
// 【2c · S4 前置 · 2026-10-19】卡表未点名的同类读侧硬编码（本文件也有 external-state 的裸 join）：
//   同 ignoreFilePath 口径改走统一解析 —— 否则 S4 后本面板「外部信号」段会静默显示「数据源未就绪」。
/** 外部信号状态路径（唯一口径；与 checks.mjs#externalStateFilePath 同一解析器）。 */
export function externalStateFilePath() {
  return resolveStatePath('butler-external-state.json', { home: dshHome() }).path;
}
/** 旧单文件名（兼容期回退）；本机实际注册表见 externalSourcesFile()。 */
const EXTERNAL_SOURCES_FILE = path.join(dshHome(), 'external-sources.json');

/**
 * 本机源注册表路径（host 分文件，2026-09-11）：`external-sources-<host>.json` 存在则用它，
 * 否则回落旧单文件名（对端侧升级前 / 本地还没跑过新版 tick）。口径与 lib/host-tag.mjs 一致。
 */
function externalSourcesFile() {
  const tag = String(os.hostname() ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  const hostFile = path.join(dshHome(), `external-sources-${tag}.json`);
  try { if (fs.existsSync(hostFile)) return hostFile; } catch { /* 回退旧名 */ }
  return EXTERNAL_SOURCES_FILE;
}

function collectExternalSignal() {
  // 【2c · S4 前置】每次现解析（inner 内一行未改：参数名沿用旧常量名）
  const EXTERNAL_STATE_FILE = externalStateFilePath();
  try {
    return collectExternalSignalInner(EXTERNAL_STATE_FILE);
  } catch (e) {
    return { ok: false, reason: `读取外部信号状态失败：${e?.message ?? e}`, file: EXTERNAL_STATE_FILE, items: [], failing: [] };
  }
}

function collectExternalSignalInner(EXTERNAL_STATE_FILE) {
  if (!fs.existsSync(EXTERNAL_STATE_FILE)) {
    return { ok: false, reason: '数据源未就绪（P6 会望风未部署）', file: EXTERNAL_STATE_FILE, items: [], failing: [] };
  }
  const st = readJson(EXTERNAL_STATE_FILE);
  if (!st || typeof st !== 'object') return { ok: false, reason: '状态文件不可读', file: EXTERNAL_STATE_FILE, items: [], failing: [] };
  // 【卡 0 · B6①】「今日段」与「今日有记」共用同一个纯函数（本地日键），
  //   跨零点时两者口径一致；不再各自 new Date() 拼字符串。
  const today = localDayKey(Date.now()) ?? '';
  const digest = st.digest ?? {};
  const items = (digest.day === today ? (digest.items ?? []) : []).map((x) => ({
    id: x.id, level: x.level ?? 'yellow', title: x.title ?? '', detail: x.detail ?? '', url: x.url ?? null,
    at: x.at ?? null, delivered: x.delivered ?? null,
  }));
  let sourceCount = 0;
  let enabledCount = 0;
  try {
    const reg = readJson(externalSourcesFile());
    sourceCount = (reg?.sources ?? []).length;
    enabledCount = (reg?.sources ?? []).filter((s) => s.enabled !== false).length;
  } catch { /* 注册表不可读不影响本卡 */ }
  const sources = (digest.sources ?? []).map((s) => ({
    id: s.id, ok: s.ok !== false, skipped: s.skipped === true, failCount: Number(s.failCount ?? 0), note: s.note ?? null, snapshot: s.snapshot ?? null,
  }));
  return {
    ok: true,
    file: EXTERNAL_STATE_FILE,
    lastTickAt: st.lastTickAt ?? null,
    tickCount: Number(st.tickCount ?? 0),
    day: digest.day ?? null,
    sourceCount,
    enabledCount,
    sources,
    failing: sources.filter((s) => s.failCount >= 3),
    muted: digest.muted ?? [],
    suppressed: Number(digest.suppressed ?? 0),
    items,
    reds: items.filter((x) => x.level === 'red').length,
    yellows: items.filter((x) => x.level === 'yellow').length,
  };
}


// ---------------------------------------------------------------------------
// v0.2.0 ⑤ 健康监控（只读）：① 会话自动归档（dsh-archive-sessions 的 .auto-archive.json）
//   ② 升级体检（生态面板 /api/dsh-ecosystem-panel/state 的 upgrades 分组；缓存命中，不触发 npm）
//   两段各自降级：读不到就 ok:false，前端显示「不可用」而不是整体报错。
// ---------------------------------------------------------------------------
const ARCHIVE_DIR = path.join(dshHome(), '_archived-sessions');
const ECO_STATE_URL = 'http://localhost:3080/api/dsh-ecosystem-panel/state';
const HEALTH_FETCH_TIMEOUT_MS = 4000;
const HEALTH_PENDING_CAP = 8;

function collectAutoArchive() {
  const j = readJson(path.join(ARCHIVE_DIR, '.auto-archive.json'));
  if (!j) return { ok: false, dir: ARCHIVE_DIR };
  const cfg = j.config ?? {};
  const stt = j.state ?? {};
  const lr = stt.lastResult ?? {};
  let batches = [];
  try {
    batches = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let n = 0;
        // 只数「会话目录」：批次目录里除会话目录外还有 manifest.json 等文件，
        // 直接 readdir().length 会把它算成会话（2026-09-11 修正：面板 120 vs 实际 119）。
        try {
          n = fs.readdirSync(path.join(ARCHIVE_DIR, d.name), { withFileTypes: true })
            .filter((e) => e.isDirectory()).length;
        } catch { /* 单批不可读：计 0 */ }
        return { name: d.name, sessions: n };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch { /* 目录不可读：只报状态文件里的信息 */ }
  return {
    ok: true,
    enabled: cfg.enabled === true,
    dryRun: cfg.dryRun !== false,
    hours: cfg.hours ?? null,
    intervalHours: typeof cfg.intervalMs === 'number' ? Math.round(cfg.intervalMs / 3600000) : null,
    lastRunAt: stt.lastRunAt ?? lr.startedAt ?? null,
    last: {
      batch: lr.batch ?? null,
      dryRun: lr.dryRun === true,
      scanned: lr.scanned ?? null,
      candidates: (lr.candidates ?? []).length,
      archived: (lr.archived ?? []).length,
      skipped: (lr.skipped ?? []).length,
      errors: (lr.errors ?? []).length,
      movedMb: typeof lr.movedMb === 'number' ? Math.round(lr.movedMb * 10) / 10 : null,
      // 【2026-09-28 · M2 归档元数据库】写库失败的单轮只读展示字段（方案 §4.2-③ 通道①）：
      //   `state.lastResult.metaStore = {attempted, written, failed}`；`failed > 0` ⇒ 面板黄标。
      //   ⚠️ 落在 **`last` 字面量内部**（不是 return 顶层）—— 面板消费的是 `last.*`（U4 整改）。
      metaStore: lr.metaStore && typeof lr.metaStore === 'object'
        ? {
          attempted: lr.metaStore.attempted ?? null,
          written: lr.metaStore.written ?? null,
          failed: lr.metaStore.failed ?? null,
          ok: lr.metaStore.ok ?? null
        }
        : null
    },
    totalArchived: stt.totalArchived ?? null,
    // 【2026-09-28 · M2】写库失败的**持久累计**（`state.metaStore`，单调递增；不进 errors）——
    //   写库失败时由插件的 `bumpMetaFailCounters()` 落盘；成功写库即 `writeFailedStreak → 0`。
    metaStoreCounters: stt.metaStore && typeof stt.metaStore === 'object'
      ? {
        writeFailedTotal: stt.metaStore.writeFailedTotal ?? 0,
        writeFailedStreak: stt.metaStore.writeFailedStreak ?? 0,
        lastWriteError: stt.metaStore.lastWriteError ?? null,
        lastWriteAt: stt.metaStore.lastWriteAt ?? null
      }
      : null,
    batches: batches.slice(0, 5),
    batchesTotal: batches.length,
    archivedSessions: batches.reduce((a, b) => a + b.sessions, 0)
  };
}

async function collectUpgradeHealth(sharedEco = null) {
  const cacheAt = safe(() => fs.statSync(path.join(dshHome(), 'ecosystem-panel-upgrade-cache.json')).mtimeMs, null);
  try {
    // 【V2.9封口②·W2 性能】优先复用**同一请求内已发起**的生态面板 `/state`（health 与 metrics 同源，
    //   实测该 HTTP 固定价 1.6~1.7 s ⇒ 各发一次 = 白翻倍）。拿不到共享结果才自己发（行为与改造前一致）。
    let shared = null;
    if (sharedEco) { try { shared = await sharedEco; } catch { shared = null; } }
    if (shared && shared.eco) return shapeUpgradeHealth(shared.eco, cacheAt);
    if (shared && shared.err) return { ok: false, error: '生态面板不可探测：' + String(shared.err), cacheAt };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HEALTH_FETCH_TIMEOUT_MS);
    let j = null;
    try {
      const res = await fetch(ECO_STATE_URL, {
        headers: { origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' },
        cache: 'no-store',
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      j = await res.json();
    } finally {
      clearTimeout(timer);
    }
    return shapeUpgradeHealth(j, cacheAt);
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), cacheAt };
  }
}

/**
 * 生态面板 `/state` JSON → health 片的 upgrades 结论（**原逻辑逐字搬出**：只搬家、不改口径、不改文案）。
 * 【V2.9封口②·W2】抽出来的唯一理由：共享 HTTP 与自采两条路必须产出**同一形状**，防两份实现漂移。
 */
function shapeUpgradeHealth(j, cacheAt) {
  const items = j?.groups?.upgrades ?? [];
  const pending = items
    .filter((x) => x && x.status !== 'green')
    .map((x) => ({
      name: x.name,
      status: x.status,
      local: x.local ?? '',
      latest: x.latest ?? '',
      latestTag: x.latestTag ?? null,
      label: x.verdictLabel ?? '',
      problems: (x.problems ?? []).slice(0, 2)
    }))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'red' ? -1 : 1));
  return {
    ok: true,
    panelVersion: j?.meta?.panelVersion ?? null,
    summary: j?.upgradesMeta?.summary ?? { total: items.length, green: 0, yellow: 0, red: 0 },
    cacheAt: j?.upgradesMeta?.cacheAt ?? cacheAt,
    cacheSource: j?.upgradesMeta?.cacheSource ?? null,
    fetchedAt: j?.upgradesMeta?.fetchedAt ?? null,
    pending: pending.slice(0, HEALTH_PENDING_CAP),
    pendingTotal: pending.length
  };
}

// ---------------------------------------------------------------------------
// v0.3.0 ⑥ P8 会收纳（卡 [10]，2026-09-10）：butler-tidy-state.json 只读聚合
//   数据来源 = butler-tidy-tick.mjs（butler-scheduler 注册的只读采集器，每 6h）写出的状态文件。
//   口径：审计检查点固定 9 个（P8 §14.9 复核基线），实际产出行数 ≤ 9
//        （root-whitelist / root-whitelist-drift 仅在异常时产出行；健康态产出 7 行）。
//   本面板**只读**：不搬移、不删除、不改名、不触发审计。
// ---------------------------------------------------------------------------
const TIDY_STATE_FILE = resolveStatePath('butler-tidy-state.json', { home: dshHome() }).path;
/** 检查点口径常量（与 butler-audit-archive.mjs 的 AUDIT_CHECKPOINT_IDS 同步；面板侧只用于显示兜底）。 */
const TIDY_CHECKPOINTS = 9;

export function collectTidy() {
  const j = readJson(TIDY_STATE_FILE);
  if (!j) return { ok: false, file: TIDY_STATE_FILE };
  // 【P8 [12] · 2026-09-28】L2 **观察档**（observe，零副作用）只读透传。
  //   来源 = 同一个 tick 脚本 `butler-tidy-tick.mjs` 的第二个采集器（id=observe，每 6h），
  //   写进同一份状态文件的 `observe` 段（`observeHistory` 保留最近 30 轮）。
  //   ⚠️ 面板**同样只读**：observe 不建桶、不写 manifest、不动文件；apply 的真搬另属 P3 期（须主人批）。
  const obs = j.observe ?? null;
  const l2Observe = obs ? {
    at: obs.at ?? null,
    mode: obs.mode ?? 'observe',
    sideEffects: obs.sideEffects ?? 'none',
    device: obs.device ?? null,
    buckets: obs.buckets ?? [],
    counters: obs.counters ?? {},
    wouldMove: (obs.wouldMove ?? []).slice(0, 12),
    wouldMoveMore: Math.max(0, (obs.wouldMove ?? []).length - 12),
    deferredCount: obs.deferredCount ?? 0,
    skippedByStage: obs.skippedByStage ?? {},
    refcheck: obs.refcheck ?? null,
    gate: obs.gate ?? null,
    elapsedMs: obs.elapsedMs ?? null,
    describe: obs.describe ?? null,
  } : null;
  const base = {
    ok: true,
    file: TIDY_STATE_FILE,
    at: j.updatedAt ?? null,
    device: j.device ?? null,
    counters: j.counters ?? {},
    history: (j.history ?? []).slice(-8),
    // P8 [12]：L2 观察档（零副作用）+ 最近几轮（面板「资产 → P8 产出与收纳」用）
    l2Observe,
    l2ObserveHistory: (j.observeHistory ?? []).slice(-8),
  };
  const last = j.lastRun ?? null;
  if (!last) return { ...base, at: null };
  const a = last.audit ?? {};
  const findings = a.findings ?? [];
  return {
    ...base,
    ranAt: last.at ?? null,
    durationMs: last.durationMs ?? null,
    device: last.device ?? base.device,
    produced: a.produced ?? findings.length,
    checkpoints: a.checkpoints ?? TIDY_CHECKPOINTS,
    missingCheckpoints: a.missingCheckpoints ?? [],
    summary: a.summary ?? { block: 0, warn: 0, ok: 0 },
    findings: findings.map((f) => ({ id: f.id, level: f.level, message: f.message })),
    samples: a.samples ?? null,
    whitelist: a.whitelist ?? null,
    rootJunctions: a.rootJunctions ?? [],
    tmp: last.tmp ?? null,
    archive: last.archive ?? null,
    gate: last.gate ?? null,
    readOnly: last.readOnly === true
  };
}

// ---------------------------------------------------------------------------
// 重启统筹（卡 [1] P0，2026-09-09）：协调器心跳 / 排队状态 / 维护窗口 / 最近批次
// ---------------------------------------------------------------------------
const RESTART_STATE_FILE = resolveStatePath('butler-restart-state.json', { home: dshHome() }).path;
const MAINTENANCE_FILE = resolveStatePath('butler-maintenance.json', { home: dshHome() }).path;
// P0 闸门的重启请求文件（`%TEMP%\dsh-guard\restart-request.json`）。
// 【施工卡 ①-3】新增**测试注入点** `BUTLER_RESTART_REQUEST_FILE`：**默认行为逐字不变**（不给就照旧）。
//   动机：本卡要给「面板 force 全链路（含双值留痕的落盘 + 审计）」留下可复跑的实测证据，
//   而真往生产请求文件写一条 force = 协调器下一 tick 可能**真把 DSH 重启掉**（施工卡红线禁止）。
//   ⇒ 单测/e2e 用它把请求文件指到沙箱，其余路径（协调器读取端）不受影响。
const RESTART_REQUEST_FILE = process.env.BUTLER_RESTART_REQUEST_FILE
  || path.join(process.env.TEMP || os.tmpdir(), 'dsh-guard', 'restart-request.json');
const AUDIT_DIR = path.join(dshHome(), 'butler-audit');
/** 计划任务每分钟一次 → 3 分钟没刷新心跳 = 协调器被停/被拦（验收 6）。 */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// 库路径统一交给 butler-root 的多路回落（显式指定 → 工作区约定 → 已安装的 npm 包）。
async function butlerLib(name) {
  return import(asUrl(butlerLibPath(name)));
}
function readJsonFile(file, fallback = null) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    if (!t.trim()) return fallback;
    return JSON.parse(t);
  } catch { return fallback; }
}
/** 审计流水尾部（只取 restart-* 条目；倒序，最新在前）。 */
export function collectRestartAudit(limit = 20) {
  const now = new Date();
  const file = path.join(AUDIT_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`);
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < limit; i--) {
      try {
        const j = JSON.parse(lines[i]);
        if (typeof j?.type === 'string' && j.type.startsWith('restart-')) items.push(j);
      } catch { /* 坏行跳过 */ }
    }
    return { ok: true, file, items };
  } catch (e) {
    return { ok: false, file, error: String(e?.message ?? e), items: [] };
  }
}
/** 协调器健康（只读）：心跳 / 排队 / 维护窗口 / 待补发通知 / 最近批次 / 请求计数。 */
export async function collectRestartHealth() {
  const now = Date.now();
  let state;
  try {
    const store = await butlerLib('store.mjs');
    state = store.readJson(RESTART_STATE_FILE, { schemaVersion: 1, defaultValue: null });
  } catch (e) {
    return { ok: false, error: 'butler-store 不可用：' + String(e?.message ?? e), file: RESTART_STATE_FILE, urgentDaily: collectUrgentQuota() };
  }
  if (!state) return { ok: false, error: '状态文件缺失（协调器尚未跑过或被回滚）', file: RESTART_STATE_FILE, urgentDaily: collectUrgentQuota() };
  const hb = state.heartbeat ?? null;
  const ageMs = hb?.at ? now - hb.at : null;
  const reqs = readJsonFile(RESTART_REQUEST_FILE, { requests: [] });
  const list = Array.isArray(reqs?.requests) ? reqs.requests : [];
  const win = readJsonFile(MAINTENANCE_FILE, null);
  const q = state.queue ?? null;
  const last = state.lastBatch ?? null;
  return {
    ok: true,
    heartbeat: { at: hb?.at ?? null, ageMs, stale: ageMs === null || ageMs > HEARTBEAT_STALE_MS, pid: hb?.pid ?? null, version: hb?.version ?? null },
    queue: q ? {
      batchId: q.batchId ?? null,
      waitingMs: Math.max(0, now - (q.since ?? now)),
      activeCount: (q.active ?? []).length,
      active: (q.active ?? []).slice(0, 8),
      reasons: q.reasons ?? [],
      inFallbackWindow: q.inFallbackWindow === true,
      // ---- 【G33·加急档·A3】排队**分两类**显示（方案 §3.7「可观测」）----
      //   ① 卡执行会话 = **不可打断**（打断 ⇒ 假结算 review，要人工 reject→run 补做）；
      //   ② 普通会话 = 可被**加急档**打断（重启后照旧收「尾巴停在 X」）。
      //   另带三个"为什么还在等 / 敢不敢执行"的字段：档位 / 升档标记 / 两类退化态。
      tier: typeof q.tier === 'string' ? q.tier : 'normal',
      tierRequested: q.tierRequested ?? null,
      escalated: q.escalated === true,
      cardActiveCount: (q.cardActive ?? []).length,
      softActiveCount: (q.softActive ?? []).length,
      cardActive: (q.cardActive ?? []).slice(0, 8),
      softActive: (q.softActive ?? []).slice(0, 8),
      // 卡执行会话索引退化（复审 R-1②：degraded ⇒ 全部活跃按卡会话处理 ⇒ 加急档一律 queue ⇒ 必须可见）
      cardSessionIndexOk: q.cardSessionIndexOk === true,
      cardSessionDegraded: q.cardSessionDegraded === true,
      // 软保护三态（D-3=a · 复审 N-6）：`unavailable` ⇒ 面板须明示"当前无输入保护"（不许静默空转）
      softProtect: q.softProtect ? {
        mode: q.softProtect.mode ?? null,
        source: q.softProtect.source ?? null,
        holdCount: q.softProtect.holdCount ?? 0,
        holdIds: (q.softProtect.holdIds ?? []).slice(0, 8),
      } : null,
      remindFingerprint: q.remindFingerprint ?? null,
      // 执行前二次校验放弃（A2 · 方案 §3.4 红线 3）：上一轮"决策后又出现卡/输入"的证据，面板直接显示原因
      abortedLate: q.abortedLate ?? null,
      updatedAt: q.updatedAt ?? null,
    } : null,
    maintenance: win ? { correlationId: win.correlationId ?? null, until: win.until ?? null, remainingMs: Math.max(0, (win.until ?? 0) - now) } : null,
    pendingNotify: state.pendingNotify ? { batchId: state.pendingNotify.batchId ?? null, count: (state.pendingNotify.interrupted ?? []).length } : null,
    lastBatch: last ? {
      batchId: last.batchId ?? null,
      finishedAt: last.finishedAt ?? null,
      mode: last.mode ?? 'queue',
      reasons: last.reasons ?? [],
      interrupted: (last.interrupted ?? []).length,
      notified: (last.notified ?? []).length,
      items: (last.interrupted ?? []).slice(0, 6)
    } : null,
    requests: {
      pending: list.filter((r) => r.state === 'pending').length,
      executing: list.filter((r) => r.state === 'executing').length,
      total: list.length
    },
    counters: state.counters ?? {},
    // 【G33·加急档 · A4 可见性 · 2026-09-29】当日升档额度（只读 · 独立读取 ⇒ 它读不出来也
    //   不影响本函数其余字段；`display` 三态文案在 lib\urgent-quota.js 里拼好，前端直接用）。
    urgentDaily: collectUrgentQuota(),
    file: RESTART_STATE_FILE
  };
}
// ---------------------------------------------------------------------------
// 面板重启的「通知目标」认定（2026-09-11 卡 [S*·重启通知]）
// ---------------------------------------------------------------------------
// 背景：面板前端（注入式 client.js）拿不到「当前打开的会话 id」——DSH 前端没有把它放进
// URL / window / localStorage（conversation / layout / runtime / sidebar 四包 + 首页 HTML
// 实测确认），所以目标改由 Host 侧认定。判据刻意保守：**只认「此刻恰好 1 个回合未收尾的
// 会话」**（= 主人正对着的那个）；0 个或 ≥2 个 → 不带目标（主人既定偏好：宁可不发，
// 也不发错）。**禁止**退回「最近活跃会话」那种模糊猜测（2026-09-09 实测发错过会话）。
export async function resolvePanelTarget(explicitId = null) {
  const want = typeof explicitId === 'string' ? explicitId.trim() : '';
  try {
    const { collectSessions } = await butlerLib(path.join('..', 'restart-coordinator.mjs'));
    const sessions = collectSessions({});
    const actives = sessions.filter((s) => s && s.active === true && s.sessionId);
    if (want) {
      const hit = sessions.find((s) => s && s.sessionId === want) || null;
      return hit
        ? { sessionId: want, source: 'explicit', activeCount: actives.length, row: targetRow(hit) }
        : { sessionId: null, source: 'explicit-rejected', activeCount: actives.length, note: '传入的会话不在会话列表 → 视为无目标（不发）' };
    }
    // 首选「标题标着【运行】」的会话（主人 2026-09-11 定：会话自己打标，大管家读它）——
    // 比事件判据更直白；恰好 1 个才认，多个或不明确时退回事件判据。
    const marked = sessions.filter((s) => s && s.mark === 'running' && s.sessionId);
    if (marked.length === 1) {
      return { sessionId: marked[0].sessionId, source: 'title-mark', activeCount: actives.length, row: targetRow(marked[0]) };
    }
    if (marked.length > 1) {
      return {
        sessionId: null, source: 'multiple-marked', activeCount: actives.length,
        note: '有 ' + marked.length + ' 个会话标题标着【运行】 → 无法确定是哪个，无目标（不发）',
      };
    }
    if (actives.length === 1) {
      return { sessionId: actives[0].sessionId, source: 'sole-active', activeCount: 1, row: targetRow(actives[0]) };
    }
    return {
      sessionId: null,
      source: actives.length === 0 ? 'no-active' : 'multiple-active',
      activeCount: actives.length,
      note: actives.length === 0
        ? '此刻没有回合未收尾的会话、也没有【运行】标记 → 无目标（不发）'
        : '此刻有 ' + actives.length + ' 个会话在跑 → 无法确定是哪个，无目标（不发）',
    };
  } catch (e) {
    return { sessionId: null, source: 'error', activeCount: null, note: String(e?.message ?? e) };
  }
}
function targetRow(s) {
  return { sessionId: s.sessionId, title: s.title || '', mark: s.mark ?? null, tail: s.tail || null, ageMs: s.ageMs ?? null };
}

/**
 * 写一条重启请求（面板「排队重启 / 立即强制重启」）。
 * 走 butler-store 的 updateJson（原子写 + RMW 锁），与协调器共用同一份契约。
 *
 * 【施工卡 ①-3 · P-2】两处补齐（①包 §3.2④ + 轮五 E2/E3/E13）：
 *   ① **面板路径补审计**：E2 实测改前只有 CLI 路径（`request-restart.mjs:108`）写 `restart-request`，
 *      面板路径**完全没有**留痕；这里补一条 `restart-request`（`via:'panel'` 区分来源）。
 *   ② **预计值随请求落盘**：force 由面板确认框取到的「预计 N」（`resolvePanelTarget().activeCount`）
 *      写进请求对象（`expectedActive`/`expectedSource`/`expectedAt`）⇒ 协调器执行时能与
 *      **实际 N**（`buildInterruptionList(allActive)`）一起构成"双值留痕"。
 *      取不到（null）就如实写 null —— **不猜、不补 0**。
 * @param {{mode?:string, reason?:string, sessionId?:string|null, kind?:string,
 *          priority?: 'normal'|'urgent'|'force'|string|null,
 *          expectedActive?:number|null, expectedSource?:string|null}} [input]
 */
/**
 * 重启请求**档位**归一（【G33·加急档·A3】入口层 · 依据 = 方案 §3.3 / §6.1）。
 *
 * - 档位**权威源 = 请求对象 `priority` 字段**（面板只写请求；读一律读请求文件）；
 * - 合法值 `normal` | `urgent`；`mode === 'force'` ⇒ 强制档（与 CLI 的 `--force` 同义，档位随之一致）；
 * - **非法 / 缺省 ⇒ `normal`**（零行为变更），原值回显到 `ignored` 供审计留痕 —— **不静默吞掉**调用方的意思。
 * @param {unknown} value 请求体里的 `priority`
 * @param {'queue'|'force'} mode 已归一的模式
 * @returns {{priority:'normal'|'urgent'|'force', ignored:string|null}}
 */
export function normalizeRestartPriority(value, mode) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (mode === 'force') return { priority: 'force', ignored: v && v !== 'force' ? v : null };
  if (v === 'normal' || v === 'urgent') return { priority: v, ignored: null };
  return { priority: 'normal', ignored: v || null };
}
export async function requestRestart(input = {}) {
  const store = await butlerLib('store.mjs');
  const restart = await butlerLib('restart.mjs');
  const mode = input.mode === 'force' ? 'force' : 'queue';
  // 【G33·加急档·A3】档位：`force` 由 mode 表达（唯一权威）；其余取 `priority`（白名单归一，缺省 normal）
  const prio = normalizeRestartPriority(input.priority, mode);
  const req = restart.makeRequest({
    mode,
    priority: prio.priority,
    reason: input.reason,
    requester: { kind: input.kind ?? 'panel', sessionId: input.sessionId ?? null }
  });
  // 【①-3】预计值（只对 force 有意义；queue 由计划值决定，无需双值）
  if (Number.isFinite(input.expectedActive)) {
    req.expectedActive = input.expectedActive;
    req.expectedSource = input.expectedSource ?? null;
    req.expectedAt = Date.now();
  }
  const next = store.updateJson(RESTART_REQUEST_FILE, (cur) => {
    const base = cur && Array.isArray(cur.requests) ? cur : { schemaVersion: 1, requests: [] };
    const keep = base.requests.filter((r) => r && typeof r === 'object');
    return { ...base, schemaVersion: 1, requests: [...keep, req].slice(-50) };
  }, { schemaVersion: 1, home: dshHome(), defaultValue: { schemaVersion: 1, requests: [] } });
  // 【①-3 · P-2④】面板路径审计（失败只降级，不阻断重启请求本身——与协调器 catch 口径一致）
  let audit = null;
  try {
    const { appendAudit } = await butlerLib('audit.mjs');
    audit = appendAudit({
      type: 'restart-request', via: 'panel', correlationId: req.correlationId, mode: req.mode,
      requester: req.requester, reason: req.reason,
      // 【G33·加急档·A3】档位随审计留痕；`priorityIgnored` = 按白名单规则被忽略掉的请求档位
      priority: req.priority, priorityIgnored: prio.ignored,
      expectedActive: Number.isFinite(req.expectedActive) ? req.expectedActive : null,
      expectedSource: req.expectedSource ?? null,
    }, { home: dshHome(), silent: true });
  } catch (e) {
    audit = { ok: false, error: String(e?.message ?? e) };
  }
  return {
    ok: true, request: req, priority: req.priority, priorityRequested: input.priority ?? null, priorityIgnored: prio.ignored,
    total: (next.requests ?? []).length, file: RESTART_REQUEST_FILE, audit,
  };
}

/**
 * 升级锁 / 中断检测（B3 前置 · 2026-09-11）。
 * 判读逻辑**不在面板里复制**：直接调 butler lib 的 status()（单一数据源，与
 * CLI / dsh-start.ps1 / 日报段同一套口径）。纯只读。
 */
export async function collectUpgradeLockHealth() {
  const home = dshHome();
  try {
    const ul = await butlerLib('upgrade-lock.mjs');
    const st = ul.status({ home });
    const lock = st.lock ?? null;
    return {
      ok: true,
      state: st.state,
      exists: st.exists === true,
      canUpgrade: st.canUpgrade === true,
      summary: st.summary,
      hint: st.hint,
      corrupt: st.corrupt ?? null,
      file: st.file,
      step: lock?.step ?? null,
      phase: lock?.phase ?? null,
      pid: lock?.pid ?? null,
      pidAlive: st.pidAlive,
      sessionId: lock?.sessionId ?? null,
      startedAt: lock?.startedAt ?? null,
      heartbeatAgeMs: st.heartbeatAgeMs,
      ttlMs: st.ttlMs,
      ageMs: st.ageMs,
      fromVersion: lock?.fromVersion ?? null,
      targetVersion: lock?.targetVersion ?? null,
      backupDir: lock?.backupDir ?? null,
      // 中断现场顺便看看"静默窗有没有一起忘关"（L1 资产，最常见的第二个尾巴）
      silence: (() => {
        const s = readJsonFile(path.join(home, 'upgrade-silence-state.json'), null);
        return s ? { inWindow: s.phase === 'disabled', disabledAt: s.disabledAt ?? null } : null;
      })(),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), file: path.join(home, 'upgrade-lock') };
  }
}

/**
 * tickd 常驻调度健康（卡「tickd 停摆治本」· 2026-09-23）。
 * 判据**不在面板里复制**：直接调 butler lib 的 judgeTickdHealth()（与日报「⏱ tick 调度健康」段、
 * CLI `butler-tickd.mjs --status` 同一份判定与同一份文案）。
 * 为什么必须有一张卡：2026-09-22 tickd 停 2h+，通知 / 闸门 / 看门狗 / ctx-guard / 接力全链静默停摆，
 * 而「🩺 健康监控（只读）」区当时一张会说"引擎根本没跑"的卡都没有 —— 主人是"没收到通知"才反推出来的。
 * 纯只读：不写任何文件、不起进程、不触发 job。
 */
export async function collectTickdHealth() {
  try {
    const mod = await butlerLib('tickd-health.mjs');
    if (!mod || typeof mod.judgeTickdHealth !== 'function') return { ok: false, error: 'butler lib tickd-health.mjs 不可用' };
    const h = mod.judgeTickdHealth({ now: Date.now() });
    if (!h || h.ok === false) return { ok: false, error: h?.reason ?? 'tickd 健康判据不可探测', stateFile: h?.stateFile ?? null };
    return {
      ok: true,
      available: true,
      level: h.level ?? null,
      reason: h.reason ?? null,
      running: { ok: h.running?.ok === true, reason: h.running?.reason ?? null, pid: h.running?.pid ?? null },
      lastLoopAt: h.lastLoopAt ?? null,
      loopCount: h.loopCount ?? 0,
      jobCount: h.jobCount ?? 0,
      healthyCount: h.healthyCount ?? 0,
      unknownCount: h.unknownCount ?? 0,
      failing: (h.failing ?? []).slice(0, 8).map((f) => ({ id: f.id, label: f.label, level: f.level, lastStatus: f.lastStatus, failures: f.failures })),
      // 【M5】会话异地镜像（判据真源 = `butler-session-mirror.json#consecutiveUnreachable >= 3`）：
      //   面板红标 + **四段式告警全文**的出口。判据/文案都不在面板里复制 —— 原样透传 M4 `judgeMirrorJob()`
      //   的汇总（含 `mirrorAlarmText()` 生成的 reason）。全文放 health 片（≤30 KB，宽裕）；
      //   首屏 metrics 片（硬线 2048 B）只带 `{lv,n}` 短字段，见 lib/shards.mjs。
      sessionMirror: h.sessionMirror ? {
        id: h.sessionMirror.id ?? null,
        label: h.sessionMirror.label ?? null,
        level: h.sessionMirror.level ?? null,
        reason: h.sessionMirror.reason ?? null,
        readable: h.sessionMirror.readable ?? null,
        lastResult: h.sessionMirror.lastResult ?? null,
        consecutiveUnreachable: Number(h.sessionMirror.consecutiveUnreachable ?? 0),
        lastRunAt: h.sessionMirror.lastRunAt ?? null,
        lastUnreachableAt: h.sessionMirror.lastUnreachableAt ?? null,
        file: h.sessionMirror.file ?? null,
      } : null,
      lagging: (h.lagging ?? []).slice(0, 8).map((x) => ({ id: x.id, lagDays: x.lag?.lagDays ?? null })),
      lastStall: h.lastStall ?? null,
      stateFile: h.stateFile ?? null,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function collectHealth(opts = {}) {
  // 【V2.9封口②·W2 性能】五路 IO **并行**：原为串行 await 链（生态面板 HTTP → 重启态 → 升级锁 →
  //   tickd → 交接段），五者互不依赖，而 health 片冷取 1.6~2.2 s 基本就是它们的**和**
  //   ⇒ 并行后 ≈ 最慢一路（生态面板 HTTP，已由 `opts.eco` 与 metrics 片共享）。
  //   同步源（archive / external / tidy）保持原地同步执行（无 IO 等待，并行无收益）。
  //   ⚠️ 返回对象的**键顺序与改造前逐字同序**：archive, upgrades, restart, external, tidy, upgradeLock, tickd, handoff。
  const archive = safe(collectAutoArchive, { ok: false });
  const [upgrades, restart, upgradeLock, tickd, handoff] = await Promise.all([
    collectUpgradeHealth(opts.eco ?? null),
    collectRestartHealth(),
    collectUpgradeLockHealth(),
    collectTickdHealth(),
    (async () => {
      try {
        const { collectHandoffSection } = await import('./checks.mjs');
        return await collectHandoffSection({});
      } catch (e) {
        return { ok: false, present: false, lines: [], facts: {}, reason: String(e?.message ?? e) };
      }
    })(),
  ]);
  // P6 会望风（卡 [7]）：外部信号卡读的就是这里（前端 buildHealth(h) 收到的 h = state.health）
  const external = safe(collectExternalSignal, { ok: false, items: [], failing: [] });
  // P8 会收纳（卡 [10]）：收纳审计只读聚合（9 检查点口径）
  const tidy = safe(collectTidy, { ok: false });
  return { archive, upgrades, restart, external, tidy, upgradeLock, tickd, handoff };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
export function buildState() {
  const tasks = safe(collectTasks, { revision: 0, running: [], todo: [], backlog: [], overdue: [], recentClosed: [] });
  const sessions = safe(detectInterrupted, { interrupted: [], activeGroups: [] });
  const changelog = safe(collectChangelog, { ok: false });
  const memory = safe(collectMemory, { ok: false });
  // v1.1：忽略清单过滤（主人标过"已处理/别烦我"的会话与卡不再进清单，计数留给前端提示）
  const ignore = readIgnore();
  const igSess = new Set(ignore.sessions);
  const igTask = new Set(ignore.tasks);
  const filterTasks = (list) => (list ?? []).filter((t) => !igTask.has(t.id));
  const interrupted = (sessions.interrupted ?? []).filter((x) => !igSess.has(x.id));
  const reports = safe(collectReports, { ok: false });
  const external = safe(collectExternalSignal, { ok: false });

  const summary = {
    running: filterTasks(tasks.running).length,
    todo: filterTasks(tasks.todo).length,
    backlog: filterTasks(tasks.backlog).length,
    overdue: filterTasks(tasks.overdue).length,
    interrupted: interrupted.length,
    changedToday: changelog.ok && changelog.changedToday ? 1 : 0,
    memories: memory.ok ? memory.total : -1
  };
  return {
    meta: {
      generatedAt: Date.now(),
      overdueDays: OVERDUE_DAYS,
      ignored: { sessions: ignore.sessions.length, tasks: ignore.tasks.length },
      // 【①-3 · ①-7】忽略清单读路径可见化：ok:false = 判定不可用（文件坏），前端必须显式提示。
      //   `missing:true` 是正常空态（还没忽略过），**不算**不可用。
      ignoreOk: ignore.ok !== false,
      ignoreMissing: ignore.missing === true,
      ignoreError: ignore.ok === false ? ignore.error : null,
    },
    summary,
    tasks: {
      ...tasks,
      running: filterTasks(tasks.running),
      todo: filterTasks(tasks.todo),
      backlog: filterTasks(tasks.backlog),
      overdue: filterTasks(tasks.overdue)
    },
    sessions: { ...sessions, interrupted, relay: safe(readRelayPanelLite, null) },
    changelog,
    memory,
    reports,
    external,
    // 本鱼契约（2026-09-10 主人令）：运行时读 persona，绝不复制内容（见本文件末尾 readPersonaContract）
    contract: safe(readPersonaContract, { ok: false, error: 'readPersonaContract 抛错', groups: 0, total: 0, list: [] })
  };
}

// ---------------------------------------------------------------------------
// P5 干预统计（方案 §4 P5 学习项⑤：拒绝 / 改单 / 逃生舱 按动作类型聚合 → 分级校准数据）
// 数据源 = 审计流水 ~/.dsh/butler-audit/*.jsonl（type='audit-guard' 的记录），纯统计 0 token。
// 注：AUDIT_DIR 复用本文件上方既有定义（path.join(dshHome(), 'butler-audit')）。
// ---------------------------------------------------------------------------
/** 统计窗口：最近 N 天的流水文件。 */
const AUDIT_WINDOW_DAYS = 92;

// e2e 验收探针判据（2026-09-11 复盘·卡 0f1f44da）：P5 端到端脚本自测造出的假拦截 / 假暂停
// 不是真实干预，读取端滤除（**绝不改写流水文件本身**，哈希链保持完整）。
// 与 dsh-butler 坑库侧同一口径（那边是 _test/fixtures/pitfall-exclude.json 的 e2e-probe-self-test）。
const AUDIT_E2E_NOISE_RE = /_p5-e2e-|e2e\s*(?:暂停|恢复|探针|测试)/i;

/**
 * 该审计记录是否 e2e 自测噪音（看 path / reason）。
 * @param {{path?:string, reason?:string}} rec
 * @returns {boolean}
 */
export function isAuditE2eNoise(rec) {
  return AUDIT_E2E_NOISE_RE.test(`${rec?.path ?? ''} ${rec?.reason ?? ''}`);
}

/**
 * 读审计流水（按月文件；读失败静默跳过）。e2e 自测记录在此滤除（只过滤、不写回）。
 * @returns {{records:object[], e2eSkipped:number}}
 */
function readAuditRecords() {
  const out = [];
  let e2eSkipped = 0;
  let files = [];
  try {
    files = fs.readdirSync(AUDIT_DIR).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).sort().slice(-3);
  } catch {
    return { records: out, e2eSkipped };
  }
  const since = Date.now() - AUDIT_WINDOW_DAYS * 24 * 3600 * 1000;
  for (const name of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(AUDIT_DIR, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const at = Date.parse(rec.at ?? '');
      if (Number.isFinite(at) && at < since) continue;
      if (isAuditE2eNoise(rec)) { e2eSkipped++; continue; }
      out.push(rec);
    }
  }
  return { records: out, e2eSkipped };
}

const inc = (obj, key) => { const k = String(key ?? 'unknown'); obj[k] = (obj[k] ?? 0) + 1; };

/**
 * 干预统计 + 分级校准建议（只建议，不自动改分级）。
 * @param {{limit?:number}} [opts]
 */
export function collectAuditStats(opts = {}) {
  const limit = Number(opts.limit ?? 10);
  const { records: all, e2eSkipped } = readAuditRecords();
  const guard = all.filter((r) => r?.type === 'audit-guard');
  const cli = all.filter((r) => r?.type === 'audit-cli');
  const byCode = {};
  const byZone = {};
  const byTool = {};
  const recentBlocks = [];
  let blocks = 0, passes = 0, postBlocks = 0, pauses = 0, resumes = 0, forces = 0, issues = 0;
  for (const r of guard) {
    switch (r.action) {
      case 'block':
        blocks++;
        inc(byCode, r.code);
        inc(byZone, r.zone);
        if (r.tool) inc(byTool, r.tool);
        recentBlocks.push({ at: r.at, code: r.code, zone: r.zone ?? null, tool: r.tool ?? null, path: r.path ?? null, event: r.event ?? null });
        break;
      case 'post-block': postBlocks++; inc(byZone, r.zone); break;
      case 'pass': passes++; break;
      case 'audit-pause': pauses++; break;
      case 'audit-resume': resumes++; break;
      case 'issue-token': issues++; if (r.forced) forces++; break;
      default: break;
    }
  }
  recentBlocks.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const calibration = [];
  if (blocks > 0) {
    calibration.push(`AUDIT_NOT_PASSED 类拦截 ${blocks} 次：保护区写入没先走审计 → 建议把「落临时文件 → 审计 → write 工具写入」流程写进相关技能/文档（L2），而不是靠人记得。`);
  }
  if (forces > 0) {
    calibration.push(`force 逃生舱使用 ${forces} 次：某条规则可能过严或流程太绕 → 建议复核对应规则阈值（只建议，不自动改分级）。`);
  }
  if (postBlocks > 0) {
    calibration.push(`写后审计发现违规 ${postBlocks} 次：B 层规则命中 → 复核 docs 结构规则是否过严（误报会让人无视审计）。`);
  }
  if (pauses > 0) {
    calibration.push(`主人暂停写入审计 ${pauses} 次：暂停期间无 A 层防护，建议查因（规则误报 / 流程太麻烦）。`);
  }
  const codes = Object.entries(byCode).sort((a, b) => b[1] - a[1]);
  if (codes.length && codes[0][1] >= 3) {
    calibration.push(`最高频拦截码 ${codes[0][0]}（${codes[0][1]} 次）→ 优先处理这一类（做成检查项或改流程）。`);
  }
  return {
    ok: true,
    windowDays: AUDIT_WINDOW_DAYS,
    totals: { records: all.length, guard: guard.length, cli: cli.length, blocks, passes, postBlocks, pauses, resumes, forces, issues, e2eSkipped },
    byCode, byZone, byTool,
    recentBlocks: recentBlocks.slice(0, limit),
    calibration,
    note: `统计口径 = 审计流水（audit-guard 记录）；已滤除 e2e 自测探针记录 ${e2eSkipped} 条（只读过滤，不改写流水）；只建议不自动改分级。`,
  };
}

// ---------------------------------------------------------------------------
// 📜 本鱼契约（2026-09-10 主人令）：运行时解析 persona → 总览页只读卡片
//   背景：焊进 persona 的规矩（暗号 / 铁律 / 偏好 / 身份）主人记不住、也没地方查。
//   结论：**不做文档（会脱节），做进面板** —— 每次请求现读现解析：
//         · 面板代码里不出现任何 persona 正文（无硬编码、无副本）
//         · 不落状态文件、不缓存（persona 一改，下次打开面板即同步）
//   数据源：~/.dsh/.agent-presets/<preset>/agent.cordis.yml 的 persona 块标量。
//   形态容忍（P5 写入守门人约束）：单行 ≤800 字符 + 续行 8 空格缩进 + 块标量 |-，
//         一级段落 = 顶格【…】，条目 = "- " 列表项（很多条目自带【】小标题）。
//   失败降级 {ok:false,error}：persona 读不到只让这张卡灰掉，不影响其它 Tab。
// ---------------------------------------------------------------------------
const AGENT_PRESETS_DIR = path.join(dshHome(), '.agent-presets');
/** 条数防御上限（正常 ~100 条；畸形文件也不许把面板拖炸）。 */
const CONTRACT_ITEM_CAP = 400;
/** 摘要显示长度（前端一行截断，此处先切一刀减少传输）。 */
const CONTRACT_SUMMARY_LEN = 96;
/** 段落图标（按段落名关键词匹配；未命中给 📄）。 */
const CONTRACT_GROUP_ICONS = [
  [/身份/, '🐋'],
  [/反应原则/, '🎭'],
  [/协作偏好/, '📌'],
  [/能力/, '🛠'],
  [/看图|读图/, '👁'],
  [/工具速查/, '🧰'],
  [/自我维护|焊入纪律/, '🔧']
];
const CONTRACT_UNGROUPED = '（卷首）';
/**
 * 契约类型（卡原案 4 类，2026-09-10 主人定「段落分组 + 4 类筛选」两者都要）：
 * 🔑 暗号（触发语）/ ⚖️ 铁律（硬约束）/ 🐋 身份（我是谁、怎么说话）/ 🤝 偏好（其余协作约定）。
 */
const CONTRACT_KINDS = [
  ['code', '🔑', '暗号'],
  ['rule', '⚖️', '铁律'],
  ['identity', '🐋', '身份'],
  ['pref', '🤝', '偏好']
];
/** 暗号：标题带"暗号 / 口令"这两个**类别元词**（不写任何具体暗号词——那等于把 persona 内容抄进代码）。 */
const CONTRACT_CODE_RE = /暗号|口令/;
/** 暗号的第二判据 = 触发语**结构**（"主人说「X」…进入/退出/切换"），同样不含任何具体暗号词。 */
const CONTRACT_TRIGGER_RE = /主人说[「"“'][^」"”']{1,24}[」"”'][^。；;]{0,40}(进入|退出|切回|切换)/;
/** 铁律：标题或正文自称铁律（保守——不靠"必须/绝不"这类宽词，避免误判成铁律）。 */
const CONTRACT_RULE_RE = /铁律/;
/** 身份：属于"我是谁 / 怎么说话 / 我怎么自我维护"的段落。 */
const CONTRACT_IDENTITY_RE = /身份|卷首|反应原则|能力|自我维护/;

/** 给一条契约条目归类（判定顺序：暗号 → 铁律 → 身份 → 偏好兜底）。 */
export function classifyContractItem(title, full, group) {
  const t = String(title ?? '');
  const body = String(full ?? '');
  const g = String(group ?? '');
  if (CONTRACT_CODE_RE.test(t) || CONTRACT_CODE_RE.test(g) || CONTRACT_TRIGGER_RE.test(body.slice(0, 240))) return 'code';
  if (CONTRACT_RULE_RE.test(t) || /铁律/.test(body)) return 'rule';
  if (CONTRACT_IDENTITY_RE.test(g) || CONTRACT_IDENTITY_RE.test(t)) return 'identity';
  return 'pref';
}

/** 候选 persona 文件：whale-girl 子目录优先，兼容根目录形态。 */
export function findPersonaFile() {
  const cands = [
    path.join(AGENT_PRESETS_DIR, 'whale-girl', 'agent.cordis.yml'),
    path.join(AGENT_PRESETS_DIR, 'agent.cordis.yml')
  ];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 试下一个 */ }
  }
  // 兜底：扫一层预设子目录，优先"含本鱼字样"的，其次最新改动的
  try {
    const files = fs.readdirSync(AGENT_PRESETS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(AGENT_PRESETS_DIR, d.name, 'agent.cordis.yml'))
      .filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    const scored = files.map((f) => {
      let hit = 0;
      let mtime = 0;
      try { hit = fs.readFileSync(f, 'utf8').includes('本鱼') ? 1 : 0; } catch { /* ignore */ }
      try { mtime = fs.statSync(f).mtimeMs; } catch { /* ignore */ }
      return { f, hit, mtime };
    }).sort((a, b) => (b.hit - a.hit) || (b.mtime - a.mtime));
    if (scored.length) return scored[0].f;
  } catch { /* ignore */ }
  return cands[0];
}

/**
 * persona 块标量的**键名**，按代际优先级排列（单一数据源）。
 *   · `prefix` —— 现行键。主包 0.1.5 线起 `@deepseek-ai/dsh-persona` 的运行时 schema 里
 *     `prefix` 是 `z.string().required()`（包内 `lib/index.js` 的 `Config`），`text` **根本不是合法键**
 *     ⇒ 0.1.5 线的 preset 只能写 `prefix: |-`（写 `text:` 这一行挂不上去）。
 *   · `text` —— 历史键（0.1.1 线），保留只为**跨机 / 跨代兼容**：另一台机跑旧主包时 preset 仍是 `text: |-`。
 * 判据出处：`docs\交付报告-tickd停摆治本-20260923.md`（「0.1.1 = text / 0.1.5 = prefix」）与同批
 *   P5 `rules\persona-audit.mjs` + `tools\validate-persona.mjs` 的修法（两处都改成 `prefix ?? text`）。
 * ⚠️ 加键必须**两个一起动**（本数组 + 上面的判据），别只加一个当"兜底"——键名过期 = 契约片整段失明。
 */
export const PERSONA_TEXT_KEYS = ['prefix', 'text'];

/**
 * 定位 persona 块标量行（先按 `prefix`，再退到 `text`）。
 * 形态：`- id: persona` → `config:` → `prefix: |-`（0.1.5 线）/ `text: |-`（0.1.1 线）。
 * 扫描**止于 persona 行的下一条同级 `- id:`**：越界命中隔壁 row 的键会悄悄解析出**错误的正文**（假绿），
 * 比返回 null 危险得多，故 fail-closed（宁可报"未找到"让人来看，也不端出一份错的契约）。
 * @returns {{key:string, idx:number}|null}
 */
export function findPersonaTextBlock(yaml) {
  const lines = String(yaml).split(/\r?\n/);
  const idIdx = lines.findIndex((l) => /^\s*-?\s*id:\s*persona\s*$/.test(l));
  const from = idIdx >= 0 ? idIdx : 0;
  let rowEnd = lines.length;
  if (idIdx >= 0) {
    const idIndent = (lines[idIdx].match(/^[ \t]*/) ?? [''])[0].length;
    for (let i = idIdx + 1; i < lines.length; i++) {
      if (!/^\s*-\s*id:\s*\S/.test(lines[i])) continue;
      if (((lines[i].match(/^[ \t]*/) ?? [''])[0].length) <= idIndent) { rowEnd = i; break; }
    }
  }
  for (const key of PERSONA_TEXT_KEYS) {
    const re = new RegExp('^\\s*' + key + ':\\s*\\|[-+0-9]*\\s*$');
    for (let i = from; i < rowEnd; i++) {
      if (re.test(lines[i])) return { key, idx: i };
    }
  }
  return null;
}

/**
 * 取出 persona 块标量正文（已去掉 YAML 缩进）。
 * 形态：`- id: persona` → `config:` → `prefix: |-`（0.1.5）/ `text: |-`（0.1.1）→ 之后缩进更深的行即正文。
 * @returns {string|null} 找不到块标量返回 null
 */
export function extractPersonaText(yaml) {
  const lines = String(yaml).split(/\r?\n/);
  const hit = findPersonaTextBlock(yaml);
  if (!hit) return null;
  const idx = hit.idx;
  const baseIndent = (lines[idx].match(/^[ \t]*/) ?? [''])[0].length;
  const contentIndent = baseIndent + 2; // YAML 块标量正文至少再缩进 1（本机 4 + 2 = 6）
  const out = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { out.push(''); continue; }
    const indent = (line.match(/^[ \t]*/) ?? [''])[0].length;
    if (indent < contentIndent) break; // 块结束
    out.push(line.slice(contentIndent));
  }
  return out.join('\n');
}

/** 去 markdown 强调符号 + 折行压平（摘要用；全文保留原文）。 */
function stripMd(s) {
  return String(s)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 摘要：去 markdown、去开头的【…】小标题（避免与 title 重复）、超长截断。 */
function contractSummary(text) {
  const flat = stripMd(text);
  const body = flat.replace(/^【[^】]{1,80}】/, '').trim() || flat;
  return body.length > CONTRACT_SUMMARY_LEN ? body.slice(0, CONTRACT_SUMMARY_LEN) + '…' : body;
}

/** 条目标题：① 条目自带【…】 ② 粗体小标题 **…** ③"："前短语 ④ 首 24 字。 */
function contractTitle(text, fallback) {
  const raw = String(text);
  const m = raw.match(/【([^】]{1,60})】/);
  if (m) return m[1];
  const bold = raw.match(/\*\*([^*]{1,60})\*\*/);
  if (bold) return bold[1].replace(/\s+/g, ' ').trim();
  const head = stripMd(text).split('\n')[0];
  const colon = head.search(/[：:]/);
  if (colon > 0 && colon <= 20) return head.slice(0, colon);
  const cut = head.slice(0, 24);
  return cut || (fallback ?? '');
}

/** 段落图标。 */
function contractIcon(name) {
  for (const [re, icon] of CONTRACT_GROUP_ICONS) if (re.test(name)) return icon;
  return '📄';
}

/**
 * 解析块标量正文 → 按段落分组的契约条目。
 * 段落 = 顶格【…】行；组内 "- " 行 = 条目（后续缩进行为续行）；
 * 段落标题同行带正文时，该正文也算一条（如【身份】…）。
 * @returns {Array<{group:string,icon:string,items:Array<{title:string,summary:string,full:string}>}>}
 */
export function parsePersonaContract(block, opts = {}) {
  const cap = Number(opts.cap ?? CONTRACT_ITEM_CAP);
  const groups = [];
  let group = null;
  let item = null;
  let count = 0;
  const mkItem = (title, text) => ({
    title: title || contractTitle(text),
    summary: contractSummary(text),
    full: String(text).trim()
  });
  const flush = () => {
    if (item && group && item.full) {
      item.kind = classifyContractItem(item.title, item.full, group.group); // 🔑⚖️🐋🤝 四类（前端筛选用）
      group.items.push(item);
      count++;
    }
    item = null;
  };
  const openGroup = (name) => {
    flush();
    group = { group: name, icon: contractIcon(name), items: [] };
    groups.push(group);
  };
  for (const raw of String(block).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flush(); continue; }
    if (count >= cap) break;
    const indent = (line.match(/^[ \t]*/) ?? [''])[0].length;
    const t = line.trim();
    const sec = t.match(/^【([^】]{1,80})】(.*)$/);
    if (indent === 0 && sec) {
      openGroup(sec[1]);
      const rest = sec[2].trim();
      // 纯标题行（正文在后续 "- " 列表里）只开组、不产条目；标题同行带正文才算一条（如【身份】…）
      if (rest) item = mkItem(sec[1], rest);
      continue;
    }
    if (/^-\s+/.test(t)) {
      const body = t.replace(/^-\s+/, '');
      if (!group) openGroup(CONTRACT_UNGROUPED);
      flush();
      item = mkItem(null, body);
      continue;
    }
    // 续行 / 段内正文
    if (!group) openGroup(CONTRACT_UNGROUPED);
    if (item) {
      item.full += '\n' + t;
      item.summary = contractSummary(item.full);
    } else {
      item = mkItem(null, t);
    }
  }
  flush();
  return groups.filter((g) => g.items.length > 0);
}

/**
 * 📜 本鱼契约：运行时读取 + 解析 persona（**只读**，不缓存、不复制内容）。
 * @param {{file?:string, cap?:number}} [opts] file 仅供单测指向临时副本
 */
export function readPersonaContract(opts = {}) {
  const file = opts.file ?? findPersonaFile();
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* 下面统一降级 */ }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const hit = findPersonaTextBlock(raw);
    const block = hit ? extractPersonaText(raw) : null;
    if (block === null) {
      return {
        ok: false,
        key: null,
        error: `persona 块标量（${PERSONA_TEXT_KEYS.map((k) => k + ': |-').join(' / ')}）未找到`,
        file,
        mtime: stat?.mtimeMs ?? null
      };
    }
    const groups = parsePersonaContract(block, opts);
    const total = groups.reduce((n, g) => n + g.items.length, 0);
    // 四类计数（🔑 暗号 / ⚖️ 铁律 / 🐋 身份 / 🤝 偏好）——前端筛选条用；与 total 恒等
    const counts = {};
    for (const [key] of CONTRACT_KINDS) counts[key] = 0;
    for (const g of groups) for (const it of g.items) counts[it.kind ?? 'pref'] = (counts[it.kind ?? 'pref'] ?? 0) + 1;
    return {
      ok: total > 0,
      source: 'runtime', // 明确标记"现读现解析"，非缓存副本
      key: hit.key, // 实际命中的块标量键名（0.1.5 = prefix / 0.1.1 = text）—— 供 verify 打印与排障
      file,
      mtime: stat?.mtimeMs ?? null,
      bytes: stat?.size ?? raw.length,
      groups: groups.length,
      total,
      kinds: CONTRACT_KINDS.map(([key, icon, label]) => ({ key, icon, label, count: counts[key] ?? 0 })),
      counts,
      list: groups,
      readAt: Date.now()
    };
  } catch (e) {
    return { ok: false, key: null, error: String(e?.message ?? e), file, mtime: stat?.mtimeMs ?? null, groups: 0, total: 0, kinds: [], counts: {}, list: [] };
  }
}

// ---------------------------------------------------------------------------
// 【卡 A1 · v1.1 分片】内部采集函数对 lib/shards.mjs 开放（**仅新增导出，零语义变化**）。
//   为什么要复用到内部函数而不是让 shards.mjs 去调 buildState()：
//     core 片只需要 6 段数据，而 buildState() 全量还包含 contract（127 KB persona 解析）、
//     reports（读 14 份日报）、external 等 —— 那样等于"为了快而先算全量"，与分片初衷相反。
//   导出量最小化：只放 shards 必需且已存在语义的 6 个（不新增任何逻辑）。
// ---------------------------------------------------------------------------
export { dshHome, dshWorkspace, collectTasks, collectChangelog, collectMemory, readIgnore, OVERDUE_DAYS };
