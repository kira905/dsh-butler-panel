#!/usr/bin/env node
// dsh-butler-panel/_test/visual-baseline/static-render.mjs
//
// V31-018 卡 A · P4 视觉基线 —— **B 路：静态复刻**（离线、确定性、可进 CI）
//
// 为什么是它做主判据（而不是真宿主截图）：
//   本机实测「Agent Window 在后台时 bsk/CDP 截图拿到的是缓存帧」——同一页面连截两次
//   sha 完全相同、窗口 resize / CDP emulate 之后截图 RPC 直接 30s 超时（坑库已有同类 4 次记录）。
//   ⇒ 真宿主截图（A 路）必须在前台窗口才可靠，那属于 V31-020 在主人面前补采的活。
//   本卡把 A 路脚本留着（visual-baseline-capture.mjs，一条命令即可），基线主判据走 B 路。
//
// B 路做什么：抽**真 CSS 模板** + 用**真 class 结构**复刻 6 页 + 注入**真宿主令牌值**
// （亮/暗两套，来自宿主主题包解析 + 真机 getComputedStyle 抓取）⇒ 离线渲染。
//
// 用法：
//   node static-render.mjs --tag baseline-v31-018-pre            # 渲染 6 页 + manifest
//   node static-render.mjs --tag after --out <目录>
//
// 产物：<out>/<page>.png + manifest.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHostTokens } from './lib/host-tokens.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_FILE = fileURLToPath(import.meta.url);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = (f) => argv.includes(f);

// 卡 C 追加：`--butler <path>` / `--eco <path>` 换源码根（默认值按仓库布局推导）。
// 用途：拿回滚点里的 `.orig` 渲"改前"版本做对照 —— 比"临时替换生产文件再还原"安全得多。
const BUTLER = arg('butler', process.env.PANEL_CLIENT || path.join(HERE, '..', '..', 'lib', 'client.js'));
const ECO = arg('eco', process.env.ECO_PANEL_CLIENT || path.join(HERE, '..', '..', '..', 'dsh-ecosystem-panel', 'lib', 'client.js'));

// V31-020 追加（方案 §3.2）：
//   --formal    落"正式基线"：manifest 加 formal/pairId/renderer/chrome/sources 双尺子，
//               并在 dirname(--out) 写/并 pair.json；**撞已存在目录 ⇒ rc 3 拒动**（--force 才覆盖）
//   --pair-id   两态配对键（缺省 v31-020）
//   --force     允许 --formal 覆盖已存在的目标目录（防"标准照被悄悄换掉"，缺省拒动）
const FORMAL = has('--formal');
const FORCE = has('--force');
const PAIR_ID = arg('pair-id', 'v31-020');

const TAG = arg('tag', 'static');
// --out 相对路径按本文件所在目录解析（老行为）；V31-020 起也接受绝对路径（proof-red 要用）
const OUT_ARG = arg('out', TAG);
const OUTDIR = path.isAbsolute(OUT_ARG) ? path.resolve(OUT_ARG) : path.join(HERE, OUT_ARG);
const THEME = arg('theme', 'dark'); // dark | light
const INJECT_FILE = arg('inject-css-file');
const EXTRA_CSS = INJECT_FILE && fs.existsSync(INJECT_FILE) ? fs.readFileSync(INJECT_FILE, 'utf8') : '';

function cssOf(file, panelAttr, entryAttr) {
	const src = fs.readFileSync(file, 'utf8');
	const m = src.match(/const CSS = `([\s\S]*?)`;/);
	if (!m) throw new Error('找不到 CSS 模板: ' + file);
	return {
		src,
		css: m[1].replace(/\$\{PANEL_ATTR\}/g, panelAttr).replace(/\$\{ENTRY_ATTR\}/g, entryAttr),
	};
}

// 趋势卡（趋势 sparkline）的线条色在 JS 里当字面量传进 trendCard(...)；从源码抽出来，
// 这样"改之前/改之后"两版都由源码决定，而不是本鱼另写一份。
function trendColors(src) {
	const out = [];
	for (const m of src.matchAll(/trendCard\([^)]*?,\s*(#[0-9a-fA-F]{6}|"[^"]+"|TOK\.color\[\s*['"]([^'"]+)['"]\s*\])/g)) {
		const raw = m[1];
		if (m[2]) out.push(`var(--bp-${m[2]})`);
		else if (/^#/.test(raw)) out.push(raw);
		else out.push(raw.replace(/^"|"$/g, ''));
	}
	return out.slice(-2);
}

const chromeCandidates = [
	process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
	process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
	path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
	path.join(process.env.PROGRAMFILES ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = chromeCandidates.find((p) => p && fs.existsSync(p));

function themeVars(t) {
	// ⚠️ 曾经这里**恒取 dark 值**（`t.dark[k] || v`），于是 `--theme light` 只是摘掉了
	//    `data-ds-dark-theme`、令牌值却还是暗的 ⇒ 渲出来的"亮色态"是假的（暗底 + 暗 fg，KPI 全是糊的）。
	//    2026-10-30 卡 A 抽查浅色态时发现并订正：按 THEME 取对应那一层。
	const src = THEME === 'dark' ? t.dark : t.light;
	const rows = Object.entries(t.light).map(([k, v]) => `  ${k}:${src[k] || v};`).join('\n');
	return rows;
}

function shell({ title, css, body, w = 940, h = 1300, extraCss = '' }) {
	const tokens = readHostTokens();
	const themeAttr = THEME === 'dark' ? ' data-ds-dark-theme=""' : '';
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
/* ===== 宿主令牌（取值来自真宿主主题包；暗态取 body[data-ds-dark-theme] 那一层） ===== */
:root{
${themeVars(tokens)}
  --dsw-font-family-mono: ui-monospace, Consolas, monospace;
}
html,body{margin:0;padding:0;background:#101114;color-scheme:${THEME === 'dark' ? 'dark' : 'light'}}
/* 关动效（方案 §6.5 防抖第三条） */
*{animation:none!important;transition:none!important}
/* 只在静态页里做的"去浮层化"：面板根不再是全屏遮罩；放在真 CSS 之后才压得住 */
${extraCss}
/* ===== 真实面板 CSS（原样抽取自 lib/client.js） ===== */
${css}
/* ===== 静态页覆盖（必须在真 CSS 之后） ===== */
[data-dsh-butler-panel],[data-dsh-ecosystem-panel]{position:static;inset:auto;display:block;background:none;backdrop-filter:none;padding:20px;z-index:auto}
[data-dsh-butler-panel] .bp-card,[data-dsh-ecosystem-panel] .ep-card]{max-height:none;box-shadow:none;margin:0}
</style></head><body${themeAttr}>
${body}
</body></html>`;
}

// ── 六页的 DOM 复刻（class 全是真 class；文案固定，不含时间/计数等易变值） ───────────
function kpi(cls, num, lbl) {
	return `<div class="bp-kpi ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
}
const TABS_BUTLER = ['📊 总览', '💬 会话', '📋 任务', '📝 变更', '🧠 记忆', '🗓 报告', '📦 资产', '🐋 管家'];
function butlerTabs(on) {
	return `<div class="bp-tabs">${TABS_BUTLER.map((t, i) => `<button class="bp-tab${i === on ? ' bp-on' : ''}">${t}</button>`).join('')}</div>`;
}
function butlerHead(sub) {
	return `<div class="bp-head"><div class="bp-title">大管家总览</div><button class="bp-btn">去任务看板</button><button class="bp-btn">关闭</button><div class="bp-sub">${sub}</div></div>`;
}

function pageButlerOverview(css, colors) {
	const body = `<div data-dsh-butler-panel><div class="bp-card">
${butlerHead('基线样本 · 固定数据（视觉回归用）')}
${butlerTabs(0)}
<div class="bp-body">
  <div class="bp-audit-banner"><span class="bp-ab-icon">⏸</span><span class="bp-ab-txt">写入审计暂停中 · 理由：基线样本</span><span class="bp-ab-cd">12:00</span><button class="bp-btn">恢复</button></div>
  <div class="bp-audit-banner bp-half"><span class="bp-ab-icon">⚠</span><span class="bp-ab-txt">半完成态（样本）</span><button class="bp-btn">处理</button></div>
  <div class="bp-kpis">
    ${kpi('k-red', '0', '待我处理')}
    ${kpi('k-green', '正常', '自动归档 · 已关')}
    ${kpi('k-blue', '77', '今日自动办好')}
    ${kpi('k-yellow', '1', '资产异常')}
    ${kpi('k-cyan', '10', '在途任务')}
    ${kpi('k-purple', '0.1%', '误报率')}
  </div>
  <div class="bp-first">
    <div class="bp-block">
      <div class="bp-block-head">🕐 今日判断 <span class="cnt">· 基线样本</span><span class="right">只读</span></div>
      <div class="bp-verdict">今天 <b>0</b> 件要你处理；<b class="red">2</b> 张待验收；另有 <b>77</b> 项自动办好</div>
      <div class="bp-adv">
        <div class="bp-adv-item"><span class="bp-adv-tag">原因原文</span>待我处理 · 分项不可探测（点击展开）</div>
        <div class="bp-adv-full">（展开后的完整原文，基线样本，不含真实数据）</div>
        <div class="bp-adv-item"><span class="bp-adv-tag">建议</span>先处理 dsh-core 仓体积</div>
      </div>
    </div>
    <div class="bp-health">
      <div class="bp-health-card">
        <div class="bp-health-head"><span class="bp-health-title">自动归档</span><span class="ui-badge ui-badge--soft ui-tone-ok">正常</span></div>
        <div class="bp-health-line"><span class="k">上次成功</span><span class="v">1 小时前</span></div>
        <div class="bp-health-line bp-k-wide"><span class="k">AUDIT_HASH_MISMATCH</span><span class="v">1 次</span></div>
        <div class="bp-health-list">
          <div class="bp-health-item"><span class="dot" style="background:var(--dsw-alias-state-success-primary)"></span><span class="nm">archive</span><span class="vv">ok</span></div>
          <div class="bp-health-item"><span class="dot" style="background:var(--dsw-alias-state-warn-primary)"></span><span class="nm">imagegen</span><span class="vv">warn</span></div>
        </div>
        <div class="bp-health-more">还有 3 项</div>
      </div>
      <div class="bp-health-card">
        <div class="bp-health-head"><span class="bp-health-title">升级体检</span><span class="ui-badge ui-badge--soft ui-tone-warn">待查</span></div>
        <div class="bp-health-line"><span class="k">状态</span><span class="v">只读</span></div>
        <div class="bp-health-line"><span class="k">上次</span><span class="v">2 天前</span></div>
      </div>
      <div class="bp-health-card">
        <div class="bp-health-head"><span class="bp-health-title">重启协调器</span><span class="ui-badge ui-badge--soft ui-tone-error">异常</span></div>
        <div class="bp-health-line"><span class="k">队列</span><span class="v">2</span></div>
      </div>
    </div>
    <div class="bp-trends">
      <div class="bp-trend" style="color:${colors[0] ?? '#ff8a8d'}"><div class="t-title"><span>中断会话 · 近 14 天</span><span class="t-last">2</span></div><svg viewBox="0 0 200 46" width="100%" height="46"><polyline points="0,30 40,28 80,34 120,20 160,26 200,18" fill="none" stroke="currentColor" stroke-width="2"/><text x="0" y="44">0</text></svg></div>
      <div class="bp-trend" style="color:${colors[1] ?? '#c9a6ff'}"><div class="t-title"><span>记忆总量 · 近 14 天</span><span class="t-last">1204</span></div><svg viewBox="0 0 200 46" width="100%" height="46"><polyline points="0,34 40,30 80,24 120,22 160,16 200,12" fill="none" stroke="currentColor" stroke-width="2"/><text x="0" y="44">0</text></svg></div>
    </div>
    <div class="bp-skel">正在读取今日判断…<div class="bar"></div><div class="bar"></div></div>
    <div class="bp-degrade">重算变慢：最近 3 次均 &gt;1s（样本）</div>
  </div>
</div></div></div>`;
	return shell({ title: '大管家 · 总览', css, body, w: 940, h: 1300, extraCss: EXTRA_CSS });
}

function pageButlerTasks(css) {
	const row = (dot, name, desc, meta, acts) => `<div class="bp-row">
    <span class="bp-dot ${dot}"></span>
    <div class="bp-main"><div class="bp-name bp-sess-title">${name}</div><div class="bp-desc">${desc}</div><div class="bp-meta">${meta}</div></div>
    <div class="bp-acts">${acts}</div>
  </div>`;
	const body = `<div data-dsh-butler-panel><div class="bp-card">
${butlerHead('基线样本 · 固定数据（视觉回归用）')}
${butlerTabs(2)}
<div class="bp-body">
  <div class="bp-tab-head"><div class="bp-tab-title">任务</div><div class="bp-meta">看板在途与待处理（样本）</div></div>
  <div class="bp-cl-day">2026-10-30 <span class="today">今天</span></div>
  ${row('bp-dot-red', 'V31-018 卡 A · 设计令牌', '只改源码，不部署；判据 0/0', '主线 V3.1.0 · P1', '<button class="bp-act primary">查看</button><button class="bp-act warn">取消</button>')}
  ${row('bp-dot-yellow', 'V31-020 视觉回归', '基线比对 · 阈值 0.5%', '主线 V3.1.0 · P4', '<button class="bp-act">催办</button>')}
  ${row('bp-dot-green', 'LIFE-FILTER a 案', '已验收', '主线 人格统一', '<button class="bp-act">报告</button>')}
  ${row('bp-dot-gray', '已归档卡', '无动作', '历史', '<button class="bp-act" disabled>查看</button>')}
  ${row('bp-dot-blue', '在途任务', '执行中', '队列第 3 位', '<button class="bp-act">跟踪</button>')}
  <div class="bp-group">待处理 · 分项</div>
  <div class="bp-pend"><div class="bp-pend-top"><span class="ui-badge ui-badge--outline ui-tone-error">P0</span><div><div class="bp-name">保护区写入被拦</div><div class="bp-meta">需人工确认</div></div></div></div>
  <div class="bp-pend"><div class="bp-pend-top"><span class="ui-badge ui-badge--outline ui-tone-warn">P1</span><div><div class="bp-name">重算变慢</div><div class="bp-meta">连续 3 次</div></div></div></div>
  <div class="bp-ev">证据：queue-depth=2 · latency=1.4s（样本）</div>
  <div class="ui-badge ui-badge--outline ui-tone-error">P0</div> <div class="ui-badge ui-badge--outline ui-tone-warn">P1</div>
  <div class="ui-badge ui-badge--pin">置顶</div>
  <div class="bp-err">错误示例：接口 500（样本）</div>
  <div class="bp-zoneL3"><div class="bp-block-head">L3 保护区 · 需审计凭证</div></div>
  <div class="bp-empty">这里还没有内容</div>
  <div class="bp-cl-item"><div class="bp-cl-top"><div class="bp-cl-time">10:44</div><div class="bp-cl-main">变更流水：卡 A 建令牌真源</div></div><div class="bp-cl-meta">tools/lib/panel-tokens.mjs</div></div>
  <div class="bp-feed-item"><span class="tm">10:44</span><span class="tx">feed 示例条目</span></div>
  <div class="bp-code">const x = 1; // 代码块样本</div>
</div></div></div>`;
	return shell({ title: '大管家 · 任务', css, body, w: 940, h: 1250, extraCss: EXTRA_CSS });
}

function pageButlerAssets(css) {
	const asset = (nm, nt, ao) => `<div class="bp-asset-row"><span class="nm">${nm}</span><span class="nt">${nt}</span><span class="ao">${ao}</span></div>`;
	const body = `<div data-dsh-butler-panel><div class="bp-card">
${butlerHead('基线样本 · 固定数据（视觉回归用）')}
${butlerTabs(6)}
<div class="bp-body">
  <div class="bp-tab-head"><div class="bp-tab-title">资产</div><div class="bp-meta">体积与余量（样本）</div></div>
  ${asset('dsh-core', '仓体积占用', '370.6%')}
  ${asset('memory.db', '记忆库', '128 MB')}
  ${asset('generated', '生图产物', '2.1 GB')}
  ${asset('snapshots', '快照', '640 MB')}
  <div class="bp-bar">
    <div class="bp-seg"><span class="k">盘余量</span><span class="v">12 GB</span></div>
    <div class="bp-seg"><span class="k">冷盘</span><span class="v">已挂载</span></div>
    <div class="bp-seg"><span class="k">备份</span><span class="v">6 份</span></div>
  </div>
  <div class="bp-note">资产为只读统计，不触发清理。</div>
</div></div></div>`;
	return shell({ title: '大管家 · 资产', css, body, w: 940, h: 760, extraCss: EXTRA_CSS });
}

const TABS_ECO = ['插件', '注入', '补丁', '技能', '解耦', '升级体检'];
function ecoTabs(on) {
	return `<div class="ep-tabs">${TABS_ECO.map((t, i) => `<button class="ep-tab${i === on ? ' ep-on' : ''}">${t}${i === 0 ? '<span class="ep-tdot" style="background:var(--dsw-alias-state-success-primary)"></span>' : ''}</button>`).join('')}</div>`;
}
function ecoShell(css, on, body) {
	const html = `<div data-dsh-ecosystem-panel><div class="ep-card">
  <div class="ep-head"><div class="ep-title">生态面板</div><button class="ep-btn">刷新</button><button class="ep-btn">关闭</button><div class="ep-sub">基线样本 · 固定数据</div></div>
  ${ecoTabs(on)}
  <div class="ep-body">${body}</div>
</div></div>`;
	return shell({ title: '生态面板', css, body: html, w: 860, h: 1000, extraCss: EXTRA_CSS });
}
function ecoRow(dot, name, desc, badge) {
	return `<div class="ep-row"><span class="ep-dot ${dot}"></span><div class="ep-main"><div class="ep-name">${name}${badge ? `<span class="ui-badge ui-badge--plain">${badge}</span>` : ''}</div><div class="ep-desc">${desc}</div><div class="ep-meta">状态：正常</div></div></div>`;
}
function pageEcoBundles(css) {
	const body = `<div class="ep-summary"><span class="ep-chip">已装 12</span><span class="ep-chip">启用 11</span><span class="ep-chip">停用 1</span></div>
  <div class="ep-group">插件</div>
  ${ecoRow('dot-green', 'dsh-butler-panel', '大管家面板 0.9.0', '内置')}
  ${ecoRow('dot-green', 'dsh-ecosystem-panel', '生态面板 0.3.2', '内置')}
  ${ecoRow('dot-yellow', 'dsh-imagegen', 'AI 生图 1.5.10', '')}
  ${ecoRow('dot-red', 'dsh-whale-on-desk', '桌宠 · 加载失败', '')}
  ${ecoRow('dot-retired', 'dsh-old-panel', '已退役', '')}
  ${ecoRow('dot-unknown', 'dsh-unknown', '状态未知', '')}
  <div class="ep-note">状态点：绿=启用 / 黄=待查 / 红=异常 / 灰=退役</div>`;
	return ecoShell(css, 0, body);
}
function pageEcoSkills(css) {
	const body = `<div class="ep-summary"><span class="ep-chip">技能 40</span><span class="ep-chip">自定义 31</span></div>
  <div class="ep-group">技能</div>
  ${ecoRow('dot-green', 'task-board', '看板卡管理标准流程', '常用')}
  ${ecoRow('dot-green', 'dsh-butler', '大管家自主机制运维', '')}
  ${ecoRow('dot-green', 'plugin-deploy', '插件部署标准流程', '')}
  ${ecoRow('dot-yellow', 'cross-host-ops', '跨机代行（对端未连）', '')}
  ${ecoRow('dot-green', 'whalechan-character', '鲸鱼娘角色一致性', '')}`;
	return ecoShell(css, 3, body);
}
function pageEcoUpgrades(css) {
	const body = `<div class="ep-summary"><span class="ep-chip">体检 只读</span></div>
  <div class="ep-group">升级体检</div>
  ${ecoRow('dot-yellow', '主包 0.1.5-alpha.1', '可升（需主人批准）', '')}
  <div class="ep-prob">断裂面：session 事件词表（assistant/chunk 被移除）</div>
  ${ecoRow('dot-green', '插件对升审计', '无阻断', '')}
  <div class="ep-err">示例错误：审计工具只能比 import 符号（样本）</div>
  <div class="ep-note">升级永不在卡会话执行。</div>`;
	return ecoShell(css, 5, body);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────
if (!CHROME) { console.error('找不到 chrome/edge'); process.exit(2); }

// --formal 撞已存在目录 ⇒ rc 3 拒动（方案 §3.2.1 / I4：不许"标准照被悄悄换掉"）
if (FORMAL && fs.existsSync(OUTDIR) && !FORCE) {
	console.error(`拒动：目标目录已存在：${OUTDIR}`);
	console.error('  ⇒ 正式基线一旦落了就不许静默覆盖（防"标准照被换掉"）。要换基线：先移走旧目录，或显式加 --force 并在交付报告写明"何时换的、为什么换"。');
	process.exit(3);
}

// 部署实体（B8 对账用；拿不到 = null，不报错）
const PROFILE_WEB = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules');
const DEPLOYED = {
	butler: path.join(PROFILE_WEB, 'dsh-butler-panel', 'lib', 'client.js'),
	eco: path.join(PROFILE_WEB, 'dsh-ecosystem-panel', 'lib', 'client.js'),
};
function chromeVersion(p) {
	// 不用 `chrome --version`：Windows 上它会走"已有会话"分支、打一行中文提示（实测 rc≠0）；
	// 安装目录下有一个以版本号命名的子目录（Applications\156.0.8078.48\）⇒ 取它（多个取最大）
	try {
		const vers = fs.readdirSync(path.dirname(p), { withFileTypes: true })
			.filter((e) => e.isDirectory() && /^\d+(\.\d+){1,3}$/.test(e.name))
			.map((e) => e.name)
			.sort((a, b) => {
				const x = a.split('.').map(Number), y = b.split('.').map(Number);
				for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
				return 0;
			});
		if (vers.length) return vers[vers.length - 1];
	} catch { /* 拿不到就算了 */ }
	return null;
}

fs.mkdirSync(OUTDIR, { recursive: true });
const tmpDir = path.join(HERE, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const B = cssOf(BUTLER, 'data-dsh-butler-panel', 'data-dsh-butler-entry');
const E = cssOf(ECO, 'data-dsh-ecosystem-panel', 'data-dsh-ecosystem-entry');
const trendCols = trendColors(B.src);

const PAGES = [
	{ key: 'butler-overview', label: '大管家 · 总览', html: pageButlerOverview(B.css, trendCols) },
	{ key: 'butler-tasks', label: '大管家 · 任务', html: pageButlerTasks(B.css) },
	{ key: 'butler-assets', label: '大管家 · 资产', html: pageButlerAssets(B.css) },
	{ key: 'eco-bundles', label: '生态 · 插件', html: pageEcoBundles(E.css) },
	{ key: 'eco-skills', label: '生态 · 技能', html: pageEcoSkills(E.css) },
	{ key: 'eco-upgrades', label: '生态 · 升级体检', html: pageEcoUpgrades(E.css) },
];

const manifest = {
	kind: 'v31-018-visual-baseline-static',
	tag: TAG,
	theme: THEME,
	capturedAt: new Date().toISOString(),
	capturedAtLocal: new Date().toLocaleString('sv-SE'),
	sources: {
		butler: BUTLER, eco: ECO, butlerSha: sha(BUTLER), ecoSha: sha(ECO),
		// --formal 下另记"源码 vs 部署"两把尺子（B8「部署没走样」对账用）
		...(FORMAL ? {
			repoSha: { butler: sha(BUTLER), eco: sha(ECO) },
			deployedSha: {
				butler: fs.existsSync(DEPLOYED.butler) ? sha(DEPLOYED.butler) : null,
				eco: fs.existsSync(DEPLOYED.eco) ? sha(DEPLOYED.eco) : null,
			},
			deployedPath: DEPLOYED,
		} : {}),
	},
	// --formal 才写：一眼认出"这是标准照"；渲染器/浏览器变了能区分出来
	...(FORMAL ? {
		formal: true,
		pairId: PAIR_ID,
		renderer: { file: RENDERER_FILE, sha256: sha(RENDERER_FILE) },
		chrome: { path: CHROME, version: chromeVersion(CHROME) },
	} : {}),
	trendColors: trendCols,
	note: [
		'B 路静态复刻：真 CSS 模板（原样抽取）+ 真 class 结构 + 真宿主令牌值（解析自宿主主题包）。',
		'不是真面板（不含宿主 shell 的布局与注入样式），只能守"组件自身没改坏"——这正是本卡要的：',
		'颜色别名化只动颜色，任何肉眼可见差异都必须来自允许清单。',
		'渲染确定性：固定窗口尺寸 + DPR=1 + 关动效 + 固定文案（无时间戳/计数）。',
	],
	pages: [],
};

function sha(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

for (const p of PAGES) {
	const htmlPath = path.join(tmpDir, p.key + '.html');
	fs.writeFileSync(htmlPath, p.html, 'utf8');
	const outPng = path.join(OUTDIR, p.key + '.png');
	fs.rmSync(outPng, { force: true });
	// 页面尺寸由页面里的 <body> 自撑；用 --window-size 给足空间（多余区域是固定底色）
	const w = p.key.startsWith('eco') ? 860 : 940;
	const h = p.key === 'butler-overview' ? 1300 : p.key === 'butler-tasks' ? 1250 : p.key === 'butler-assets' ? 760 : 1000;
	const r = spawnSync(CHROME, [
		'--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
		`--window-size=${w},${h}`, `--screenshot=${outPng}`,
		'file:///' + htmlPath.replace(/\\/g, '/'),
	], { encoding: 'utf8', timeout: 90000 });
	if (!fs.existsSync(outPng)) {
		console.error(`FAIL ${p.key}: 截图未生成 rc=${r.status} ${(r.stderr || '').slice(0, 300)}`);
		process.exitCode = 1;
		continue;
	}
	const st = fs.statSync(outPng);
	manifest.pages.push({ key: p.key, label: p.label, file: p.key + '.png', windowPx: { w, h }, bytes: st.size, sha256: sha(outPng) });
	console.log(`  ✔ ${p.key}  ${w}x${h}  ${st.size} B  ${sha(outPng).slice(0, 12)}`);
}

fs.writeFileSync(path.join(OUTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nmanifest → ${path.join(OUTDIR, 'manifest.json')}`);
console.log(`页数 ${manifest.pages.length} · theme=${THEME} · trendColors=${JSON.stringify(trendCols)}`);

// --formal：pair.json 落在 dirname(--out)（两态成对登记；页 sha 由各态 manifest 同源生成，
// 冲突时以 manifest 为权威源 —— 见方案 §10.1）
if (FORMAL) {
	const root = path.dirname(OUTDIR);
	const pairFile = path.join(root, 'pair.json');
	let pair = null;
	if (fs.existsSync(pairFile)) {
		pair = JSON.parse(fs.readFileSync(pairFile, 'utf8'));
		if (pair.tag && pair.tag !== TAG) {
			console.error(`拒动：${pairFile} 已存在且 tag=${pair.tag} ≠ 本次 ${TAG}（一对基线只认一个 tag，换 tag 请用新目录）`);
			process.exit(3);
		}
	}
	pair = pair ?? { pairId: PAIR_ID, tag: TAG, createdAt: new Date().toISOString(), themes: {} };
	pair.pairId = PAIR_ID;
	pair.tag = TAG;
	pair.renderer = { file: RENDERER_FILE, sha256: sha(RENDERER_FILE) };
	pair.chrome = { path: CHROME, version: chromeVersion(CHROME) };
	pair.themes = pair.themes ?? {};
	pair.themes[THEME] = {
		dir: path.relative(root, OUTDIR).split(path.sep).join('/'),
		manifest: path.basename(OUTDIR) + '/manifest.json',
		formal: true,
		capturedAtLocal: manifest.capturedAtLocal,
		pages: Object.fromEntries(manifest.pages.map((p) => [p.key, p.sha256])),
	};
	if (!pair.defaultTheme) pair.defaultTheme = THEME;
	fs.writeFileSync(pairFile, JSON.stringify(pair, null, 2) + '\n', 'utf8');
	console.log(`pair.json → ${pairFile}（已登记两态：${Object.keys(pair.themes).join(' / ')}）`);
}
