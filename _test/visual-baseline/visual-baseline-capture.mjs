#!/usr/bin/env node
// dsh-butler-panel/_test/visual-baseline/visual-baseline-capture.mjs
//
// V31-018 卡 A · P4 视觉基线采集（A 路 = 真宿主截图）
//
// 为什么先采：V31-020 的判据是「删掉重复实现后关键页视觉回归差异 ≈ 0」。
// 这句话只有**先有基线**才可判；先改再存基线等于"我说没变就没变"（方案 §6.1）。
//
// 用法（bsk daemon 已在跑、Agent Window 会话已开）：
//   node visual-baseline-capture.mjs --session <bskSessionId> --tag baseline-v31-018-pre
//
// 产物：<本目录>/<tag>/<page>.png + manifest.json
//
// 稳定性口径（写进 manifest，供 V31-020 复用）：
//   · 面板遮罩背景临时替换为不透明纯色（#101114）并关掉 backdrop-filter
//     —— 否则卡片外的会话列表/动画会逐帧变化，逐像素比对永远红。
//   · 只裁 .bp-card / .ep-card 的包围盒，圆角外的角落必然含纯色背景 ⇒ 稳定。
//   · 视口 1440x900（Agent Window 请求值）、DPR 跟随本机（记录在 manifest）。
//   · 每页切换后等 1500ms 让数据渲染稳定。
//
// 2026-10-30（A 路掩码卡）新增两件，都为了「同源码两次采集裁出来的图尺寸一致」：
//   · --settle 后追加 **等布局落定**（waitStable）：卡片高度连续 3 次采样不变 + 正文有真内容才截图。
//     首采的 butler-assets 裁出 630 px（= 420 css）而对照次是 1111 px，实测证明那是**加载中骨架**
//     （同一次采集里 assets 正文 1245 px / 可视 614 px、卡片高度恒等于 max-height 封顶，
//      见 docs\交付报告-A路掩码-20261030.md §3）：等布局落定后不再出现。
//   · --fix-height（默认开，`--no-fix-height` 关）**把卡片高度钉到它自己的 computed max-height**。
//     卡片 CSS 是 max-height + 高度自适应 ⇒ 正文一变短整卡就变矮、裁图尺寸跟着变、逐像素直接判红。
//     钉高只抬高不压矮，内容仍从顶部排、正文仍走自己的滚动容器 ⇒ 渲染内容不受影响，
//     变的只是「裁多高」。代价：卡片「本该更矮」这类自适应高度回归不再由像素尺寸判据覆盖
//     （内容回归照旧比得出来），详见交付报告 §3.4。
//   · 视口/DPR 必须与被比对的那套基线一致：裁后图像素坐标是「相对裁后图」，视口一变，
//     卡片高度（= 88% 视口高）跟着变 ⇒ 图尺寸变 ⇒ 掩码 bbox 也不再对得上（掩码件用 appliesTo 兜）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BSK = process.env.BSK_EXE || path.join(process.env.APPDATA ?? '', 'npm', 'bsk.exe');
const CROP = path.join(HERE, 'lib', 'crop.ps1');
const TMP = path.join(HERE, '.tmp');

const argv = process.argv.slice(2);
const arg = (k, d) => {
	const i = argv.indexOf('--' + k);
	return i >= 0 ? argv[i + 1] : d;
};
const SESSION = arg('session');
const TAG = arg('tag', 'baseline');
const OUTDIR = path.join(HERE, arg('out', TAG));
// 2026-10-30（第 48 棒 A 路首采）：固定 1500ms 对生态面板不够 —— 生态卡片要拉 112 条体检数据，
// 截图拍到的是「刷新中…」+ 说明文字（实测三页都只有 292 px 高、无数据）。按面板给默认等待，
// 并允许 --settle <ms> 全局覆盖（0 = 用默认）。
const SETTLE = Number(arg('settle', '0'));
const settleFor = (panel) => (SETTLE > 0 ? SETTLE : (panel === 'eco' ? 6000 : 1500));
// A 路掩码卡（2026-10-30）：等布局落定 + 钉卡片高度，见文件头口径
const FIX_H = !argv.includes('--no-fix-height');
const STABLE_BUDGET = Number(arg('stable-budget', '6000'));
// --inject <css>：采集时往页面注入一段 CSS（"先证红"演练用：复用 proof\red-inject.css 造一处已知色变）。
// 只注入到当前页面、收尾删除，不改任何源码。
const INJECT = arg('inject', null);

if (!SESSION) {
	console.error('用法: node visual-baseline-capture.mjs --session <bskSessionId> [--tag <名字>]');
	process.exit(2);
}

const PAGES = [
	{ panel: 'butler', tab: 0, key: 'butler-overview', label: '大管家 · 总览' },
	{ panel: 'butler', tab: 2, key: 'butler-tasks', label: '大管家 · 任务' },
	{ panel: 'butler', tab: 6, key: 'butler-assets', label: '大管家 · 资产' },
	{ panel: 'eco', tab: 0, key: 'eco-bundles', label: '生态 · 插件' },
	{ panel: 'eco', tab: 3, key: 'eco-skills', label: '生态 · 技能' },
	{ panel: 'eco', tab: 5, key: 'eco-upgrades', label: '生态 · 升级体检' },
];

function bsk(args, { json = false } = {}) {
	const r = spawnSync(BSK, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, BSK_AUTO_START: '0' } });
	if (r.status !== 0) throw new Error(`bsk ${args[0]} failed rc=${r.status}: ${(r.stderr || '').slice(0, 300)}`);
	return json ? r.stdout : r.stdout.trim();
}
function ev(expr) {
	// CLI 对字符串值直接打印原文（不加引号），对对象打印 JSON ⇒ 一律按"文本"返回，调用方按需 parse。
	return bsk(['evaluate', '--session', SESSION, expr]).trim();
}
// 2026-10-30（第 48 棒 · A 路首采修）：原来用 `bsk wait-ms` 睡眠 —— bsk 0.3.2 **没有这个子命令**
// （`bsk wait-ms` 直接报 usage），spawnSync 的非零返回又没被检查 ⇒ **等待从来没生效**，
// 面板还在「刷新中…」就截图了（实测生态三页只有 292 px 高、两次采集 sha 完全相同）。
// 改成纯 Node 同步睡眠（Atomics.wait），不依赖外部 CLI。
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function openPanel(panel) {
	if (panel === 'butler') {
		return ev(`(()=>{const e=document.querySelector('[data-dsh-butler-entry]');if(!e)return 'NO_ENTRY';e.click();return 'ok';})()`);
	}
	return ev(`(()=>{const e=document.querySelector('[data-dsh-ecosystem-entry]');if(!e)return 'NO_ENTRY';e.click();return 'ok';})()`);
}
function closePanels() {
	return ev(`(()=>{let n=0;for(const p of document.querySelectorAll('[data-dsh-butler-panel],[data-dsh-ecosystem-panel]')){const b=[...p.querySelectorAll('button')].find(x=>x.textContent.trim()==='关闭');if(b){b.click();n++;}}return 'closed:'+n;})()`);
}
function normalizeStage(panel) {
	// 面板遮罩背景 → 不透明纯色；关掉模糊。卡片内渲染完全不受影响。
	// A 路掩码卡（2026-10-30）：bsk 自己的自动化浮层 <browser-skill-overlay>（"Agent 正在控制 / 中断"）
	//   压在卡片底部、而且**藏不掉** —— 它自带 :host{all:initial !important}（优先级压过页面与内联样式），
	//   删掉还会被立刻重新注入（实测 try remove 后再删就陷入"删↔注入"死循环，把页面主线程卡死，
	//   只能 stop session 救回来）。⇒ 不藏它，改成**掩码**：浮层区在掩码件里是固定 bbox
	//   （视口锚定、坐标确定），并把"浮层出现/消失"当已知噪声，见 a-masks\v31-020-host.json。
	const attr = panel === 'butler' ? 'data-dsh-butler-panel' : 'data-dsh-ecosystem-panel';
	return ev(`(()=>{const p=document.querySelector('[${attr}]');if(!p)return 'NOPANEL';p.style.background='#101114';p.style.backdropFilter='none';return 'ok';})()`);
}
function clickTab(panel, i) {
	const cls = panel === 'butler' ? '.bp-tab' : '.ep-tab';
	const attr = panel === 'butler' ? 'data-dsh-butler-panel' : 'data-dsh-ecosystem-panel';
	return ev(`(()=>{const t=document.querySelectorAll('[${attr}] ${cls}');if(!t[${i}])return 'NO_TAB:'+t.length;t[${i}].click();return t[${i}].textContent.trim();})()`);
}
function rect(panel) {
	const card = panel === 'butler' ? '.bp-card' : '.ep-card';
	const attr = panel === 'butler' ? 'data-dsh-butler-panel' : 'data-dsh-ecosystem-panel';
	const raw = ev(`(()=>{const c=document.querySelector('[${attr}] ${card}');if(!c)return 'NO_CARD';const r=c.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height,dpr:window.devicePixelRatio,vw:innerWidth,vh:innerHeight});})()`);
	try { return JSON.parse(raw); } catch { throw new Error('rect 解析失败: ' + raw); }
}

// ── A 路掩码卡新增：等布局落定 + 钉卡片高度 ───────────────────────────────────
// probeCard 返回：卡片高度 / computed max-height / 正文滚动容器的高度与文字量
function probeCard(panel) {
	const card = panel === 'butler' ? '.bp-card' : '.ep-card';
	const body = panel === 'butler' ? '.bp-body' : '.ep-body';
	const attr = panel === 'butler' ? 'data-dsh-butler-panel' : 'data-dsh-ecosystem-panel';
	const raw = ev(`(()=>{const c=document.querySelector('[${attr}] ${card}');if(!c)return 'NO_CARD';const r=c.getBoundingClientRect();const b=c.querySelector('${body}');const cs=getComputedStyle(c);return JSON.stringify({h:r.height,maxH:cs.maxHeight,bs:b?b.scrollHeight:0,bc:b?b.clientHeight:0,txt:b?b.textContent.replace(/\\s+/g,'').length:0});})()`);
	try { return JSON.parse(raw); } catch { throw new Error('probeCard 解析失败: ' + raw); }
}
// 落定判据：高度连续 3 次采样（200ms）不变 且 正文有真内容（>200 字，排除「刷新中…」骨架）
function waitStable(panel, budget) {
	const t0 = Date.now();
	let prev = null, same = 0, last = probeCard(panel);
	while (Date.now() - t0 < budget) {
		sleep(200);
		const cur = probeCard(panel);
		last = cur;
		const sameH = Math.abs(cur.h - (prev?.h ?? -1)) < 0.5;
		same = sameH ? same + 1 : 0;
		prev = cur;
		if (same >= 2 && cur.txt > 200) return { ok: true, waitedMs: Date.now() - t0, ...cur };
	}
	return { ok: false, waitedMs: Date.now() - t0, ...last };
}
// 钉高：只抬高不压矮（卡片 CSS = max-height + 高度自适应；短内容会把整卡压矮 ⇒ 裁图尺寸变）
function pinHeight(panel) {
	if (!FIX_H) return { pinned: false, why: '--no-fix-height' };
	const card = panel === 'butler' ? '.bp-card' : '.ep-card';
	const attr = panel === 'butler' ? 'data-dsh-butler-panel' : 'data-dsh-ecosystem-panel';
	const before = probeCard(panel);
	const m = /^([\d.]+)px$/.exec(String(before.maxH));
	if (!m) return { pinned: false, why: `max-height 不是 px（${before.maxH}）`, from: before.h, to: before.h };
	const target = Number(m[1]);
	if (!(target > before.h + 0.5)) return { pinned: false, why: 'already at max-height', from: before.h, to: before.h };
	ev(`(()=>{const c=document.querySelector('[${attr}] ${card}');if(!c)return 'NO_CARD';c.style.height='${target}px';return 'ok';})()`);
	sleep(200);
	const after = probeCard(panel);
	return { pinned: true, from: before.h, to: after.h, target };
}

function crop(inPng, outPng, x, y, w, h) {
	const r = spawnSync('pwsh', ['-NoProfile', '-File', CROP, '-InPath', inPng, '-OutPath', outPng,
		'-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h)], { encoding: 'utf8', timeout: 120000 });
	if (r.status !== 0) throw new Error('crop 失败: ' + (r.stderr || '').slice(0, 300));
	return (r.stdout || '').trim();
}

function sha256(f) {
	return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}
// 2026-10-30（A 路掩码卡实测）：Agent Window 不可见（被遮挡/最小化）时 Chrome 把标签页标成 hidden，
// 渲染被节流 ⇒ `bsk screenshot` 拿到的是**旧帧**。实测事故：六页 sha 全一样、内容还是上一页
// （r8：butler 三页 sha=ee38456ac5da、eco 三页也截到 butler 面板）。⇒ 采前必须先确认 visible。
function assertVisible() {
	// 被遮挡/最小化时 Chrome 把标签页标成 hidden、渲染被节流 ⇒ 截图会拿到旧帧。
	// 自愈：调一次 `bsk window resize`（实测它会把 Agent Window 显示出来）。带 emulate 时
	// 视口由 emulation 钉住，窗口尺寸怎么变都不影响 innerWidth/innerHeight，所以不会改几何。
	let state = String(ev(`document.visibilityState`)).trim();
	for (let i = 0; i < 3 && state !== 'visible'; i++) {
		bsk(['window', 'resize', '--session', SESSION, '--width', '1721', '--height', '1026']);
		sleep(400);
		state = String(ev(`document.visibilityState`)).trim();
	}
	if (state !== 'visible') {
		throw new Error(`Agent Window 当前 ${state}（隐藏/被遮挡，已试 3 次 bsk window resize）⇒ 截图会拿到旧帧。` +
			`先把窗口显示出来再采，或用 bsk_tabs select 切到该 tab。`);
	}
}

fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// 「先证红」注入（可选）：把 CSS 塞进 <style id="__a_path_inject">，收尾删掉
if (INJECT) {
	if (!fs.existsSync(INJECT)) throw new Error(`--inject 文件不存在：${INJECT}`);
	const css = fs.readFileSync(INJECT, 'utf8');
	const ok = ev(`(()=>{const s=document.createElement('style');s.id='__a_path_inject';s.textContent=${JSON.stringify(css)};document.head.appendChild(s);return 'injected:'+s.sheet.cssRules.length;})()`);
	console.log(`注入 ${path.basename(INJECT)} → ${ok.trim()}`);
}

const manifest = {
	kind: 'v31-018-visual-baseline',
	tag: TAG,	capturedAt: new Date().toISOString(),
	capturedAtLocal: new Date().toLocaleString('sv-SE'),
	session: SESSION,
	note: [
		'真宿主截图（A 路）。面板遮罩背景采集时替换为纯色 #101114、关闭 backdrop-filter，',
		'以便裁出的卡片区域逐像素稳定（否则卡片外的会话列表动画会让比对永远判红）。',
		'卡片内部渲染 = 宿主真实令牌 + 真实数据，未做任何样式覆盖。',
		'⚠️ 卡片内含动态数据（时间戳/KPI 数字/会话计数）：逐像素判据必须先掩码这些文字区域，',
		'   否则同一份代码两次采集也会判红 —— 见 manifest 的 dynamicRegions 说明与 V31-020。',
		'2026-10-30（A 路掩码卡）：settle 之后追加「等布局落定」，并默认把卡片高度钉到它自己的',
		'   computed max-height（--no-fix-height 可关）；动态区掩码件见 a-masks\\v31-020-host.json。',
	],
	fixHeight: FIX_H,
	stableBudgetMs: STABLE_BUDGET,
	injectedCss: INJECT ? path.basename(INJECT) : null,
	viewport: null,
	dpr: null,
	pages: [],
};

let stageOk = null;
for (const p of PAGES) {
	closePanels();
	sleep(300);
	const opened = openPanel(p.panel);
	if (String(opened).startsWith('NO_ENTRY')) throw new Error(`打不开 ${p.panel} 面板：${opened}`);
	sleep(500);
	normalizeStage(p.panel);
	stageOk = true;
	const tabLabel = clickTab(p.panel, p.tab);
	if (String(tabLabel).startsWith('NO_TAB')) throw new Error(`${p.panel} tab ${p.tab} 不存在：${tabLabel}`);
	const settleMs = settleFor(p.panel);
	sleep(settleMs);
	// A 路掩码卡：settle 之后再等布局真正落定（高度稳 + 正文有内容），然后钉高
	const stable = waitStable(p.panel, STABLE_BUDGET);
	const pin = pinHeight(p.panel);
	if (!stable.ok) console.log(`  ⚠ ${p.key}: 布局落定超时（${stable.waitedMs}ms，高度 ${stable.h}，正文 ${stable.txt} 字），按当前状态截图`);
	const r = rect(p.panel);
	manifest.viewport = manifest.viewport ?? { w: r.vw, h: r.vh };
	manifest.dpr = manifest.dpr ?? r.dpr;
	const tmpPng = path.join(TMP, p.key + '.raw.png');
	assertVisible();
	bsk(['screenshot', '--session', SESSION, '--out', tmpPng]);
	const X = Math.round(r.x * r.dpr);
	const Y = Math.round(r.y * r.dpr);
	const W = Math.round(r.w * r.dpr);
	const H = Math.round(r.h * r.dpr);
	const outPng = path.join(OUTDIR, p.key + '.png');
	const cropMsg = crop(tmpPng, outPng, X, Y, W, H);
	const st = fs.statSync(outPng);
	manifest.pages.push({
		key: p.key, label: p.label, panel: p.panel, tabIndex: p.tab, tabLabel: String(tabLabel).trim(),
		rectCss: { x: r.x, y: r.y, w: r.w, h: r.h },
		cropPx: { x: X, y: Y, w: W, h: H },
		settleMs, stable: { ok: stable.ok, waitedMs: stable.waitedMs, h: stable.h, maxH: stable.maxH, bodyScroll: stable.bs, bodyClient: stable.bc, txtLen: stable.txt },
		pinHeight: pin,
		file: p.key + '.png', bytes: st.size, sha256: sha256(outPng), crop: cropMsg,
	});
	console.log(`  ✔ ${p.key}  ${String(tabLabel).trim()}  ${W}x${H}  ${st.size} B  ${sha256(outPng).slice(0, 12)}  [settle ${settleMs}+stable ${stable.waitedMs}ms${pin.pinned ? ` · 钉高 ${pin.from}→${pin.to}` : ''}]`);
}

// 收尾：把遮罩背景 / 钉过的高度 / 注入的 CSS 恢复（不留在用户浏览器里）
ev(`(()=>{const inj=document.getElementById('__a_path_inject');if(inj)inj.remove();for(const p of document.querySelectorAll('[data-dsh-butler-panel],[data-dsh-ecosystem-panel]')){p.style.background='';p.style.backdropFilter='';for(const c of p.querySelectorAll('.bp-card,.ep-card')){c.style.height='';}}return 'restored';})()`);

fs.writeFileSync(path.join(OUTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`\nmanifest → ${path.join(OUTDIR, 'manifest.json')}`);
console.log(`页数 ${manifest.pages.length} · 视口 ${manifest.viewport.w}x${manifest.viewport.h} @DPR ${manifest.dpr} · stage=${stageOk}`);
