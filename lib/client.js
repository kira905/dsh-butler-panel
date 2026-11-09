// dsh-butler-panel / lib/client.js（浏览器端）—— 大管家 v0.2.0 仪表盘
// 侧边栏底部「设置」齿轮上方注入"大管家"入口（紧邻生态面板按钮之后）；点击展开仪表盘浮层。
// v0.2.0（2026-09-09 主人定）：①总览页新增「🩺 健康监控（只读）」——会话自动归档状态 +
// 升级体检汇总（🔴🟡 计数 + 待升级清单）②变更 Tab 改倒序（最新在最上，与记忆一致；
// 条目后的续行归入该条目，倒序不串位）。
// v1.4.2（2026-09-09 主人点破"闭环一个刷新还是 10 个"）：中断清单改双判据（时间窗口 + 回合未收尾），
// 行内显示"回合卡在哪"，并显示"窗口内已正常收尾 N 个不再计入"。
// v1.4（主人 4 点验证意见）：①打开恒落总览（不再中断>0 抢跳会话页）②挂起超时正名「挂起任务」
// ③档案拆三 Tab（变更/记忆/报告各自独立页；变更逐行卡片式渲染替代一大坨等宽 code；点 KPI 直达对应页）
// ④记忆全量分页（60/页加载更多 + 点击展开全文）。
// v1.1：Tab 分区（总览 KPI+趋势 / 会话 / 任务 / 报告）+ 中断会话行显示标题与操作
//（打开跳转 / 一键转看板卡 / 忽略）+ 忽略撤销（本次打开内）+ 日报周报点开预览。
// 【路 A · 官方槽迁移 2026-09-23】下区按钮改用官方槽 sidebar.footer.action（shell 放进 footerActions、
// 传 wide；按钮外观照官方设置 trigger 自绘）——不再复制齿轮 className、不再靠 [data-sidebar-collapsed]
// 前缀 hack；拿不到 slots/React 时自动回落旧 self-heal 注入路径（规范 docs\侧边栏UI按钮对齐规范.md）。
// 跳转为实验特性（主包 sessionRow 行 React onClick 模拟点击），失败降级复制会话 id。
window.__ModuleLoader__.load({
	// 🔴【0.9.5 · 2026-11-09】这里的 id 必须是 **package.json#name**（带 scope）。
	// 客户端模块表按这个 id 登记，而宿主的 boot graph 行 id 也来自包的真名 ——
	// 写成不带 scope 的 "dsh-butler-panel" 会对不上行 id，宿主直接报
	// `…/client.js already executed without registering "@kira905/dsh-butler-panel"`
	// 然后**整个桌面版起不来**（2026-11-09 A-8 关 4 真机实测那份崩溃弹窗）。
	// 同一个病根在本包一共三处：挂载条目 name、这句 id、require 适配层的名字。
	id: "@kira905/dsh-butler-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// 【路 A · 官方槽迁移 2026-09-23】注册 sidebar.footer.action 需要 React 渲染函数（slot 由 shell 用 React 渲染）。
		// 拿不到 React / 拿不到 slots 服务时一律回落旧的 DOM 注入路径（见 mountSlotEntry 的 ok 语义）。
		let React = null;
		try { React = require("react"); } catch { React = null; }
		/** 【adapter P3 · 2026-09-25】客户端适配层：ctx 服务名 / 事件名的唯一来源。
		 *  浏览器 bundle 拿不到各包的 lib/host-adapter.js 副本（宿主按 exports["./client"] **单文件**
		 *  serve），故由 dsh-host-adapter-client 的 client 面提供常量；本包 package.json 的
		 *  `dsh.client.external` 已声明它 —— 宿主据此排序 boot graph，保证依赖先 register，
		 *  同步 require 才命中模块表（不声明 = require MISS = 整个 client bundle 崩）。
		 *
		 *  🔴【0.9.4 · 2026-11-09】两条曾经把整个面板打死的事实：
		 *  ① 从注册表装的是 **@kira905/dsh-host-adapter-client**（package.json#name 带 scope），
		 *     而 boot graph 的行 id = 那个 name ⇒ 裸 `require("dsh-host-adapter-client")` 找不到行、
		 *     整个 client bundle 在 factory 顶层就抛，侧边栏连入口都不出现（没有任何错误提示）。
		 *  ② 老 profile 里那份是**不带 scope** 的本地件（name = dsh-host-adapter-client）。
		 *  ⇒ 两个名字都试，谁在就用谁；都没有也只是缺一个常量，本面板照常挂（下面有同值兜底），
		 *     绝不因为一个依赖名字对不上而整块消失。 */
		let ADAPTER = null;
		try { ADAPTER = require("@kira905/dsh-host-adapter-client"); } catch (e1) {
			try { ADAPTER = require("dsh-host-adapter-client"); } catch (e2) { ADAPTER = null; }
		}
		//#region consts
		const ENTRY_ATTR = "data-dsh-butler-entry";
		const ENTRY_SELECTOR = "[" + ENTRY_ATTR + "]";
		const PANEL_ATTR = "data-dsh-butler-panel";
		const ECO_ENTRY_SELECTOR = "[data-dsh-ecosystem-entry]";
		const API = "/api/dsh-butler/state";
		// 【V2-D 首屏瘦身】首屏只请求这**三片** —— **现存首屏块的数据源并集必须等于这个集合**：
		//   ⚠️【V3-A2 · 2026-10-21】`metrics` 已移出首屏（异步后补）⇒ **实际首屏 = core,feed**；metrics 到手后回填重绘。下文"三片"是 V2-D 的历史口径。
		//   core   → 块 2（watch.unacked / board.review）+ 块 3（meta.asOf 逐源新鲜度）
		//   metrics→ 六项指标（块 1 一句话 + 块 2 需确认 + 块 3 心跳/误报率）
		//   feed   → 块 1（**日报「## 💡 建议」段** = P2.5 产物）
		//   ⚠️ 漏掉任何一片，对应块在**无缓存（冷启动）**时就是空的 —— 这是本轮瘦身的硬约束。
		//   ⚠️ 块 3（资产总览）与块 4（今日动态）已于 2026-09-14 主人拍板**移出首屏**（原块 3/4 让位，
		//      健康底栏由原「⑤」顺位为上文的「块 3」）；
		//      资产明细只在「📦 资产」Tab（进 Tab 才拉 assets 片）、变更明细只在「变更」Tab，
		//      故 `assets` 片**不再属于首屏集合**（去留两处都要改：本常量 + applyPayload 的 seed 名单）。
		const FIRST_PARTS = "core,feed";
		// 【V3-A2 · 2026-10-21】首屏片组合再瘦身：`metrics` **移出首屏**（改成首屏渲染后异步后补）。
		//   依据（A① 归因现跑）：metrics 片每次首屏都要把生态面板 HTTP 等到 2000 ms 超时才 abort
		//   （METRICS_ECO_TIMEOUT_MS），且它在生产上恒处降级态（boardReview / upgrade / patchDrift /
		//   decoupling 全不可用）。⇒ 挪出首屏**不丢信息**，只把"一眼看到"换成"晚 1~3 秒自动回填"。
		//   ⚠️ 三处必须同步：本常量 · applyPayload 的 seed 名单 · buildFirstScreen 的占位分叉。
		const DEFERRED_PARTS = ["metrics"];
		const API_FIRST = API + "?parts=" + FIRST_PARTS;
		// 首屏客户端缓存（有缓存先画缓存并标 asOf；冷启动显示"采集中"+ 真实测得的秒数）
		const LS_CACHE = "dsh-butler-v2-firstscreen";
		const LS_STATS = "dsh-butler-v2-stats";
		// 冷启动实测（V2-D 瘦身后实测值）：core+metrics+feed 全量重算 ≈ 1.5–3.5s（生态面板 HTTP 是固定价）。
		// 仅作"首次约 N 秒"的兜底文案；后续打开用真实测得的 lastColdMs 自校准。
		const COLD_MS_DEFAULT = 3200;
		const SLOW_MS = 1000;             // "重算慢"阈值（连续退化判据的一半）
		const DEGRADE_STREAK_ALERT = 3;   // 连续退化 ≥3 次 → 显式提示（别让主人以为一直正常）
		// 【0.9.4】适配层只在常量层需要：拿不到就退回同值字面量（"slots"）。
		// 这一条就是当年"适配层名字对不上 ⇒ 整个面板消失"的兜底；不是新语义，值与 ADAPTER.SVC.slots 相同。
		const SLOTS_SERVICE = (ADAPTER && ADAPTER.SVC && ADAPTER.SVC.slots) || "slots";
		const inject = [SLOTS_SERVICE];
		// 大管家图标（账本清单，16px 描边，与生态面板 grid 同视觉语言）
		const ICON = "<svg viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.3\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M2.6 3.2h6.8M2.6 8h6.8M2.6 12.8h6.8\"/><path d=\"M11.4 4.6l1.4 1.4 2.6-2.8M11.4 9.4l1.4 1.4 2.6-2.8\"/></svg>";
		const CSS_ID = "dsh-butler-panel-css";
		//#endregion
		//#region css
		const CSS = `
/* >>> panel-tokens:begin（本区块由 <workspace>/tools/lib/panel-tokens-sync.mjs 从 <workspace>/tools/lib/panel-tokens.mjs 生成 · 勿手改 · 改真源后跑 --write） */
:where([data-dsh-butler-panel],[data-dsh-ecosystem-panel],[data-dsh-butler-entry],[data-dsh-ecosystem-entry],[class*="footerActions"]){
  --bp-label-primary:var(--dsw-alias-label-primary);
  --bp-label-secondary:var(--dsw-alias-label-secondary);
  --bp-label-tertiary:var(--dsw-alias-label-tertiary);
  --bp-label-caption:var(--dsw-alias-label-caption);
  --bp-bg-layer-1:var(--dsw-alias-bg-layer-1);
  --bp-bg-layer-2:var(--dsw-alias-bg-layer-2);
  --bp-bg-layer-3:var(--dsw-alias-bg-layer-3);
  --bp-border-l1:var(--dsw-alias-border-l1);
  --bp-border-l2:var(--dsw-alias-border-l2);
  --bp-hover-bg:var(--dsw-alias-interactive-bg-hover);
  --bp-bg-module-platform:var(--dsw-alias-bg-module-platform);
  --bp-accent:var(--dsw-alias-button-info-fill);
  --bp-label-error:var(--dsw-alias-state-error-primary);
  --bp-state-error:var(--dsw-alias-state-error-primary);
  --bp-state-ok:var(--dsw-alias-state-success-primary);
  --bp-state-warn:var(--dsw-alias-state-warn-primary);
  --bp-state-info:var(--dsw-alias-state-business-primary);
  --bp-state-idle:var(--dsw-alias-state-idle-primary);
  --bp-accent-cyan:var(--dsw-static-green-400);
  --bp-accent-purple:var(--dsw-static-deepseek-450);
  --bp-state-error-fg:color-mix(in srgb,var(--bp-state-error) 62%,black);
  --bp-state-ok-fg:color-mix(in srgb,var(--bp-state-ok) 62%,black);
  --bp-state-warn-fg:color-mix(in srgb,var(--bp-state-warn) 62%,black);
  --bp-state-info-fg:color-mix(in srgb,var(--bp-state-info) 62%,black);
  --bp-accent-cyan-fg:color-mix(in srgb,var(--bp-accent-cyan) 68%,black);
  --bp-accent-purple-fg:color-mix(in srgb,var(--bp-accent-purple) 70%,black);
  --bp-fs-9:9px;
  --bp-fs-10:10px;
  --bp-fs-105:10.5px;
  --bp-fs-11:11px;
  --bp-fs-115:11.5px;
  --bp-fs-12:12px;
  --bp-fs-125:12.5px;
  --bp-fs-13:13px;
  --bp-fs-14:14px;
  --bp-fs-15:15px;
  --bp-fs-17:17px;
  --bp-fs-24:24px;
  --bp-sp-1:1px;
  --bp-sp-2:2px;
  --bp-sp-3:3px;
  --bp-sp-4:4px;
  --bp-sp-5:5px;
  --bp-sp-6:6px;
  --bp-sp-7:7px;
  --bp-sp-8:8px;
  --bp-sp-9:9px;
  --bp-sp-10:10px;
  --bp-sp-11:11px;
  --bp-sp-12:12px;
  --bp-sp-13:13px;
  --bp-sp-14:14px;
  --bp-sp-16:16px;
  --bp-sp-18:18px;
  --bp-sp-28:28px;
  --bp-r-2:2px;
  --bp-r-4:4px;
  --bp-r-5:5px;
  --bp-r-6:6px;
  --bp-r-8:8px;
  --bp-r-9:9px;
  --bp-r-10:10px;
  --bp-r-12:12px;
  --bp-r-14:14px;
  --bp-r-pill:50%;
  --bp-r-pill-999:999px;
  --bp-r-tab:6px 6px 0 0;
  --bp-r-ev:0 6px 6px 0;
  --bp-badge-soft-fs:11px;
  --bp-badge-soft-lh:1.75;
  --bp-badge-soft-r:5px;
  --bp-badge-soft-px:7px;
  --bp-badge-outline-fs:10.5px;
  --bp-badge-outline-lh:1.75;
  --bp-badge-outline-r:4px;
  --bp-badge-outline-px:5px;
  --bp-badge-tag-fs:10.5px;
  --bp-badge-tag-lh:1.6;
  --bp-badge-tag-r:4px;
  --bp-badge-tag-px:6px;
  --bp-badge-tag-maxw:180px;
  --bp-badge-pin-fs:10px;
  --bp-badge-pin-lh:1.5;
  --bp-badge-pin-r:4px;
  --bp-badge-pin-px:5px;
  --bp-badge-plain-fs:10.5px;
  --bp-badge-plain-r:5px;
  --bp-badge-plain-px:6px;
  --bp-badge-plain-ml:6px;
  --bp-badge-plain-va:1px;
  --bp-tint-base-error:rgb(229 72 77);
  --bp-tint-base-warn:rgb(229 179 92);
  --bp-tint-base-ok:rgb(62 207 110);
  --bp-tint-base-info:rgb(91 157 255);
  --bp-tint-base-neutral:rgb(128 128 128);
  --bp-tint-base-shadow:rgb(0 0 0);
  --bp-scrim:color-mix(in srgb,var(--bp-tint-base-shadow) 32%,transparent);
  --bp-shadow-card:color-mix(in srgb,var(--bp-tint-base-shadow) 45%,transparent);
  --bp-tint-neutral-06:color-mix(in srgb,var(--bp-tint-base-neutral) 6%,transparent);
  --bp-tint-neutral-08:color-mix(in srgb,var(--bp-tint-base-neutral) 8%,transparent);
  --bp-tint-neutral-10:color-mix(in srgb,var(--bp-tint-base-neutral) 10%,transparent);
  --bp-tint-neutral-12:color-mix(in srgb,var(--bp-tint-base-neutral) 12%,transparent);
  --bp-tint-neutral-14:color-mix(in srgb,var(--bp-tint-base-neutral) 14%,transparent);
  --bp-tint-neutral-26:color-mix(in srgb,var(--bp-tint-base-neutral) 26%,transparent);
  --bp-tint-neutral-28:color-mix(in srgb,var(--bp-tint-base-neutral) 28%,transparent);
  --bp-tint-neutral-35:color-mix(in srgb,var(--bp-tint-base-neutral) 35%,transparent);
  --bp-tint-info-07:color-mix(in srgb,var(--bp-tint-base-info) 7%,transparent);
  --bp-tint-info-12:color-mix(in srgb,var(--bp-tint-base-info) 12%,transparent);
  --bp-tint-info-14:color-mix(in srgb,var(--bp-tint-base-info) 14%,transparent);
  --bp-tint-info-45:color-mix(in srgb,var(--bp-tint-base-info) 45%,transparent);
  --bp-tint-info-50:color-mix(in srgb,var(--bp-tint-base-info) 50%,transparent);
  --bp-tint-ok-10:color-mix(in srgb,var(--bp-tint-base-ok) 10%,transparent);
  --bp-tint-ok-45:color-mix(in srgb,var(--bp-tint-base-ok) 45%,transparent);
  --bp-tint-warn-10:color-mix(in srgb,var(--bp-tint-base-warn) 10%,transparent);
  --bp-tint-warn-13:color-mix(in srgb,var(--bp-tint-base-warn) 13%,transparent);
  --bp-tint-warn-35:color-mix(in srgb,var(--bp-tint-base-warn) 35%,transparent);
  --bp-tint-warn-45:color-mix(in srgb,var(--bp-tint-base-warn) 45%,transparent);
  --bp-tint-warn-50:color-mix(in srgb,var(--bp-tint-base-warn) 50%,transparent);
  --bp-tint-error-08:color-mix(in srgb,var(--bp-tint-base-error) 8%,transparent);
  --bp-tint-error-12:color-mix(in srgb,var(--bp-tint-base-error) 12%,transparent);
  --bp-tint-error-14:color-mix(in srgb,var(--bp-tint-base-error) 14%,transparent);
  --bp-tint-error-35:color-mix(in srgb,var(--bp-tint-base-error) 35%,transparent);
  --bp-tint-error-50:color-mix(in srgb,var(--bp-tint-base-error) 50%,transparent);
  --bp-tint-error-55:color-mix(in srgb,var(--bp-tint-base-error) 55%,transparent);
}
body[data-ds-dark-theme] :where([data-dsh-butler-panel],[data-dsh-ecosystem-panel],[data-dsh-butler-entry],[data-dsh-ecosystem-entry],[class*="footerActions"]){
  --bp-state-error-fg:color-mix(in srgb,var(--bp-state-error) 62%,white);
  --bp-state-ok-fg:color-mix(in srgb,var(--bp-state-ok) 62%,white);
  --bp-state-warn-fg:color-mix(in srgb,var(--bp-state-warn) 62%,white);
  --bp-state-info-fg:color-mix(in srgb,var(--bp-state-info) 62%,white);
  --bp-accent-cyan-fg:color-mix(in srgb,var(--bp-accent-cyan) 62%,white);
  --bp-accent-purple-fg:color-mix(in srgb,var(--bp-accent-purple) 62%,white);
}
/* <<< panel-tokens:end */
/* >>> panel-vars:begin（本区块由 panel-tokens-sync.mjs 从 panel-tokens.mjs 生成 · 勿手改 · target=butler） */
[data-dsh-butler-panel]{
  --bp-z-panel:1400;
  --bp-card-max-w:900px;
  --bp-card-max-h:940px;
  --bp-card-vh:88vh;
  --bp-card-gutter:40px;
  --bp-head-pad:13px 18px 11px;
  --bp-head-wrap:wrap;
  --bp-head-flex:none;
  --bp-sub-basis:100%;
  --bp-sub-mt:-4px;
  --bp-body-flex:1 1 auto;
  --bp-body-minh:0;
  --bp-group-mt:12px;
  --bp-group-display:flex;
  --bp-group-ai:center;
  --bp-group-gap:8px;
  --bp-row-pad:7px 4px;
  --bp-dot-size:9px;
  --bp-dot-mt:6px;
  --bp-desc-ws:pre-wrap;
  --bp-desc-wb:break-all;
  --bp-note-mt:12px;
  --bp-tab-display:block;
  --bp-tab-ai:normal;
  --bp-tab-gap:0;
}
/* <<< panel-vars:end */
/* >>> panel-ui:begin（本区块由 <workspace>/tools/lib/panel-tokens-sync.mjs 从 <workspace>/tools/lib/panel-ui.mjs 生成 · 勿手改 · 组件唯一实现） */
[data-dsh-butler-panel],[data-dsh-ecosystem-panel]{position:fixed;inset:0;z-index:var(--bp-z-panel);display:flex;align-items:center;justify-content:center;background:var(--bp-scrim);backdrop-filter:blur(2px);font-size:var(--bp-fs-14);line-height:1.5;color:var(--bp-label-primary)}
[class*="footerActions"]{flex-direction:column}
.bp-slot-row,.ep-slot-row{flex:none;align-items:center;gap:var(--bp-sp-8);width:calc(100% + 4px);margin:4px -2px;display:flex}
.bp-slot-row.bp-railRow,.ep-slot-row.ep-railRow{width:36px;margin:8px 0 10px}
.bp-slot-holder,.ep-slot-holder{flex:1;min-width:0;display:flex}
.bp-slot-row .bp-slot-trigger,.ep-slot-row .ep-slot-trigger{box-sizing:border-box;cursor:pointer;width:auto;min-width:0;height:42px;color:var(--bp-label-primary);background:0 0;border:none;border-radius:var(--bp-r-12);flex:1;align-items:center;gap:var(--bp-sp-8);margin:0;padding:0 var(--bp-sp-10) 0 var(--bp-sp-8);font-family:inherit;font-size:var(--bp-fs-14);line-height:22px;display:flex;overflow:hidden}
.bp-slot-row .bp-slot-trigger:hover,.ep-slot-row .ep-slot-trigger:hover{background:var(--bp-hover-bg)}
.bp-slot-row.bp-railRow .bp-slot-holder,.ep-slot-row.ep-railRow .ep-slot-holder{flex:none;justify-content:center}
.bp-slot-row.bp-railRow .bp-slot-trigger,.ep-slot-row.ep-railRow .ep-slot-trigger{corner-shape:round;border-radius:var(--bp-r-pill);flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
[data-dsh-butler-entry] svg,[data-dsh-ecosystem-entry] svg{display:block}
[data-dsh-butler-entry],[data-dsh-ecosystem-entry]{flex:none}
[data-dsh-butler-panel] .bp-card,[data-dsh-ecosystem-panel] .ep-card{box-sizing:border-box;width:min(var(--bp-card-max-w),calc(100vw - var(--bp-card-gutter)));max-height:min(var(--bp-card-vh),var(--bp-card-max-h));display:flex;flex-direction:column;background:var(--bp-bg-layer-3);border:1px solid var(--bp-border-l2);border-radius:var(--bp-r-14);box-shadow:0 18px 60px var(--bp-shadow-card);overflow:hidden}
[data-dsh-butler-panel] .bp-head,[data-dsh-ecosystem-panel] .ep-head{display:flex;align-items:center;gap:var(--bp-sp-10);padding:var(--bp-head-pad);border-bottom:1px solid var(--bp-border-l2);flex-wrap:var(--bp-head-wrap);flex:var(--bp-head-flex)}
[data-dsh-butler-panel] .bp-title,[data-dsh-ecosystem-panel] .ep-title{font-size:var(--bp-fs-15);font-weight:600;flex:1;min-width:0}
[data-dsh-butler-panel] .bp-sub,[data-dsh-ecosystem-panel] .ep-sub{font-size:var(--bp-fs-12);color:var(--bp-label-tertiary);flex-basis:var(--bp-sub-basis);margin-top:var(--bp-sub-mt)}
[data-dsh-butler-panel] .bp-btn,[data-dsh-ecosystem-panel] .ep-btn{appearance:none;cursor:pointer;background:var(--bp-bg-layer-2);color:inherit;border:1px solid var(--bp-border-l2);border-radius:var(--bp-r-8);padding:var(--bp-sp-4) var(--bp-sp-12);font:inherit;font-size:var(--bp-fs-13)}
[data-dsh-butler-panel] .bp-btn:hover,[data-dsh-ecosystem-panel] .ep-btn:hover{background:var(--bp-hover-bg)}
[data-dsh-butler-panel] .bp-tabs,[data-dsh-ecosystem-panel] .ep-tabs{display:flex;gap:var(--bp-sp-2);padding:var(--bp-sp-8) var(--bp-sp-12) 0;border-bottom:1px solid var(--bp-border-l1);overflow-x:auto;overflow-y:hidden;flex:none}
[data-dsh-butler-panel] .bp-tab,[data-dsh-ecosystem-panel] .ep-tab{appearance:none;cursor:pointer;background:none;border:none;color:var(--bp-label-tertiary);font:inherit;font-size:var(--bp-fs-125);padding:var(--bp-sp-5) var(--bp-sp-9) var(--bp-sp-8);border-bottom:2px solid transparent;border-radius:var(--bp-r-tab);white-space:nowrap;display:var(--bp-tab-display);align-items:var(--bp-tab-ai);gap:var(--bp-tab-gap)}
[data-dsh-butler-panel] .bp-tab:hover,[data-dsh-ecosystem-panel] .ep-tab:hover{color:var(--bp-label-primary);background:var(--bp-tint-neutral-08)}
[data-dsh-butler-panel] .bp-tab.bp-on,[data-dsh-ecosystem-panel] .ep-tab.ep-on{color:var(--bp-label-primary);border-bottom-color:var(--bp-accent);font-weight:600}
[data-dsh-butler-panel] .bp-body,[data-dsh-ecosystem-panel] .ep-body{flex:var(--bp-body-flex);min-height:var(--bp-body-minh);overflow:auto;padding:var(--bp-sp-12) var(--bp-sp-18) var(--bp-sp-16)}
[data-dsh-butler-panel] .bp-group,[data-dsh-ecosystem-panel] .ep-group{margin:var(--bp-group-mt) 0 var(--bp-sp-2);font-size:var(--bp-fs-12);font-weight:600;letter-spacing:.05em;color:var(--bp-label-tertiary);text-transform:uppercase;display:var(--bp-group-display);align-items:var(--bp-group-ai);gap:var(--bp-group-gap)}
[data-dsh-butler-panel] .bp-row,[data-dsh-ecosystem-panel] .ep-row{display:flex;align-items:flex-start;gap:var(--bp-sp-8);padding:var(--bp-row-pad);border-bottom:1px solid var(--bp-border-l1)}
[data-dsh-butler-panel] .bp-row:last-child,[data-dsh-ecosystem-panel] .ep-row:last-child{border-bottom:none}
[data-dsh-butler-panel] .bp-dot,[data-dsh-ecosystem-panel] .ep-dot{flex:none;width:var(--bp-dot-size);height:var(--bp-dot-size);border-radius:var(--bp-r-pill);margin-top:var(--bp-dot-mt)}
[data-dsh-butler-panel] .bp-main,[data-dsh-ecosystem-panel] .ep-main{flex:1;min-width:0}
[data-dsh-butler-panel] .bp-name,[data-dsh-ecosystem-panel] .ep-name{font-weight:500;word-break:break-all}
[data-dsh-butler-panel] .bp-desc,[data-dsh-ecosystem-panel] .ep-desc{font-size:var(--bp-fs-12);color:var(--bp-label-tertiary);margin-top:1px;word-break:var(--bp-desc-wb);white-space:var(--bp-desc-ws)}
[data-dsh-butler-panel] .bp-meta,[data-dsh-ecosystem-panel] .ep-meta{font-size:var(--bp-fs-12);color:var(--bp-label-tertiary)}
[data-dsh-butler-panel] .bp-note,[data-dsh-ecosystem-panel] .ep-note{font-size:var(--bp-fs-12);color:var(--bp-label-tertiary);margin-top:var(--bp-note-mt)}
[data-dsh-butler-panel] .bp-err,[data-dsh-ecosystem-panel] .ep-err{color:var(--bp-label-error);font-size:var(--bp-fs-13);padding:var(--bp-sp-10) 0}
.bp-dot-red,.dot-red{background:var(--bp-state-error)}
.bp-dot-yellow,.dot-yellow{background:var(--bp-state-warn)}
.bp-dot-green,.dot-green{background:var(--bp-state-ok)}
.bp-dot-gray,.dot-retired,.dot-unknown{background:var(--bp-state-idle)}
.bp-dot-blue{background:var(--bp-state-info)}
.ui-open .ui-detail{display:none}
.ui-open.open .ui-detail{display:block}
[data-dsh-butler-panel] .bp-kpis,[data-dsh-ecosystem-panel] .ep-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:var(--bp-sp-8);margin:2px 0 var(--bp-sp-12)}
[data-dsh-butler-panel] .bp-kpi,[data-dsh-ecosystem-panel] .ep-kpi{position:relative;border:1px solid var(--bp-border-l1);background:var(--bp-bg-layer-2);border-radius:var(--bp-r-10);padding:var(--bp-sp-8) var(--bp-sp-12) var(--bp-sp-9)}
[data-dsh-butler-panel] .bp-kpi .num,[data-dsh-ecosystem-panel] .ep-kpi .num{font-size:var(--bp-fs-24);font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}
[data-dsh-butler-panel] .bp-kpi .lbl,[data-dsh-ecosystem-panel] .ep-kpi .lbl{font-size:var(--bp-fs-11);color:var(--bp-label-tertiary);margin-top:var(--bp-sp-2)}
[data-dsh-butler-panel] .bp-kpi::before,[data-dsh-ecosystem-panel] .ep-kpi::before{content:"";position:absolute;left:0;top:var(--bp-sp-8);bottom:var(--bp-sp-8);width:3px;border-radius:var(--bp-r-2)}
[data-dsh-butler-panel] .bp-kpi.k-red .num,[data-dsh-ecosystem-panel] .ep-kpi.k-red .num{color:var(--bp-state-error-fg)}
[data-dsh-butler-panel] .bp-kpi.k-red::before,[data-dsh-ecosystem-panel] .ep-kpi.k-red::before{background:var(--bp-state-error)}
[data-dsh-butler-panel] .bp-kpi.k-green .num,[data-dsh-ecosystem-panel] .ep-kpi.k-green .num{color:var(--bp-state-ok-fg)}
[data-dsh-butler-panel] .bp-kpi.k-green::before,[data-dsh-ecosystem-panel] .ep-kpi.k-green::before{background:var(--bp-state-ok)}
[data-dsh-butler-panel] .bp-kpi.k-blue .num,[data-dsh-ecosystem-panel] .ep-kpi.k-blue .num{color:var(--bp-state-info-fg)}
[data-dsh-butler-panel] .bp-kpi.k-blue::before,[data-dsh-ecosystem-panel] .ep-kpi.k-blue::before{background:var(--bp-state-info)}
[data-dsh-butler-panel] .bp-kpi.k-yellow .num,[data-dsh-ecosystem-panel] .ep-kpi.k-yellow .num{color:var(--bp-state-warn-fg)}
[data-dsh-butler-panel] .bp-kpi.k-yellow::before,[data-dsh-ecosystem-panel] .ep-kpi.k-yellow::before{background:var(--bp-state-warn)}
[data-dsh-butler-panel] .bp-kpi.k-cyan .num,[data-dsh-ecosystem-panel] .ep-kpi.k-cyan .num{color:var(--bp-accent-cyan-fg)}
[data-dsh-butler-panel] .bp-kpi.k-cyan::before,[data-dsh-ecosystem-panel] .ep-kpi.k-cyan::before{background:var(--bp-accent-cyan)}
[data-dsh-butler-panel] .bp-kpi.k-purple .num,[data-dsh-ecosystem-panel] .ep-kpi.k-purple .num{color:var(--bp-accent-purple-fg)}
[data-dsh-butler-panel] .bp-kpi.k-purple::before,[data-dsh-ecosystem-panel] .ep-kpi.k-purple::before{background:var(--bp-accent-purple)}
[data-dsh-butler-panel] .bp-kpi.clickable,[data-dsh-ecosystem-panel] .ep-kpi.clickable{cursor:pointer;transition:border-color .12s}
[data-dsh-butler-panel] .bp-kpi.clickable:hover,[data-dsh-ecosystem-panel] .ep-kpi.clickable:hover{border-color:var(--bp-tint-info-50);background:var(--bp-bg-layer-3)}
[data-dsh-butler-panel] .bp-skel,[data-dsh-ecosystem-panel] .ep-skel{border:1px dashed var(--bp-border-l2);border-radius:var(--bp-r-10);padding:var(--bp-sp-14);text-align:center;color:var(--bp-label-tertiary);font-size:var(--bp-fs-13);line-height:1.8}
[data-dsh-butler-panel] .bp-skel .bar,[data-dsh-ecosystem-panel] .ep-skel .bar{height:9px;border-radius:var(--bp-r-5);background:linear-gradient(90deg,var(--bp-tint-neutral-12),var(--bp-tint-neutral-28),var(--bp-tint-neutral-12));margin:7px auto;animation:bp-pulse 1.3s ease-in-out infinite}
[data-dsh-butler-panel] .bp-skel .bar:nth-child(2),[data-dsh-ecosystem-panel] .ep-skel .bar:nth-child(2){width:86%}
[data-dsh-butler-panel] .bp-skel .bar:nth-child(3),[data-dsh-ecosystem-panel] .ep-skel .bar:nth-child(3){width:70%}
[data-dsh-butler-panel] .bp-skel .bar:nth-child(4),[data-dsh-ecosystem-panel] .ep-skel .bar:nth-child(4){width:78%}
@keyframes bp-pulse{0%{opacity:.45}50%{opacity:1}100%{opacity:.45}}
.ui-badge--soft{flex:none;font-size:var(--bp-badge-soft-fs);line-height:var(--bp-badge-soft-lh);border-radius:var(--bp-badge-soft-r);padding:0 var(--bp-badge-soft-px);border:1px solid var(--bp-tint-neutral-35);color:var(--bp-label-secondary)}
.ui-badge--soft.ui-tone-ok{color:var(--bp-state-ok-fg);border-color:var(--bp-tint-ok-45);background:var(--bp-tint-ok-10)}
.ui-badge--soft.ui-tone-warn{color:var(--bp-state-warn-fg);border-color:var(--bp-tint-warn-45);background:var(--bp-tint-warn-10)}
.ui-badge--soft.ui-tone-error{color:var(--bp-state-error-fg);border-color:var(--bp-tint-error-50);background:var(--bp-tint-error-12)}
.ui-badge--soft.ui-tone-muted{color:var(--bp-label-tertiary)}
.ui-badge--outline{flex:none;font-size:var(--bp-badge-outline-fs);line-height:var(--bp-badge-outline-lh);border-radius:var(--bp-badge-outline-r);padding:0 var(--bp-badge-outline-px);border:1px solid var(--bp-tint-neutral-35);color:var(--bp-label-tertiary)}
.ui-badge--outline.ui-tone-error{color:var(--bp-state-error-fg);border-color:var(--bp-tint-error-50);background:var(--bp-tint-error-12)}
.ui-badge--outline.ui-tone-warn{color:var(--bp-state-warn-fg);border-color:var(--bp-tint-warn-45);background:var(--bp-tint-warn-10)}
.ui-badge--tag{font-size:var(--bp-badge-tag-fs);line-height:var(--bp-badge-tag-lh);border-radius:var(--bp-badge-tag-r);padding:0 var(--bp-badge-tag-px);background:var(--bp-tint-neutral-14);color:var(--bp-label-tertiary);max-width:var(--bp-badge-tag-maxw);overflow:hidden;text-overflow:ellipsis}
.ui-badge--pin{font-size:var(--bp-badge-pin-fs);line-height:var(--bp-badge-pin-lh);border-radius:var(--bp-badge-pin-r);padding:0 var(--bp-badge-pin-px);color:var(--bp-state-warn-fg);border:1px solid var(--bp-tint-warn-50)}
.ui-badge--plain{font-size:var(--bp-badge-plain-fs);border-radius:var(--bp-badge-plain-r);padding:0 var(--bp-badge-plain-px);margin-left:var(--bp-badge-plain-ml);vertical-align:var(--bp-badge-plain-va);background:var(--bp-bg-module-platform)}
/* <<< panel-ui:end */
/* 【路 A · 官方槽】按钮外观照官方设置 trigger（源：ui-settings-general SettingsRoot.module.css）：
   triggerRow 行 + trigger 本体；收起态（wide=false）走 rail 圆形。不再复制设置按钮的 className。 */
/* 官方槽把入口渲染进 footerActions（shell 的**横向** flex 行）；两个自研入口各占满宽 ⇒ 并排会互相挤出
   侧边栏（2026-09-23 实测：后一个被推到视口外只露半个字）。这里只把该容器改成竖排（不动宽度/对齐/间距），
   让每个入口各占一行 —— 与迁移前的视觉一致。 */
.bp-slot-row .bp-slot-trigger[data-active="true"]{background:var(--bp-hover-bg)}
.bp-slot-row.bp-railRow .bp-butler-label{display:none}
[${ENTRY_ATTR}] .bp-butler-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
[data-sidebar-collapsed] [${ENTRY_ATTR}] .bp-butler-label{display:none}
/* 【卡「冲刺600 · audit-off 限时」】顶栏常驻横幅：暂停写入审计生效期间**一直在**，带剩余时间 + 一键恢复。
   为什么必须常驻：改前这个状态只出现在「管家」Tab 的守门人卡里一行 —— 主人换个 Tab、关了面板就再也看不见，
   而"暂停 = 保护区写入不再被拦截"是**保护降级**（口径 §7.3⑤ 明写「横幅常驻 + 升级告警」）。 */
[${PANEL_ATTR}] .bp-audit-banner{display:flex;align-items:center;gap:var(--bp-sp-10);flex-wrap:wrap;flex:none;padding:var(--bp-sp-8) var(--bp-sp-18);font-size:var(--bp-fs-13);border-bottom:1px solid var(--bp-tint-error-35);background:var(--bp-tint-error-14);color:var(--bp-state-error-fg)}
[${PANEL_ATTR}] .bp-audit-banner.bp-half{background:var(--bp-tint-warn-13);border-bottom-color:var(--bp-tint-warn-35);color:var(--bp-state-warn-fg)}
[${PANEL_ATTR}] .bp-audit-banner .bp-ab-icon{flex:none}
[${PANEL_ATTR}] .bp-audit-banner .bp-ab-txt{flex:1;min-width:0;word-break:break-all}
[${PANEL_ATTR}] .bp-audit-banner .bp-ab-cd{flex:none;font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}
[${PANEL_ATTR}] .bp-btn:disabled{opacity:.5;cursor:default}
[${PANEL_ATTR}] .bp-tab-head{display:flex;flex-direction:column;gap:var(--bp-sp-3);margin:0 0 10px;padding:var(--bp-sp-8) var(--bp-sp-10);border:1px solid var(--bp-border-l2);border-radius:var(--bp-r-10);background:var(--bp-bg-layer-2)}
[${PANEL_ATTR}] .bp-tab-title{font-size:var(--bp-fs-14);font-weight:600}
[${PANEL_ATTR}] .bp-trends{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--bp-sp-10);margin:0 0 4px}
[${PANEL_ATTR}] .bp-trend{border:1px solid var(--bp-border-l1);border-radius:var(--bp-r-10);padding:var(--bp-sp-8) var(--bp-sp-12) var(--bp-sp-6)}
[${PANEL_ATTR}] .bp-trend .t-title{font-size:var(--bp-fs-12);color:var(--bp-label-secondary);display:flex;justify-content:space-between;margin-bottom:6px}
[${PANEL_ATTR}] .bp-trend .t-last{font-weight:600;color:var(--bp-label-primary)}
[${PANEL_ATTR}] .bp-trend svg text{fill:var(--bp-label-tertiary);font-size:var(--bp-fs-9)}
[${PANEL_ATTR}] .bp-name.bp-sess-title{font-weight:600}
[${PANEL_ATTR}] .bp-meta.bp-detail{color:var(--bp-label-secondary);margin-top:1px;word-break:break-all}
[${PANEL_ATTR}] .bp-acts{flex:none;display:flex;gap:var(--bp-sp-4);margin-top:2px}
[${PANEL_ATTR}] .bp-act{appearance:none;cursor:pointer;border:1px solid var(--bp-border-l2);background:var(--bp-tint-neutral-10);color:var(--bp-label-secondary);border-radius:var(--bp-r-6);padding:var(--bp-sp-1) var(--bp-sp-8);font:inherit;font-size:var(--bp-fs-11);white-space:nowrap}
[${PANEL_ATTR}] .bp-act:hover{background:var(--bp-tint-neutral-26);color:var(--bp-label-primary)}
[${PANEL_ATTR}] .bp-act:disabled{opacity:.55;cursor:default}
[${PANEL_ATTR}] .bp-act.primary{border-color:var(--bp-tint-info-50);color:var(--bp-state-info-fg)}
[${PANEL_ATTR}] .bp-act.warn{color:var(--bp-state-error)}
[${PANEL_ATTR}] .bp-code{font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:var(--bp-fs-115);color:var(--bp-label-secondary);line-height:1.55;white-space:pre-wrap;word-break:break-all}
[${PANEL_ATTR}] .bp-empty{border:1px dashed var(--bp-border-l2);border-radius:var(--bp-r-10);padding:var(--bp-sp-18) var(--bp-sp-14);text-align:center;color:var(--bp-label-tertiary);font-size:var(--bp-fs-13);margin-top:6px}
[${PANEL_ATTR}] .bp-report-grid{display:grid;grid-template-columns:minmax(180px,300px) 1fr;gap:var(--bp-sp-12);min-height:300px}
[${PANEL_ATTR}] .bp-report-list{border-right:1px solid var(--bp-border-l1);padding-right:var(--bp-sp-8);max-height:52vh;overflow:auto}
[${PANEL_ATTR}] .bp-rep-row{appearance:none;display:block;width:100%;text-align:left;cursor:pointer;background:none;border:none;color:var(--bp-label-secondary);font:inherit;font-size:var(--bp-fs-125);padding:var(--bp-sp-5) var(--bp-sp-8);border-radius:var(--bp-r-6)}
[${PANEL_ATTR}] .bp-rep-row:hover{background:var(--bp-tint-neutral-12)}
[${PANEL_ATTR}] .bp-rep-row.bp-on{background:var(--bp-tint-info-14);color:var(--bp-label-primary)}
[${PANEL_ATTR}] .bp-rep-row .d{opacity:.75;font-variant-numeric:tabular-nums}
[${PANEL_ATTR}] .bp-rep-head{font-size:var(--bp-fs-11);color:var(--bp-label-tertiary);letter-spacing:.06em;margin:8px 2px 4px;text-transform:uppercase}
[${PANEL_ATTR}] .bp-preview{border:1px solid var(--bp-border-l1);border-radius:var(--bp-r-10);padding:var(--bp-sp-10) var(--bp-sp-12);background:var(--bp-bg-layer-1);overflow:auto;max-height:52vh}
[${PANEL_ATTR}] .bp-preview .bp-code{white-space:pre-wrap}
[${PANEL_ATTR}] .bp-cl-file{font-size:var(--bp-fs-12);color:var(--bp-label-tertiary);margin:2px 2px 6px}
[${PANEL_ATTR}] .bp-cl-day{display:flex;align-items:baseline;gap:var(--bp-sp-8);margin:14px 0 2px;padding:var(--bp-sp-3) var(--bp-sp-10);font-size:var(--bp-fs-125);font-weight:700;letter-spacing:.04em;color:var(--bp-label-primary);background:var(--bp-tint-info-12);border-radius:var(--bp-r-8);border-left:3px solid var(--bp-accent)}
[${PANEL_ATTR}] .bp-cl-day .today{color:var(--bp-state-info-fg);font-weight:600;font-size:var(--bp-fs-11)}
[${PANEL_ATTR}] .bp-cl-item{padding:var(--bp-sp-7) var(--bp-sp-4) var(--bp-sp-7) var(--bp-sp-2);border-bottom:1px solid var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-cl-item:last-of-type{border-bottom:none}
[${PANEL_ATTR}] .bp-cl-top{display:flex;gap:var(--bp-sp-8);align-items:flex-start}
[${PANEL_ATTR}] .bp-cl-time{flex:none;width:38px;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:var(--bp-fs-11);line-height:1.7;color:var(--bp-state-info-fg);font-variant-numeric:tabular-nums;padding-top:var(--bp-sp-1)}
[${PANEL_ATTR}] .bp-cl-main{flex:1;min-width:0;font-size:var(--bp-fs-13);line-height:1.6;word-break:break-all;color:var(--bp-label-secondary)}
[${PANEL_ATTR}] .bp-cl-meta{font-size:var(--bp-fs-115);line-height:1.55;color:var(--bp-label-tertiary);word-break:break-all;margin:3px 0 0 46px;white-space:pre-wrap}
[${PANEL_ATTR}] .bp-cl-note{font-size:var(--bp-fs-115);line-height:1.6;color:var(--bp-label-tertiary);opacity:.78;padding:var(--bp-sp-2) var(--bp-sp-6)}
[${PANEL_ATTR}] .bp-mem-row{cursor:pointer}
[${PANEL_ATTR}] .bp-mem-row:hover{background:var(--bp-tint-neutral-06);border-radius:var(--bp-r-8)}
[${PANEL_ATTR}] .bp-mem-top{display:flex;align-items:center;gap:var(--bp-sp-8);flex-wrap:wrap}
[${PANEL_ATTR}] .bp-mem-id{font-weight:600;font-size:var(--bp-fs-125);color:var(--bp-label-primary);font-variant-numeric:tabular-nums}
[${PANEL_ATTR}] .bp-mem-time{margin-left:auto;font-size:var(--bp-fs-11);color:var(--bp-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
[${PANEL_ATTR}] .bp-mem-prev{font-size:var(--bp-fs-125);color:var(--bp-label-secondary);line-height:1.55;margin-top:2px;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
[${PANEL_ATTR}] .bp-mem-full{display:none;font-size:var(--bp-fs-125);color:var(--bp-label-secondary);line-height:1.6;margin-top:2px;white-space:pre-wrap;word-break:break-all}
[${PANEL_ATTR}] .bp-mem-row.open .bp-mem-full{display:block}
[${PANEL_ATTR}] .bp-mem-row.open .bp-mem-prev{display:none}
[${PANEL_ATTR}] .bp-cl-extra{font-size:var(--bp-fs-115);line-height:1.6;color:var(--bp-label-tertiary);opacity:.85;margin:2px 0 0 46px;white-space:pre-wrap;word-break:break-all}
[${PANEL_ATTR}] .bp-health{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:var(--bp-sp-10);margin-bottom:2px}
[${PANEL_ATTR}] .bp-health-card{border:1px solid var(--bp-border-l1);border-radius:var(--bp-r-10);padding:var(--bp-sp-9) var(--bp-sp-12) var(--bp-sp-10);background:var(--bp-bg-layer-1)}
[${PANEL_ATTR}] .bp-health-head{display:flex;align-items:center;justify-content:space-between;gap:var(--bp-sp-8);margin-bottom:6px}
[${PANEL_ATTR}] .bp-health-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--bp-fs-125);font-weight:600;color:var(--bp-label-primary)}
[${PANEL_ATTR}] .bp-health-line{display:flex;gap:var(--bp-sp-8);font-size:var(--bp-fs-12);line-height:1.7}
[${PANEL_ATTR}] .bp-health-line .k{flex:none;width:62px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bp-label-tertiary)}
[${PANEL_ATTR}] .bp-health-line.bp-k-wide .k{width:auto;max-width:60%;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:var(--bp-fs-115)}
[${PANEL_ATTR}] .bp-health-line .v{flex:1;min-width:0;color:var(--bp-label-secondary);word-break:break-all}
[${PANEL_ATTR}] .bp-health-list{margin-top:6px;padding-top:var(--bp-sp-5);border-top:1px dashed var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-health-item{display:flex;align-items:center;gap:var(--bp-sp-6);font-size:var(--bp-fs-115);line-height:1.8}
[${PANEL_ATTR}] .bp-health-item .dot{flex:none;width:7px;height:7px;border-radius:var(--bp-r-pill)}
[${PANEL_ATTR}] .bp-health-item .nm{flex:none;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bp-label-secondary)}
[${PANEL_ATTR}] .bp-health-item .vv{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bp-label-tertiary)}
[${PANEL_ATTR}] .bp-health-more{font-size:var(--bp-fs-11);color:var(--bp-label-tertiary);margin-top:3px;opacity:.85}
[${PANEL_ATTR}] .bp-mem-foot{display:flex;align-items:center;gap:var(--bp-sp-10);margin-top:12px}
[${PANEL_ATTR}] .bp-mod-row{display:flex;align-items:flex-start;gap:var(--bp-sp-8);padding:var(--bp-sp-6) var(--bp-sp-4);border-bottom:1px solid var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-mod-row:last-child{border-bottom:none}
[${PANEL_ATTR}] .bp-mod-badge{flex:none;width:16px;text-align:center;font-size:var(--bp-fs-12);line-height:1.7}
[${PANEL_ATTR}] .bp-mod-body{flex:1;min-width:0}
[${PANEL_ATTR}] .bp-mod-top{display:flex;align-items:baseline;gap:var(--bp-sp-7);flex-wrap:wrap}
[${PANEL_ATTR}] .bp-mod-id{font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:var(--bp-fs-12);font-weight:600;color:var(--bp-label-primary)}
[${PANEL_ATTR}] .bp-mod-label{font-size:var(--bp-fs-125);color:var(--bp-label-secondary);word-break:break-all}
[${PANEL_ATTR}] .bp-mod-meta{font-size:var(--bp-fs-11);line-height:1.6;color:var(--bp-label-tertiary);margin-top:2px;word-break:break-all}
[${PANEL_ATTR}] .bp-mod-row.bp-mod-off .bp-mod-id{color:var(--bp-state-error-fg)}
[${PANEL_ATTR}] .bp-mod-confirm{display:flex;flex-direction:column;gap:var(--bp-sp-6);padding:var(--bp-sp-7) var(--bp-sp-4) var(--bp-sp-9) var(--bp-sp-28);border-bottom:1px solid var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-mod-ask{font-size:var(--bp-fs-115);line-height:1.6;color:var(--bp-label-tertiary)}
[${PANEL_ATTR}] .bp-mod-input{box-sizing:border-box;width:100%;background:var(--bp-bg-layer-2);color:inherit;border:1px solid var(--bp-border-l2);border-radius:var(--bp-r-6);padding:var(--bp-sp-4) var(--bp-sp-8);font:inherit;font-size:var(--bp-fs-12)}
[${PANEL_ATTR}] .bp-mod-btns{display:flex;gap:var(--bp-sp-6);align-items:center;flex-wrap:wrap}
/* ===== V2-B 首屏五块（§3.8）→ V2-D 瘦身为三块 + 六项 v2 指标 ===== */
[${PANEL_ATTR}] .bp-first{display:flex;flex-direction:column;gap:var(--bp-sp-9)}
[${PANEL_ATTR}] .bp-block{border:1px solid var(--bp-border-l1);border-radius:var(--bp-r-10);padding:var(--bp-sp-9) var(--bp-sp-12) var(--bp-sp-10);background:var(--bp-bg-layer-1)}
[${PANEL_ATTR}] .bp-block-head{display:flex;align-items:center;gap:var(--bp-sp-8);font-size:var(--bp-fs-125);font-weight:600;color:var(--bp-label-primary);margin-bottom:6px}
[${PANEL_ATTR}] .bp-block-head .cnt{font-weight:400;color:var(--bp-label-tertiary);font-size:var(--bp-fs-115)}
[${PANEL_ATTR}] .bp-block-head .right{margin-left:auto;font-size:var(--bp-fs-11);font-weight:400;color:var(--bp-label-tertiary)}
[${PANEL_ATTR}] .bp-verdict{font-size:var(--bp-fs-17);font-weight:600;line-height:1.55;color:var(--bp-label-primary);word-break:break-word}
[${PANEL_ATTR}] .bp-verdict b{color:var(--bp-state-info-fg)}
[${PANEL_ATTR}] .bp-verdict b.red{color:var(--bp-state-error-fg)}
[${PANEL_ATTR}] .bp-verdict .none{color:var(--bp-label-tertiary);font-weight:400}
[${PANEL_ATTR}] .bp-adv{margin-top:7px;padding-top:var(--bp-sp-6);border-top:1px dashed var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-adv-item{font-size:var(--bp-fs-125);line-height:1.6;color:var(--bp-label-secondary);padding:var(--bp-sp-3) var(--bp-sp-2);word-break:break-all;border-radius:var(--bp-r-6)}
[${PANEL_ATTR}] .bp-adv-tag{font-size:var(--bp-fs-105);color:var(--bp-state-warn-fg);border:1px solid var(--bp-tint-warn-45);border-radius:var(--bp-r-4);padding:0 var(--bp-sp-5);margin-right:5px;white-space:nowrap}
[${PANEL_ATTR}] .bp-adv-full{display:none;font-size:var(--bp-fs-12);line-height:1.65;color:var(--bp-label-tertiary);padding:var(--bp-sp-2) 0 var(--bp-sp-4) var(--bp-sp-4);white-space:pre-wrap;word-break:break-all}
[${PANEL_ATTR}] .bp-pend{padding:var(--bp-sp-6) var(--bp-sp-2);border-bottom:1px solid var(--bp-border-l1)}
[${PANEL_ATTR}] .bp-pend:last-child{border-bottom:none}
[${PANEL_ATTR}] .bp-pend-top{display:flex;align-items:flex-start;gap:var(--bp-sp-7)}
[${PANEL_ATTR}] .bp-ev{margin:5px 0 3px 4px;padding:var(--bp-sp-6) var(--bp-sp-8);border-left:2px solid var(--bp-tint-info-45);background:var(--bp-tint-info-07);border-radius:var(--bp-r-ev);font-size:var(--bp-fs-115);line-height:1.7;color:var(--bp-label-secondary);white-space:pre-wrap;word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace)}
[${PANEL_ATTR}] .bp-asset-row{display:flex;align-items:center;gap:var(--bp-sp-8);font-size:var(--bp-fs-125);padding:var(--bp-sp-4) var(--bp-sp-2);line-height:1.6}
[${PANEL_ATTR}] .bp-asset-row .nm{flex:none;width:130px;color:var(--bp-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[${PANEL_ATTR}] .bp-asset-row .nt{flex:1;min-width:0;color:var(--bp-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[${PANEL_ATTR}] .bp-asset-row .ao{flex:none;font-size:var(--bp-fs-11);color:var(--bp-label-tertiary);font-variant-numeric:tabular-nums}
[${PANEL_ATTR}] .bp-feed-item{display:flex;gap:var(--bp-sp-8);font-size:var(--bp-fs-125);line-height:1.65;padding:var(--bp-sp-3) var(--bp-sp-2);color:var(--bp-label-secondary)}
[${PANEL_ATTR}] .bp-feed-item .tm{flex:none;width:38px;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:var(--bp-fs-11);color:var(--bp-state-info-fg);padding-top:var(--bp-sp-2)}
[${PANEL_ATTR}] .bp-feed-item .tx{flex:1;min-width:0;word-break:break-all}
[${PANEL_ATTR}] .bp-bar{display:flex;flex-wrap:wrap;gap:var(--bp-sp-5) var(--bp-sp-16);align-items:center;font-size:var(--bp-fs-12);line-height:1.7}
[${PANEL_ATTR}] .bp-bar .seg{display:flex;align-items:center;gap:var(--bp-sp-6);min-width:0}
[${PANEL_ATTR}] .bp-bar .k{color:var(--bp-label-tertiary)}
[${PANEL_ATTR}] .bp-bar .v{color:var(--bp-label-secondary)}
[${PANEL_ATTR}] .bp-degrade{margin:0 0 8px;padding:var(--bp-sp-7) var(--bp-sp-11);border-radius:var(--bp-r-9);font-size:var(--bp-fs-12);line-height:1.65;color:var(--bp-state-warn-fg);border:1px solid var(--bp-tint-warn-45);background:var(--bp-tint-warn-10)}
[${PANEL_ATTR}] .bp-zoneL3{border:1px solid var(--bp-tint-error-55);background:var(--bp-tint-error-08);border-radius:var(--bp-r-10);padding:var(--bp-sp-9) var(--bp-sp-12)}
[${PANEL_ATTR}] .bp-zoneL3 .bp-block-head{color:var(--bp-state-error-fg)}`;
/* >>> panel-tokens-js:begin（本区块由 panel-tokens-sync.mjs 从 panel-tokens.mjs 生成 · 勿手改） */
const TOK = { color: { "state-error-fg": "var(--bp-state-error-fg)", "accent-purple-fg": "var(--bp-accent-purple-fg)" } };
/* <<< panel-tokens-js:end */
/* >>> panel-ui-js:begin（本区块由 panel-tokens-sync.mjs 从 tools/lib/panel-ui.mjs 生成 · 勿手改） */
/**
 * 面板组件唯一实现（el / groupTitle / card / kpi / badge / row / skeleton）。
 * 用法（每份 client.js 一次）：const UI = makePanelUI({ prefix: "bp" });
 * 三条硬约定（方案 §4.3）：① tone 只认枚举，组件体内不出现颜色字面量；
 * ② 尺寸一律由 CSS 的 var(--bp-*) 承载（组件不写 px）；③ el() 是唯一 DOM 工厂。
 */
function makePanelUI(cfg) {
	const P = String(cfg && cfg.prefix ? cfg.prefix : "bp");
	const cls = (n) => P + "-" + n;
	// tone → 现役类名（映射表只此一处）。既收枚举名，也收历史 class 串（k-* / h-*），
	// 这样老调用点搬家时不会因为"到底是哪一种写法"再散出一份表。
	const KPI_TONE = { neutral: "k-gray", info: "k-blue", ok: "k-green", warn: "k-yellow", error: "k-red", "accent-cyan": "k-cyan", "accent-purple": "k-purple" };
	for (const k of Object.keys(KPI_TONE)) KPI_TONE[KPI_TONE[k]] = KPI_TONE[k];
	const BADGE_TONE = { neutral: "", info: "ui-tone-info", ok: "ui-tone-ok", warn: "ui-tone-warn", error: "ui-tone-error", muted: "ui-tone-muted", "h-green": "ui-tone-ok", "h-yellow": "ui-tone-warn", "h-red": "ui-tone-error", "h-gray": "ui-tone-muted", red: "ui-tone-error", yellow: "ui-tone-warn" };
	const BADGE_VARIANT = { soft: "ui-badge--soft", outline: "ui-badge--outline", tag: "ui-badge--tag", pin: "ui-badge--pin", plain: "ui-badge--plain", dot: "ui-badge--soft" };

	/** 唯一 DOM 工厂（§4.3 约定 ③）。 */
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== void 0) node.textContent = text;
		return node;
	}

	/** 分组标题。opts.count 有值时补一个计数位（老调用不带 = 与历史 DOM 一致）。 */
	function groupTitle(text, opts) {
		const box = el("div", cls("group"), text);
		if (opts && opts.count !== void 0 && opts.count !== null) box.appendChild(el("span", "cnt", "· " + opts.count));
		return box;
	}

	/**
	 * 浮层卡外壳：遮罩 + 卡 + 头 + Tab + 主体。
	 * 头部布局与历史一致：**有副标题**时标题/副标题包一层（副标题走 flex-basis 换行），
	 * 没副标题时标题直接铺开 —— 两条历史路径的 DOM 都原样保住（像素不变的前提）。
	 * @returns {{overlay:HTMLElement, root:HTMLElement, head:HTMLElement, tabsRow:HTMLElement, body:HTMLElement, tabBtns:object, actions:object, sub:HTMLElement|null, setActiveTab:Function, setSub:Function}}
	 */
	function card(o) {
		o = o || {};
		const overlay = el("div");
		overlay.setAttribute(o.panelAttr || "", "");
		const root = el("div", cls("card"));
		const head = el("div", cls("head"));
		let sub = null;
		if (o.subtitle !== void 0) {
			const box = el("div");
			box.appendChild(el("div", cls("title"), o.title == null ? "" : String(o.title)));
			sub = el("div", cls("sub"), o.subtitle == null ? "" : String(o.subtitle));
			box.appendChild(sub);
			head.appendChild(box);
		} else {
			head.appendChild(el("div", cls("title"), o.title == null ? "" : String(o.title)));
		}
		const actions = {};
		for (const a of o.actions || []) {
			const b = el("button", cls("btn"), a.label);
			if (a.onClick) b.addEventListener("click", a.onClick);
			head.appendChild(b);
			if (a.key) actions[a.key] = b;
		}
		root.appendChild(head);
		for (const n of o.belowHead || []) root.appendChild(n);
		const tabBtns = {};
		const tabsRow = el("div", cls("tabs"));
		let active = o.activeTab != null ? o.activeTab : ((o.tabs || [])[0] || {}).key;
		function setActiveTab(key) {
			active = key;
			for (const k of Object.keys(tabBtns)) tabBtns[k].classList.toggle(cls("on"), k === key);
		}
		for (const t of o.tabs || []) {
			const b = el("button", cls("tab"), t.label);
			b.type = "button";
			b.addEventListener("click", () => { setActiveTab(t.key); if (o.onTabChange) o.onTabChange(t.key); });
			tabBtns[t.key] = b;
			tabsRow.appendChild(b);
		}
		if ((o.tabs || []).length > 0) root.appendChild(tabsRow);
		const body = el("div", cls("body"));
		root.appendChild(body);
		overlay.appendChild(root);
		if (active != null) setActiveTab(active);
		return {
			overlay: overlay, root: root, head: head, tabsRow: tabsRow, body: body,
			tabBtns: tabBtns, actions: actions, sub: sub,
			setActiveTab: setActiveTab,
			setSub: (t) => { if (sub) sub.textContent = String(t == null ? "" : t); },
			get activeTab() { return active; },
		};
	}

	/** KPI 磁贴：替代旧的 kpi(label,num,cls,extra) —— tone 走枚举，不再由调用方拼 class。 */
	function kpi(o) {
		o = o || {};
		const tone = KPI_TONE[o.tone == null ? "neutral" : o.tone] || "";
		const node = el("div", cls("kpi") + (tone ? " " + tone : ""));
		node.appendChild(el("div", "num", String(o.value == null ? "—" : o.value)));
		node.appendChild(el("div", "lbl", (o.label == null ? "" : String(o.label)) + (o.hint ? " · " + o.hint : "")));
		if (o.onClick) node.addEventListener("click", o.onClick);
		return node;
	}

	/** 徽章：variant = soft | outline | tag | pin | plain（旧 5 套的唯一实现）。 */
	function badge(o) {
		o = o || {};
		const variant = BADGE_VARIANT[o.variant || "soft"] || BADGE_VARIANT.soft;
		const tone = BADGE_TONE[o.tone == null ? "neutral" : o.tone] || "";
		return el(o.tag || "span", "ui-badge " + variant + (tone ? " " + tone : ""), o.text == null ? "" : String(o.text));
	}

	/**
	 * 行（三种折叠的唯一实现）。
	 *  - flat:true ⇒ 不套 .main（资产行/建议行这类"直接铺子节点"的历史 DOM）；
	 *  - expandable + detail ⇒ 点击切换 open；detail 首次展开时才创建（异步 detail 也支持）；
	 *  - 不带 detail ⇒ 不做成可折叠（旧实现在这里挂了个"点了不展开"的空壳，已去掉）。
	 * @returns {{root:HTMLElement, setExpanded:Function, isExpanded:boolean}}
	 */
	function row(o) {
		o = o || {};
		const base = o.flat ? "" : cls("row");
		const root = el("div", (base + (o.cls ? " " + o.cls : "") + (o.expandable && o.detail ? " ui-open" : "")).trim());
		if (o.leading) root.appendChild(o.leading);
		const box = o.flat ? root : el("div", cls("main") + (o.mainCls ? " " + o.mainCls : ""));
		for (const n of o.children || []) box.appendChild(n);
		if (o.title !== void 0) box.appendChild(el("div", cls("name"), String(o.title)));
		if (o.desc !== void 0) box.appendChild(el("div", cls("desc"), String(o.desc)));
		if (o.meta !== void 0) box.appendChild(el("div", cls("meta"), String(o.meta)));
		let detailNode = null;
		let loading = false;
		if (o.detail && typeof o.detail === "function" && o.detail.length === 0) {
			// detail 可能是函数（同步返回节点 / 返回 Promise）；首次展开才算数
			detailNode = null;
		} else if (o.detail) {
			detailNode = o.detail;
		}
		function mountDetail() {
			if (!o.detail) return;
			if (detailNode) { box.appendChild(detailNode); return; }
			if (loading) return;
			loading = true;
			let v = null;
			try { v = o.detail(); } catch (e) { v = null; }
			if (v && typeof v.then === "function") {
				const ph = el("div", "ui-detail " + cls("note"), "展开中…");
				detailNode = ph;
				box.appendChild(ph);
				v.then((n) => { if (n) { ph.replaceWith(n); detailNode = n; } else ph.textContent = "（展开内容为空）"; })
					.catch((e) => { ph.textContent = "展开失败：" + String(e && e.message ? e.message : e); });
				return;
			}
			if (v) { detailNode = v; box.appendChild(v); }
		}
		if (o.detail && detailNode) {
			if (!detailNode.classList.contains("ui-detail")) detailNode.classList.add("ui-detail");
			box.appendChild(detailNode);
		}
		if (!o.flat) root.appendChild(box);
		if (o.actions) root.appendChild(o.actions);
		function setExpanded(on) {
			if (on && o.detail) mountDetail();
			root.classList.toggle("open", !!on);
		}
		if (o.expandable && o.detail) {
			root.addEventListener("click", (e) => {
				const t = e && e.target;
				if (t && typeof t.closest === "function" && t.closest("button")) return;
				setExpanded(!root.classList.contains("open"));
				if (o.onClick) o.onClick(e);
			});
		} else if (o.onClick) {
			root.addEventListener("click", o.onClick);
		}
		return { root: root, setExpanded: setExpanded, get isExpanded() { return root.classList.contains("open"); } };
	}

	/** 骨架屏：文案 + N 根 bar + 备注（真实冷启秒数文案与三根 bar 是资产，不许删）。 */
	function skeleton(o) {
		o = o || {};
		const box = el("div", cls("skel"));
		if (o.text !== void 0) box.appendChild(el("div", "", String(o.text)));
		const n = o.lines == null ? 3 : o.lines;
		for (let i = 0; i < n; i++) box.appendChild(el("div", "bar", ""));
		if (o.note !== void 0) box.appendChild(el("div", cls("note"), String(o.note)));
		return box;
	}

	return { el: el, groupTitle: groupTitle, card: card, kpi: kpi, badge: badge, row: row, skeleton: skeleton, cls: cls };
}
/* <<< panel-ui-js:end */

		// 【V31-018 卡 B】组件实例：唯一实现在受控块 `panel-ui-js:begin/end`（真源 tools/lib/panel-ui.mjs）。
		const UI = makePanelUI({ prefix: "bp" });
		const el = UI.el;              // 唯一 DOM 工厂（原 function el 已并入 panel-ui）
		const groupTitle = UI.groupTitle;
		function injectCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region 侧边栏下区按钮（self-heal 注入，v0.1 原样保留）
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		function settingsAnchor(root) {
			if (!root) return { area: void 0, button: void 0 };
			const foot = root.querySelector("[class*=\"footArea\"]");
			const holder = foot !== null ? foot : root;
			const area = holder.querySelector("[class*=\"settingsArea\"]");
			if (area === null) return { area: void 0, button: void 0 };
			const button = area.querySelector("button");
			return { area, button };
		}
		/**
		* 【路 A · 官方槽】侧边栏底区按钮组件：shell 把它放进 footerActions（设置齿轮正上方那一行，
		与今天注入位置同一个容器），并把 wide 传进来 —— 收起态（wide=false）渲染 rail 圆形，
		不再依赖 [data-sidebar-collapsed] 前缀 hack，也不再复制设置按钮的 className。
		*/
		function ButlerEntryButton(props) {
			const holder = React.useRef(null);
			React.useEffect(() => {
				const host = holder.current;
				if (host === null) return void 0;
				const btn = buildEntry(props.onToggle);
				host.appendChild(btn);
				return () => { try { host.removeChild(btn); } catch { /* 容器已随 React 卸载 */ } };
			}, []);
			return React.createElement("div", {
				className: "bp-slot-row" + (props.wide ? "" : " bp-railRow")
			}, React.createElement("span", {
				ref: holder,
				className: "bp-slot-holder"
			}));
		}
		/**
		* 注册官方槽 sidebar.footer.action（契约：Optional actions beside Settings at the sidebar foot；
		* 渲染函数返回自己的控件、点击行为自定）。返回 { ok, dispose }：
		* ok=false ⇒ 调用方回落旧的 DOM 注入路径（老主包 / 拿不到 React / 拿不到 slots 服务）。
		*/
		function mountSlotEntry(ctx, onToggle) {
			const slots = ctx ? ctx.slots : void 0;
			if (React === null || typeof React.createElement !== "function" || typeof React.useRef !== "function" || slots === void 0 || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				return { ok: false, dispose: () => {} };
			}
			try {
				const d = slots.inject("sidebar.footer.action", () => slots.register({
					name: "sidebar.footer.action",
					id: "butler-panel",
					order: 60,
					label: () => "大管家"
				}, (props) => React.createElement(ButlerEntryButton, {
					wide: props.wide === true,
					onToggle
				})));
				return { ok: true, dispose: () => { try { if (typeof d === "function") d(); } catch { /* 已释放 */ } } };
			} catch (err) {
				return { ok: false, dispose: () => {} };
			}
		}
		function buildEntry(onToggle) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.className = "bp-slot-trigger";
			entry.setAttribute(ENTRY_ATTR, "");
			entry.setAttribute("aria-label", "大管家（任务·会话·变更总览）");
			entry.setAttribute("title", "大管家（任务·会话·变更总览）");
			entry.innerHTML = ICON + "<span class=\"bp-butler-label\">大管家</span>";
			entry.addEventListener("click", (e) => {
				entry.blur();
				onToggle(e);
			});
			return entry;
		}
		function placeEntry(root, entry, opts) {
			if (root === null || typeof root.isConnected === "boolean" && !root.isConnected) return false;
			const { area, button } = settingsAnchor(root);
			if (button === void 0 || area === void 0) return false;
			entry.className = button.className;
			const holder = area.parentElement;
			if (holder === null) return false;
			const eco = holder.querySelector(ECO_ENTRY_SELECTOR);
			const ecoInHolder = eco !== null && eco.parentElement === holder;
			if (entry.parentElement !== holder) {
				const anchor = ecoInHolder ? (eco.nextElementSibling ?? area) : area;
				holder.insertBefore(entry, anchor);
			} else if (ecoInHolder && (entry.compareDocumentPosition(eco) & Node.DOCUMENT_POSITION_PRECEDING) === 0) {
				holder.insertBefore(entry, eco.nextElementSibling ?? area);
			}
			if (opts.onPlaced) opts.onPlaced();
			return true;
		}
		function mountEntry(onToggle, setActive) {
			if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {};
			const entry = buildEntry(onToggle);
			let root = void 0;
			let placed = false;
			let rootObserver = void 0;
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver?.disconnect();
					root = void 0;
					rootObserver = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver?.disconnect();
					root = void 0;
					rootObserver = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				if (placeEntry(root, entry, {})) {
					placed = true;
					if (rootObserver === void 0 && typeof MutationObserver !== "undefined") {
						rootObserver = new MutationObserver(() => {
							if (root === void 0 || !root.isConnected) { placed = false; tryPlace(); return; }
							if (!root.contains(entry)) placed = false;
							if (!placed) tryPlace();
							else placeEntry(root, entry, {});
						});
						rootObserver.observe(root, { childList: true, subtree: true });
					}
				}
			};
			const waitObserver = new MutationObserver(() => { tryPlace(); });
			waitObserver.observe(document.body, { childList: true, subtree: true });
			tryPlace();
			return () => {
				waitObserver.disconnect();
				rootObserver?.disconnect();
				entry.remove();
			};
		}
		//#endregion
		//#region 工具
		function fmtAgo(ts) {
			if (!ts) return "";
			const d = Math.floor((Date.now() - ts) / 86400000);
			if (d <= 0) {
				const h = Math.floor((Date.now() - ts) / 3600000);
				return h <= 0 ? "刚刚" : h + " 小时前";
			}
			return d + " 天前";
		}
		async function apiFetch(url, opts) {
			const res = await fetch(url, { cache: "no-store", ...(opts ?? {}) });
			const data = await res.json().catch(() => null);
			if (!res.ok) throw new Error((data?.error ?? data?.message) ?? ("HTTP " + res.status));
			return data;
		}
		/**
		 * 【V2-C】与 apiFetch 同语义，但**计量载荷**（按 UTF-8 字节，与 HTTP 口径一致）。
		 *   只用于分片拉取路径 —— R2 的"进资产 Tab ≤ 30 KB"要拿真实字节断言，估算不算数。
		 */
		async function apiFetchMetered(url, opts) {
			const res = await fetch(url, { cache: "no-store", ...(opts ?? {}) });
			const text = await res.text();
			const bytes = (typeof TextEncoder !== "undefined") ? new TextEncoder().encode(text).length : text.length;
			if (!res.ok) throw new Error("HTTP " + res.status + "：" + text.slice(0, 120));
			let data = null;
			try { data = JSON.parse(text); } catch { throw new Error("响应不是 JSON（前 120 字符：" + text.slice(0, 120) + "）"); }
			return { data, bytes };
		}
		// sparkline：values 含 null 视为断点；纯 SVG，无依赖
		function sparkSvg(values, h) {
			const clean = (values ?? []).filter((v) => v !== null && v !== void 0);
			if (clean.length < 2) return "";
			const w = 320;
			const step = w / Math.max(1, clean.length - 1);
			const max = Math.max(...clean, 1);
			const pts = clean.map((v, i) => (i * step).toFixed(1) + "," + (h - 4 - (v / max) * (h - 10)).toFixed(1));
			return "<svg viewBox=\"0 0 " + w + " " + h + "\" preserveAspectRatio=\"none\" style=\"width:100%;height:" + h + "px;display:block\" role=\"img\"><polyline points=\"" + pts.join(" ") + "\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\" stroke-linecap=\"round\" opacity=\"0.9\"/></svg>";
		}
		function shortId(id) { return id && id.length > 8 ? id.slice(0, 8) : id; }
		//#endregion
		//#region 会话跳转（v1.2 三级降级：行点击 → 侧栏搜索注入 → 复制 ID）
		// 生态事实（task-board board-mount 源码实证）：主包不暴露"激活会话"RPC（sessions 域
		// 只有 list/search/create/rename/history/prompt 等）；"回到/打开某会话"的正路 =
		// 点击侧边栏 sessionRow / searchResultRow（CSS module 类名保留 sessionRow/searchResultRow
		// 子串，React onClick 接受原生 click）。搜索注入=模拟用户在搜索框搜词并点结果行。
		function findSessionRow(title, id) {
			const rows = Array.from(document.querySelectorAll('[class*="sessionRow"]'));
			if (rows.length === 0) return null;
			const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
			const normTitle = norm(title);
			if (normTitle) {
				const exact = rows.find((r) => norm(r.textContent) === normTitle || norm(r.textContent).startsWith(normTitle));
				if (exact) return exact;
			}
			const short = shortId(id);
			return rows.find((r) => norm(r.textContent).includes(short)) ?? null;
		}
		function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
		// 搜索词 = 会话标题原文（保空格标点，只去换行压平）。workspace 搜索降级为"仅名称匹配"
		// 时名称=主包标题，只有原文子串能命中——清洗过的词必然失配（v1.2 教训）。
		function searchQueryFor(session) {
			const t = (session?.title ?? "").replace(/\n\s*/g, " ").trim();
			return t.length > 0 ? t.slice(0, 60) : "";
		}
		async function searchInject(session, overrideQuery) {
			// 展开搜索框：workspace 的搜索框默认收起（searchInput opacity:0、结果树不渲染），
			// 必须先点 searchButton 进展开态（searchExpanded）再注入，否则永远等不到结果行。
			const slot = document.querySelector('[class*="searchSlot"]');
			const isExpanded = slot !== null && String(slot.className).includes("searchExpanded");
			if (!isExpanded) {
				const btn = document.querySelector('[class*="searchButton"]');
				if (btn) { btn.click(); await sleep(300); }
			}
			const input = document.querySelector('[class*="searchInput"]');
			if (!input) return false;
			const query = (overrideQuery ?? searchQueryFor(session)).trim();
			if (!query) return false;
			const proto = window.HTMLInputElement?.prototype;
			const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
			input.focus();
			if (setter) setter.call(input, query);
			else input.value = query;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			// 结果行可能把名称截断显示，取原文前 8 字符做子串匹配最稳（行文本含该前缀即命中）
			const want = query.slice(0, 8);
			const short = shortId(session?.fullId ?? session?.id ?? "");
			for (let k = 0; k < 40; k++) {
				await sleep(120);
				// 约 1 秒仍无结果行 → 补发 Enter（搜索可能由键盘触发）
				if (k === 8) {
					try {
						input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
					} catch { /* ignore */ }
				}
				const rows = Array.from(document.querySelectorAll('[class*="searchResultRow"]'));
				if (rows.length === 0) continue;
				const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
				const hit = rows.find((r) => norm(r.textContent).includes(want) || norm(r.textContent).includes(short));
				if (hit) { hit.click(); await sleep(500); return true; }
			}
			// 没搜到结果：保留搜索框展开+输入词（主人可自己改词再搜），不强行清空收回
			return false;
		}
		function copySessionId(session) {
			if (navigator.clipboard && session?.fullId) navigator.clipboard.writeText(session.fullId).catch(() => {});
		}
		async function openSession(session, onFail) {
			// ① 快速路径：目标行已渲染 → 直接点
			if (session?.title) {
				const row = findSessionRow(session.title, session.fullId ?? session.id);
				if (row) { row.click(); return true; }
			}
			// ② 搜索注入（workspace 搜索结果行点击 = 打开会话）
			if (await searchInject(session)) return true;
			// ②b v1.4.4：无标题会话（标题为空/空壳会话）→ 用会话短 ID 再搜一次
			if (!searchQueryFor(session)) {
				const sid = shortId(session?.fullId ?? session?.id ?? "");
				if (sid && await searchInject(session, sid)) return true;
			}
			// ③ 兜底：复制完整 ID（无标题会话给更明确的说明，别再像"按钮失灵"）
			copySessionId(session);
			if (!searchQueryFor(session)) {
				onFail?.("该会话没有可搜索的标题（可能是空会话 / 未在会话列表渲染）——完整 ID 已复制到剪贴板");
			} else {
				onFail?.("未能自动定位（该会话可能已折叠或标题已改写）——搜索框已带词、完整 ID 已复制");
			}
			return false;
		}
		//#endregion
		//#region 面板（v1.1 仪表盘）
		// 【V2-B】Tab 名对照（assets/steward 的 Tab 由 V2-C 落地；此处先定名，供跳转提示与 KPI 去向文案用）
		const TAB_NAMES = { overview: "总览", sessions: "会话", tasks: "任务", changelog: "变更", memory: "记忆", reports: "报告", assets: "资产", steward: "管家" };
		function tabName(k) { return TAB_NAMES[k] ?? k; }
		function trendCard(title, values, h, color) {
			const box = el("div", "bp-trend");
			box.style.color = color ?? "var(--bp-accent)";
			const head = el("div", "t-title");
			head.appendChild(el("span", "", title));
			const vals = (values ?? []).filter((v) => v !== null && v !== void 0);
			head.appendChild(el("span", "t-last", vals.length ? String(vals[vals.length - 1]) : "—"));
			box.appendChild(head);
			const svg = sparkSvg(values, 46);
			if (svg) box.insertAdjacentHTML("beforeend", svg);
			return box;
		}
		// v0.2.0 健康监控（只读）：自动归档 / 升级体检 / 重启协调器 / P6 外部信号 / P8 收纳，异常一眼可见（总览页顶部）
		function healthCard(title, badge, badgeCls, lines, extra) {
			const box = el("div", "bp-health-card");
			const head = el("div", "bp-health-head");
			head.appendChild(el("span", "bp-health-title", title));
			head.appendChild(UI.badge({ text: badge, tone: badgeCls, variant: "soft" }));
			box.appendChild(head);
			for (const [k, v, cls] of lines) {
				const row = el("div", "bp-health-line" + (cls ? " " + cls : ""));
				const kk = el("span", "k", k);
				kk.title = String(k); // 长键（如错误码）省略号截断后仍可 hover 看全
				row.appendChild(kk);
				row.appendChild(el("span", "v", String(v)));
				box.appendChild(row);
			}
			if (extra) box.appendChild(extra);
			return box;
		}
		// ─────────────────────────────────────────────────────────────────────────────
		// 【卡「冲刺600 · audit-off 限时」· 2026-10-09】/audit-off 的两个前端面。
		//   口径（控制室口径包 §3.1 / §7.3，主人 2026-09-17 拍板）：保留逃生舱 + 必填理由 +
		//   **服务端 clamp TTL ≤30min**（clamp 在服务端，前端补传不算修好）+ **顶栏常驻横幅** + 升级告警。
		//   本段两件事：
		//     ① `submitAuditOff()` —— C⁺ 两步（先取一次性确认令牌 → 二次确认写明后果 → 带令牌提交），
		//        管家 Tab 的按钮与顶栏横幅**共用同一段**（两处实现必然漂移，所以只留一份）；
		//     ② `buildAuditBanner()` —— 顶栏常驻横幅：暂停生效期间一直在，剩余时间每秒走字，
		//        点【恢复】走既有 `setOff(false)`（同一个 POST，不另开写口）。
		//   数据源 = `GET /api/dsh-butler/audit-off`（服务端 `readAuditOff()`：active / until / expired / reason）。
		//   为什么横幅自己拉这一下：`audit` 片是"进管家 Tab 才拉"的，而横幅必须在面板一打开就准。
		// ─────────────────────────────────────────────────────────────────────────────
		/** C⁺ 两步提交。返回 `{ok:true,data}` / `{ok:false,cancelled:true}`；失败/取消都不改任何状态。 */
		async function submitAuditOff(goingOff, reasonText) {
			const tok = await apiFetch("/api/dsh-butler/audit-off", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "confirm" })
			});
			const maxMin = Math.max(1, Math.round((tok?.maxTtlMs ?? 1800000) / 60000));
			const yes = window.confirm(goingOff
				? "暂停写入审计？（C⁺ 高危 · 逃生舱）\n\n后果：保护区写入不再被**拦截**（写后审计仍记录，不停记录）。\n时长：最长 " + maxMin + " 分钟（服务端上限，会写进审计），到期自动恢复。\n本次操作会写审计流水与告警。"
				: "恢复写入审计？\n\n后果：保护区写入重新需要审计凭证（恢复正常拦截）。");
			if (!yes) return { ok: false, cancelled: true };
			const r = await apiFetch("/api/dsh-butler/audit-off", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ off: goingOff, reason: reasonText, confirmToken: tok?.token })
			});
			return { ok: true, data: r };
		}
		/**
		 * 顶栏常驻横幅。返回 `{node, refresh, dispose}`。
		 * 三种可见态：① `active`（暂停中，红）② `off && expired`（半完成态，黄）③ 其余 → 隐藏。
		 */
		function buildAuditBanner() {
			const box = el("div", "bp-audit-banner");
			box.style.display = "none";
			const icon = el("span", "bp-ab-icon", "⏸");
			const txt = el("span", "bp-ab-txt", "");
			const cd = el("span", "bp-ab-cd", "");
			const btn = el("button", "bp-btn", "恢复写入审计");
			btn.title = "恢复后保护区写入重新需要审计凭证（走服务端 setOff(false)）";
			box.appendChild(icon);
			box.appendChild(txt);
			box.appendChild(cd);
			box.appendChild(btn);
			let snap = null;
			let ticker = null;
			let poller = null;
			const hhmm = (ms) => new Date(Number(ms)).toLocaleTimeString("zh-CN", { hour12: false });
			const mmss = (ms) => {
				const s = Math.max(0, Math.round(Number(ms) / 1000));
				return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
			};
			const paint = () => {
				const off = snap?.off === true;
				const active = snap?.active === true;
				const expired = snap?.expired === true;
				if (!off && !active) { box.style.display = "none"; stopTicker(); stopPoller(); return; }
				box.style.display = "";
				startPoller();
				if (active) {
					box.classList.remove("bp-half");
					icon.textContent = "⏸";
					const untilTxt = Number.isFinite(snap?.until) ? hhmm(snap.until) : "（无到期时间·异常）";
					txt.textContent = "写入审计已暂停（逃生舱）：保护区写入不再被拦截（写后审计仍记录）· 理由：" + (snap?.reason ?? "（未记）") + " · " + untilTxt + " 自动恢复";
					cd.textContent = Number.isFinite(snap?.until) ? ("剩余 " + mmss(snap.until - Date.now())) : "";
					btn.textContent = "恢复写入审计";
					startTicker();
				} else if (expired) {
					box.classList.add("bp-half");
					icon.textContent = "⚠️";
					txt.textContent = "暂停已到期：写入审计的拦截已自动恢复（读数按到期时间解释），但状态文件仍挂着 off:true（半完成态）——点右侧清掉。理由：" + (snap?.reason ?? "（未记）");
					cd.textContent = "";
					btn.textContent = "清掉半完成态";
					stopTicker();
				}
			};
			function startTicker() {
				if (ticker !== null) return;
				ticker = setInterval(() => {
					if (snap?.active !== true) { stopTicker(); return; }
					if (Number.isFinite(snap?.until) && snap.until - Date.now() <= 0) { void refresh(); return; }
					paint();
				}, 1000);
			}
			function stopTicker() { if (ticker !== null) { clearInterval(ticker); ticker = null; } }
			// 每 60s 复拉一次：覆盖"外部直接改文件 / 服务端 TTL 到期 / 别的页面恢复"（服务端该端点现读盘、不吃缓存）
			function startPoller() { if (poller === null) poller = setInterval(() => { void refresh(); }, 60000); }
			function stopPoller() { if (poller !== null) { clearInterval(poller); poller = null; } }
			async function refresh() {
				try {
					const r = await apiFetch("/api/dsh-butler/audit-off");
					if (r && typeof r === "object") snap = r;
				} catch {
					// 拉不到 ⇒ 保持上次已知状态并照常显示（**绝不**因为拉取失败就假装"已恢复"）
					return;
				}
				paint();
			}
			btn.addEventListener("click", async () => {
				const label = btn.textContent;
				btn.disabled = true;
				try {
					const r = await submitAuditOff(false, "主人恢复写入审计");
					if (r.cancelled) {
						btn.textContent = "已取消（令牌作废，未改动）";
						setTimeout(() => { btn.textContent = label; }, 1500);
						return;
					}
					await refresh();
					btn.textContent = "✓ 已恢复";
					setTimeout(() => { if (snap?.active !== true) btn.textContent = "恢复写入审计"; }, 1200);
				} catch (e) {
					btn.textContent = "失败：" + (e?.message ?? e);
					setTimeout(() => { btn.textContent = label; }, 2500);
				} finally {
					btn.disabled = false;
				}
			});
			return {
				node: box,
				refresh,
				/** 面板关闭时调用：清掉定时器（别让关掉的 DOM 继续走字/发请求）。 */
				dispose: () => { stopTicker(); stopPoller(); }
			};
		}
		// v0.4.0（卡 [2b] P5）：写入审计守门人 —— 暂停开关 + 干预统计（分级校准数据）
		function buildAudit(a, v2c, bus) {
			const zone = el("div");
			if (!a) {
				// 【V2-C】audit 片未到（进本 Tab 才拉）→ 显式"未到/拉取中"，绝不显示空的"运行中"假态。
				zone.appendChild(groupTitle("🛡 写入审计（P5 · 守门人）"));
				zone.appendChild(el("div", "bp-note", v2c?.loading ? "audit 片拉取中…（串行队列）" : "audit 片未到（P5 守门人明细不可探测，进本 Tab 会按需拉它）"));
				return zone;
			}
			zone.appendChild(groupTitle("🛡 写入审计（P5 · 守门人）"));
			const grid = el("div", "bp-health");
			const st = a.stats ?? {};
			const t = st.totals ?? {};
			const g = a.guard ?? {};
			const off = g.off ?? {};
			const paused = off.active === true;
			const lines = [
				["审计状态", g ? (paused ? "⏸ 已暂停（主人逃生舱）" : "✅ 运行中（A 层 fs 门 + 内容门 + 磁盘层）") : "⚠️ 守门人未挂载"],
				["累计拦截", (t.blocks ?? 0) + " 次（A 层 / 内容门）"],
				["放行 / 发证", (t.passes ?? 0) + " / " + (t.issues ?? 0) + " 次"],
				["写后违规", (t.postBlocks ?? 0) + " 次（B 层，已回滚）"],
				["逃生舱", "暂停 " + (t.pauses ?? 0) + " · force " + (t.forces ?? 0)],
				["待用凭证", g?.tokens ? g.tokens.size + " 条（TTL " + Math.round((g.tokens.ttlMs ?? 0) / 60000) + " 分钟）" : "—"],
				["统计窗口", "最近 " + (st.windowDays ?? "?") + " 天（审计流水，0 token）"]
			];
			if (paused && off.reason) lines.push(["暂停原因", off.reason]);
			// 【卡「冲刺600 · audit-off 限时」】暂停时把「自动恢复时刻」摆明（改前只有一行"已暂停"，
			//   主人看不到"到底什么时候会自己回来"）；半完成态（到期未清）同样显式一行。
			if (paused) {
				lines.push(["自动恢复", Number.isFinite(off.until) ? new Date(off.until).toLocaleTimeString("zh-CN", { hour12: false }) + "（服务端上限 30 分钟）" : "（无到期时间·异常）"]);
			} else if (off.off === true && off.expired === true) {
				lines.push(["半完成态", "TTL 已到期（拦截已自动恢复），文件仍挂 off:true —— 点下面按钮清掉"]);
			}
			const card = healthCard("🛡 守门人", paused ? "已暂停" : (g ? "运行中" : "未挂载"), paused ? "h-yellow" : (g ? "h-green" : "h-gray"), lines);
			const acts = el("div", "bp-acts");
			const btn = el("button", "bp-act " + (paused ? "primary" : ""), paused ? "恢复写入审计" : "暂停写入审计");
			btn.title = paused ? "恢复后保护区写入重新需要审计凭证" : "主人专用逃生舱：暂停期间保护区写入不再拦截（每次暂停留审计行）";
			btn.addEventListener("click", async () => {
				btn.disabled = true;
				try {
					// 【施工卡 ①-3 · P-6】C⁺ 两步：先取一次性确认令牌 → 二次确认写明后果 → 带令牌提交。
					//   （改前是"点击即提交"，服务端没有任何"主人确认过"的证据）
					// 【卡「冲刺600 · audit-off 限时」】实现抽到 `submitAuditOff()`，与顶栏横幅共用同一段；
					//   确认框现已写明"最长 N 分钟（服务端上限）"。
					const goingOff = !paused;
					const r = await submitAuditOff(goingOff, goingOff ? "主人暂停写入审计" : "主人恢复写入审计");
					if (r.cancelled) { btn.textContent = "已取消（令牌作废，未改动）"; btn.disabled = false; return; }
					const clamped = r.data?.ttlClamped === true;
					btn.textContent = "✓ 已切换" + (clamped ? "（时长已按上限 clamp）" : "") + "（刷新面板后生效）";
					// 顶栏横幅立刻对齐（服务端已 invalidate 分片缓存，管家 Tab 下次进也会是新值）
					bus?.refreshAuditBanner?.();
				} catch (e) {
					btn.textContent = "失败：" + (e?.message ?? e);
					btn.disabled = false;
				}
			});
			acts.appendChild(btn);
			card.appendChild(acts);
			grid.appendChild(card);
			const codeRows = Object.entries(st.byCode ?? {}).sort((x, y) => y[1] - x[1]).slice(0, 6);
			if (codeRows.length) {
				grid.appendChild(healthCard("📊 干预统计（分级校准数据）", (t.blocks ?? 0) + " 次拦截", (t.blocks ?? 0) > 0 ? "h-yellow" : "h-green",
					codeRows.map(([k, v]) => [k, v + " 次", "bp-k-wide"])));
			}
			zone.appendChild(grid);
			const cal = st.calibration ?? [];
			if (cal.length) zone.appendChild(el("div", "bp-note", "校准建议（只建议，不自动改分级）：" + cal.join(" ")));
			return zone;
		}
		// v0.6.0（规则 R4「开关是活的」，2026-09-13 主人定）：模块级熔断开关（kill switch L2）—— 一键关/开。
		//   数据源 = GET /api/dsh-butler/modules（服务端现读 ~/.dsh/butler-autonomy.json 的 modules 段）；
		//   写入 = POST /api/dsh-butler/modules/set（why 必填 → 原子写 + 审计流水 + moduleHistory）。
		//   前端**不复制**任何模块清单/归属/baseline：id、label、归属总开关、来源全部由服务端给，
		//   所以 lib/autonomy-modules.mjs 加一个模块，这里不用改一行（零维护）。
		//   交互（主人点破过"要活的开关"）：点【关】/【开】→ 就地展开确认条（**二次确认**）+ **必填理由**，
		//   理由为空时提交按钮保持 disabled（防"关了但没人知道为什么"）。
		// 🌒 影子（若开启会执行）—— 卡：V3 全量开发 批次 1（矩阵 §1 前置② / §5 待办 1）
		//   为什么放在本卡里：策略是"v2 全量开发完 + 开关默认全关 + 等观测报告再逐项放行"，
		//   于是默认关的动作必须能"被看见"（若开启会执行哪几项），放行当天才不是第一次真跑。
		//   数据源 = GET /modules 的 shadow 字段（服务端 lib/shadow-view.mjs 纯只读采集）→
		//   与日报「🌒 影子」段**同一份计数、同一句空态文案**（前端不复制判定，也不写任何开关）。
		function buildShadow(sh) {
			const card = el("div", "bp-health-card");
			const head = el("div", "bp-health-head");
			head.appendChild(el("span", "bp-health-title", "🌒 影子（若开启会执行）"));
			if (!sh) {
				head.appendChild(UI.badge({ text: "不可用", tone: "h-gray", variant: "soft" }));
				card.appendChild(head);
				card.appendChild(el("div", "bp-note", "影子计数不可用（面板刚部署未重启，或 butler 侧 shadow-view.mjs 缺失）→ 重启后本区自动恢复；CLI 兜底：node <大管家目录>/butler-autonomy-cli.mjs status"));
				return card;
			}
			const mods = sh.byModule ?? [];
			head.appendChild(UI.badge({
				text: sh.hasShadow ? ("今日 " + (sh.todayDryRun ?? 0) + " 条 · 窗口 " + (sh.windowDryRun ?? 0) + " 条") : "无",
				tone: sh.hasShadow ? "h-yellow" : "h-green", variant: "soft" }));
			card.appendChild(head);
			if (!sh.hasShadow) {
				card.appendChild(el("div", "bp-note", sh.emptyText ?? "无（全部动作按档位关闭）"));
			} else {
				for (const m of mods) {
					const gate = m.enabled === false ? "L2 关" : (m.allowed === false ? ("关：" + (m.blockedBy ?? "?")) : "L2 开");
					const kinds = (m.kinds ?? []).map((k) => k.kind + " ×" + k.count).join("、");
					card.appendChild(el("div", "bp-note", "🌒 " + m.id + "（" + (m.label ?? m.id) + "｜" + gate + "）→ " + m.dryRunCount + " 条：" + kinds));
				}
				for (const r of (sh.recent ?? [])) {
					card.appendChild(el("div", "bp-note", "　最近：" + (r.at ? new Date(r.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—") + " " + r.kind + "（" + (r.level ?? "?") + "）" + (r.detail ? "：" + r.detail : "")));
				}
			}
			card.appendChild(el("div", "bp-note", "以上仅为「若开启会执行」的影子预测（dry-run 通道只算不动），未产生任何真实动作；"
				+ (sh.note ?? "") + "。放行后 48h 内按矩阵 R3 对照一次「真做的 vs 影子预测的」。"));
			return card;
		}
		function buildModules(md, bus) {
			const zone = el("div");
			const mm = md ?? {};
			zone.appendChild(groupTitle("🛑 模块开关（熔断 · L2）"));
			const rows = mm.modules ?? [];
			if (!rows.length) {
				// 【0.9.6 · 2026-11-09】归因必须**拆两句**：`Cannot find module …` ≠ `GET /modules 返回 404`。
				//   前者 = **工作区 / 大管家目录指错**（DSH_WORKSPACE 或 BUTLER_ROOT 没指到那棵树），
				//   后者才是"面板刚部署但 dsh 还没重启"。0.9.5 及以前把两种混成一句"面板刚部署还没重启"⇒
				//   接口其实回了 200、只是 body 里是 Cannot find module，照那句话去重启 = 白折腾一轮。
				//   兜底同理：只给"装 engine 包 + 设 BUTLER_ROOT"漏掉了 README 变量表里第一顺位的 DSH_WORKSPACE。
				const errText = String(mm.error ?? mm.reason ?? "未知");
				const is404 = /\b404\b/.test(errText) && !/Cannot find module/i.test(errText);
				// 实际去找的那个路径（Node 的 ERR_MODULE_NOT_FOUND 消息自带）—— 有就并排显示，没有就退成库文件名
				const missPath = (errText.match(/Cannot find module\s*['"]([^'"]+)['"]/i) ?? [])[1] ?? null;
				const lines = [["状态", "读取失败：" + errText]];
				if (is404) {
					lines.push(["常见原因", "面板刚部署但 dsh 还没重启（GET /modules 返回 404）→ 重启后本卡自动恢复"]);
				} else {
					lines.push(["常见原因", "找不到 " + (missPath ?? "大管家共享库（autonomy-modules.mjs）") + "：多为工作区或大管家目录指错"]);
					lines.push(["工作区", "DSH_WORKSPACE=<你的 DSH 工作区（tools/ 与 docs/ 所在那层）>"
						+ (missPath ? "，当前按此解析到 " + missPath : "")]);
					lines.push(["或", "BUTLER_ROOT=<大管家工具目录（即 <工作区>/tools/dsh-butler 那层）>"]);
					lines.push(["生效", "改完需重启 DSH 才生效"]);
				}
				lines.push(["兜底", "关/开也可用 CLI：node <大管家目录>/butler-autonomy-cli.mjs module list"]);
				zone.appendChild(healthCard("🛑 模块开关", "不可用", "h-gray", lines));
				return zone;
			}
			const off = rows.filter((x) => x.enabled !== true);
			const card = el("div", "bp-health-card");
			const head = el("div", "bp-health-head");
			head.appendChild(el("span", "bp-health-title", "🛑 模块开关（逐模块熔断）"));
			const badgeCls = mm.degraded ? "h-red" : (off.length ? "h-yellow" : "h-green");
			head.appendChild(UI.badge({ text: "L0 " + (mm.level ?? "?") + " · 已关闭 " + off.length + " / " + rows.length + " 项", tone: badgeCls, variant: "soft" }));
			card.appendChild(head);
			const openConfirm = (row, m, target) => {
				const nxt = row.nextElementSibling;
				if (nxt && nxt.classList && nxt.classList.contains("bp-mod-confirm")) {
					const old = nxt.querySelector(".bp-mod-input");
					if (old) old.focus();
					return;
				}
				const box = el("div", "bp-mod-confirm");
				box.appendChild(el("div", "bp-mod-ask",
					"确认" + (target ? "开启" : "关闭") + "「" + (m.label ?? m.id) + "」（" + m.id + "）？"
					+ (target ? "开启后该模块立即恢复按档位自动执行。" : "关闭后该模块不再发起新动作（在跑的跑完），修好后请回原卡恢复。")));
				const inp = document.createElement("input");
				inp.className = "bp-mod-input";
				inp.type = "text";
				inp.maxLength = 200;
				inp.placeholder = "必填：为什么" + (target ? "开" : "关") + "（写入审计流水 + 日报）";
				box.appendChild(inp);
				const btns = el("div", "bp-mod-btns");
				const ok = el("button", "bp-act" + (target ? " primary" : " warn"), target ? "确认开启" : "确认关闭");
				ok.disabled = true; // 理由必填：为空禁用提交
				const cancel = el("button", "bp-act", "取消");
				const msg = el("span", "bp-mod-meta", "");
				btns.appendChild(ok); btns.appendChild(cancel); btns.appendChild(msg);
				box.appendChild(btns);
				inp.addEventListener("input", () => { ok.disabled = inp.value.trim().length === 0; });
				cancel.addEventListener("click", () => box.remove());
				ok.addEventListener("click", async () => {
					const why = inp.value.trim();
					if (!why) return;
					ok.disabled = true; cancel.disabled = true; ok.textContent = "提交中…";
					try {
						const r = await apiFetch("/api/dsh-butler/modules/set", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ id: m.id, enabled: target, why })
						});
						if (r && r.ok === false) throw new Error(r.error ?? r.code ?? "写入被拒");
						msg.textContent = "✓ 已" + (target ? "开启" : "关闭") + "，正在刷新…";
						if (bus && bus.reloadModules) await bus.reloadModules();
					} catch (e) {
						msg.textContent = "失败：" + (e && e.message ? e.message : e);
						ok.textContent = target ? "确认开启" : "确认关闭";
						ok.disabled = false; cancel.disabled = false;
					}
				});
				row.after(box);
				inp.focus();
			};
			for (const m of rows) {
				const row = el("div", "bp-mod-row" + (m.enabled ? "" : " bp-mod-off"));
				row.appendChild(el("span", "bp-mod-badge", m.enabled ? "🟢" : "🔴"));
				const body = el("div", "bp-mod-body");
				const top = el("div", "bp-mod-top");
				top.appendChild(el("span", "bp-mod-id", m.id));
				top.appendChild(el("span", "bp-mod-label", m.label ?? ""));
				body.appendChild(top);
				const l1 = m.owner
					? ("归 " + m.owner + (m.ownerOn === true ? "（开）" : m.ownerOn === false ? "（关）" : "（未知）"))
					: "无归属总开关";
				// 批次9（2026-09-14）：raw 键与「两把/三把键」提示 —— 文案与 CLI `module list` 逐字一致。
				//   rawOwner / rawOwnerOn 由服务端**原样透传** butler 侧（只回报呈现，判定面一行不动）；
				//   rawGate 是服务端派生的呈现字段（放行要几把键）。无 raw 键的模块 rawTxt="" → 与改动前完全一致。
				let rawTxt = "";
				if (m.rawOwner) {
					const rawVal = m.rawOwnerOn === true ? "true" : m.rawOwnerOn === false ? "false" : "未提供";
					rawTxt = " · raw " + m.rawOwner + "（原始键值=" + rawVal + "）";
					if (m.rawGate) rawTxt += " · 放行 " + m.rawGate.expr + "（" + m.rawGate.countText + "）";
				}
				body.appendChild(el("div", "bp-mod-meta", "来源 " + (m.source ?? "?") + " · L1 " + l1 + rawTxt + " · 生效 " + (m.allowed ? "是" : "否：" + (m.blockedBy ?? "?"))));
				if (m.by || m.why || m.since) {
					const hist = el("div", "bp-mod-meta",
						(m.since ? "变更 " + String(m.since).slice(0, 16).replace("T", " ") : "")
						+ (m.by ? " · by " + m.by : "")
						+ (m.why ? " · " + m.why : ""));
					hist.title = "by " + (m.by ?? "—") + "｜why " + (m.why ?? "—") + "｜since " + (m.since ?? "—");
					body.appendChild(hist);
				}
				row.appendChild(body);
				const acts = el("div", "bp-acts");
				const btn = el("button", "bp-act" + (m.enabled ? " warn" : " primary"), m.enabled ? "关" : "开");
				btn.title = m.enabled ? ("关闭「" + (m.label ?? m.id) + "」：该模块不再发起新动作") : ("开启「" + (m.label ?? m.id) + "」：恢复按档位自动执行");
				btn.addEventListener("click", () => openConfirm(row, m, !m.enabled));
				acts.appendChild(btn);
				row.appendChild(acts);
				card.appendChild(row);
			}
			zone.appendChild(card);
			zone.appendChild(buildShadow(mm.shadow));
			const l1on = Object.entries(mm.l1 ?? {}).filter((x) => x[1] === true).map((x) => x[0]);
			zone.appendChild(el("div", "bp-note",
				"四级熔断：L0 全局降档（" + (mm.level ?? "?") + "）⊃ L1 总开关（" + (l1on.length ? l1on.join("、") : "四键全关") + "）⊃ L2 本卡模块开关 ⊃ L3 动作级。"
				+ "关闭 ≠ 掐断（drain 语义）：只表示「不再发起新动作」，在跑的动作跑完。"
				+ "热生效：tickd job 下次 spawn 即读（≤1 tick）；常驻 tickd 调度需 --stop + --ensure；DSH 插件 / 守护鱼需重启。"
				+ "每次变更写审计流水 + moduleHistory + 日报「🛑 已关闭模块」；关掉后 48h 内跑一次 dry-run 对照，确认「真的没再做」。"
				+ "开关债：临时熔断的模块修好后必须在同一张卡里恢复，长期不恢复的要转成正式档位或从矩阵删掉。"));
			// 批次9（2026-09-14）：CLI 恒定口径两行上卡 —— 面板与 CLI `module list` 同一口径（逐字可对照）。
			//   第一行照抄（服务端常量）；第二行由服务端按模块登记表**派生**，前端不写死任何模块清单。
			//   旧服务端（未重启）不给这两个字段 → 本区自动不显示，不影响模块开关卡本身。
			if (mm.runActionGateNote) zone.appendChild(el("div", "bp-note", "ⓘ 恒定口径：" + mm.runActionGateNote));
			if (mm.rawGateHint) zone.appendChild(el("div", "bp-note", "ⓘ " + mm.rawGateHint));
			return zone;
		}
				// 📜 本鱼契约页（2026-09-10 主人令）
		//   形态：大管家面板的**独立一页**（第 2 个 Tab「📜 契约」）= 段落分组 + 顶部 4 类筛选
		//   （初版误做成总览页里的一张卡；主人点破"当初说的是单做一页"→ 改回一页纸形态，
		//    并拍板"段落分组 + 4 类筛选两者都要"）。
		//   数据源 = /state 的 contract 字段（服务端每次现读现解析 persona）；前端只渲染，绝不写死 persona 内容。
		//   展开全文 = 复用 .bp-cl-extra；筛选选中态 = 复用 .bp-tab.bp-on；类型 = 行首图标（与筛选条同款，自解释）。
		//   注：初版用红/黄色点表示类型，主人第一眼问"红黄蓝灯是啥意思"→ 色点会被误读成"严重程度"，已改图标。
		const CONTRACT_SHOW_PER_GROUP = 10;
		const CONTRACT_ICONS = { code: "🔑", rule: "⚖️", identity: "🐋", pref: "🤝" };
		function buildContract(c) {
			const zone = el("div");
			const pc = c ?? {};
			const render = (kind) => {
				zone.replaceChildren();
				if (!pc.ok) {
					zone.appendChild(groupTitle("📜 本鱼契约（只读 · 运行时解析 persona）"));
					const grid0 = el("div", "bp-health");
					grid0.appendChild(healthCard("📜 本鱼契约", "不可读", "h-gray", [
						["状态", "persona 读不到：" + (pc.error ?? "未知原因")],
						["路径", pc.file ?? "（未解析出路径）"],
						["影响", "只影响这一页，其它 Tab 与数据照常"]
					]));
					zone.appendChild(grid0);
					zone.appendChild(el("div", "bp-note", "persona 不可读时本页灰态显示，不报错、不影响面板其它部分。"));
					return;
				}
				const list = pc.list ?? [];
				const kinds = pc.kinds ?? [];
				const shortFile = String(pc.file ?? "").split("\\").slice(-2).join("\\");
				// 抬头：一页纸的汇总条
				const head = el("div", "bp-health");
				head.appendChild(healthCard("📜 本鱼契约（" + (pc.total ?? 0) + " 条 · " + list.length + " 段）", "运行时", "h-green", [
					["来源", shortFile + "（persona · 只读）"],
					["最后修改", pc.mtime ? fmtAgo(pc.mtime) : "—"],
					["口径", "每次打开现读现解析 · 不复制 · 不缓存"],
					["用法", "点条目看全文 · 点下面分类筛选"]
				]));
				zone.appendChild(head);
				// 4 类筛选条（🔑 暗号 / ⚖️ 铁律 / 🐋 身份 / 🤝 偏好 + 全部）：点击就地重渲染本页
				const bar = el("div", "bp-acts");
				bar.style.margin = "4px 0 8px";
				const mkFilter = (key, label, n) => {
					const b = el("button", "bp-tab" + (kind === key ? " bp-on" : ""), label + (n == null ? "" : " " + n));
					b.title = key === "all" ? "显示全部段落的全部条目" : "只看这一类（跨段落筛选）";
					b.addEventListener("click", () => render(key));
					return b;
				};
				bar.appendChild(mkFilter("all", "全部", pc.total ?? 0));
				for (const k of kinds) bar.appendChild(mkFilter(k.key, k.icon + " " + k.label, k.count));
				zone.appendChild(bar);
				// 段落卡：筛选时只留下含该类条目的段，段内只列该类条目
				const grid = el("div", "bp-health");
				let shownGroups = 0;
				for (const g of list) {
					const items = kind === "all" ? g.items : g.items.filter((it) => it.kind === kind);
					if (items.length === 0) continue;
					shownGroups++;
					const extra = el("div", "bp-health-list");
					const rows = el("div");
					const addRow = (it) => {
						const wrap = el("div");
						const row = el("div", "bp-health-item");
						row.style.cursor = "pointer";
						row.title = "点击展开/收起全文";
						const nm = el("span", "nm", (CONTRACT_ICONS[it.kind] ?? "📄") + " " + (it.title || "（无标题）"));
						nm.title = it.title ?? "";
						row.appendChild(nm);
						row.appendChild(el("span", "vv", it.summary || "—"));
						const full = el("div", "bp-cl-extra", it.full ?? "");
						full.style.display = "none";
						row.addEventListener("click", () => {
							full.style.display = full.style.display === "none" ? "block" : "none";
						});
						wrap.appendChild(row);
						wrap.appendChild(full);
						rows.appendChild(wrap);
					};
					for (const it of items.slice(0, CONTRACT_SHOW_PER_GROUP)) addRow(it);
					extra.appendChild(rows);
					const rest = items.length - CONTRACT_SHOW_PER_GROUP;
					if (rest > 0) {
						const more = el("button", "bp-btn", "展开其余 " + rest + " 条");
						more.title = "展开本段剩余条目（点条目本身可看全文）";
						more.addEventListener("click", () => {
							for (const it of items.slice(CONTRACT_SHOW_PER_GROUP)) addRow(it);
							more.remove();
						});
						const barSlot = el("div", "bp-health-line");
						barSlot.appendChild(more);
						extra.appendChild(barSlot);
					}
					const badge = kind === "all" ? g.items.length + " 条" : items.length + " / " + g.items.length;
					grid.appendChild(healthCard((g.icon ?? "📄") + " " + g.group, badge, "h-gray", [], extra));
				}
				if (shownGroups === 0) zone.appendChild(el("div", "bp-empty", "这一类暂时还没有条目。"));
				zone.appendChild(grid);
				zone.appendChild(el("div", "bp-note", "数据来源：" + (pc.file ?? "persona") + "（每次打开面板现读现解析，persona 一改这里立刻同步；面板不复制内容、不落状态文件、不缓存）。条数口径 = persona 里的段落说明 + 每条「- 」规矩；行首图标 = 🔑 暗号 / ⚖️ 铁律 / 🐋 身份 / 🤝 偏好（与上方筛选条同款，按标题/句式归类，兜底归偏好）；点任意条目看全文。"));
			};
			render("all");
			return zone;
		}
		/**
		 * 🩺 健康监控（6 子块）。
		 * 【V2-C 分区渲染】`opts.sections` 是一个**取子集**的白名单（缺省 = 全部 6 块，行为与改造前一致）：
		 *   · 「资产」Tab → `['upgradeLock','upgrades','tidy']`（升级锁 / 升级体检 / P8 产出与收纳）
		 *   · 「管家」Tab → `['archive','external']`（会话自动归档 / P6 外部信号）
		 *   分区模式下**不加** groupTitle（由调用方给自己的分区标题），但不影响任何卡片内容 ——
		 *   每段的"取数据 + if/else 链"结构完全不变，只是取到的对象为 null 时整段跳过（零缩进重排）。
		 *   去重纪律（审核 D-2）：明细卡片**只存在于**这两个 Tab；首屏只保留"异常行 + 跳转"。
		 */
		function buildHealth(h, opts) {
			const sections = Array.isArray(opts?.sections) ? opts.sections : null;
			// 【P1】health 卡里也可能长动作按钮（升级体检 → L0 预检）⇒ 需要 bus 才能执行后刷新首屏。
			const bus = opts?.bus ?? null;
			const on = (k) => (sections === null || sections.includes(k));
			const zone = el("div");
			if (!h) return zone;
			if (sections === null) zone.appendChild(groupTitle("🩺 健康监控（只读）"));
			const grid = el("div", "bp-health");
			// ⓪ 升级锁（B3 前置 · 2026-09-11）：中断现场优先看这张卡 —— 半升级态 dsh 起不来，
			//    人第一眼开的是面板，"断在 step=X、回滚用什么"必须直接摆最前面。
			const ul = on("upgradeLock") ? (h.upgradeLock ?? {}) : null;
			if (ul === null) { /* 本 Tab 不呈现该分区（V2-C 分区渲染） */ }
			else if (!ul.ok) {
				grid.appendChild(healthCard("🔒 升级锁", "读不到", "h-gray", [
					["状态", ul.error ?? "butler lib 不可用"],
					["路径", "~/.dsh/upgrade-lock"]
				]));
			} else if (ul.state === "none") {
				grid.appendChild(healthCard("🔒 升级锁", "无锁", "h-green", [
					["状态", "没有升级在进行（上一次已正常收尾）"],
					["路径", "~/.dsh/upgrade-lock"]
				]));
			} else {
				const badgeMap = { held: "升级进行中", interrupted: "🔴 断在半路", uncertain: "⚠️ 卡住？", unknown: "无法判定", done: "已收尾未释放" };
				const badge = badgeMap[ul.state] ?? ul.state;
				const cls = (ul.state === "held" || ul.state === "done") ? "h-yellow" : "h-red";
				let extra = null;
				if (ul.hint) {
					extra = el("div", "bp-health-list");
					const row = el("div", "bp-health-item");
					row.appendChild(el("span", "dot " + (ul.state === "interrupted" ? "bp-dot-red" : "bp-dot-yellow")));
					row.appendChild(el("span", "nm", ul.state === "interrupted" ? "回滚口径" : "提示"));
					row.appendChild(el("span", "vv", String(ul.hint).slice(0, 220)));
					extra.appendChild(row);
					if (ul.silence && ul.silence.inWindow) {
						const r2 = el("div", "bp-health-item");
						r2.appendChild(el("span", "dot bp-dot-yellow"));
						r2.appendChild(el("span", "nm", "静默窗仍开"));
						r2.appendChild(el("span", "vv", "自动化没恢复：跑 dsh-upgrade-silence.mjs --enable"));
						extra.appendChild(r2);
					}
				}
				grid.appendChild(healthCard("🔒 升级锁", badge, cls, [
					["当前步骤", (ul.step ?? "?") + "（phase " + (ul.phase ?? "?") + "）"],
					["心跳", ul.heartbeatAgeMs == null ? "—" : Math.round(ul.heartbeatAgeMs / 60000) + " 分钟前（TTL " + Math.round((ul.ttlMs ?? 0) / 60000) + " 分钟）"],
					["进程", (ul.pid ?? "?") + (ul.pidAlive ? " 存活" : " 已退出") + (ul.sessionId ? " · " + shortId(ul.sessionId) : "")],
					["目标版本", (ul.fromVersion ?? "?") + " → " + (ul.targetVersion ?? "?")],
					["起于", ul.startedAt ? fmtAgo(Date.parse(ul.startedAt)) : "—"]
				], extra));
			}
			// ① 会话自动归档（dsh-archive-sessions 0.2.0）
			// ⓪.5 tickd 常驻调度（卡「tickd 停摆治本」· 2026-09-23）
			//    为什么排这么前：引擎没跑 = 通知 / 闸门 / 看门狗 / ctx-guard / 接力**全链停摆**，
			//    此时下面几卡的数据可能都是"上次运行时的残留快照"。判据与日报段同源
			//    （state.health.tickd ← butler lib judgeTickdHealth()），面板不自算任何 age。
			const tk = on("tickd") ? (h.tickd ?? null) : null;
			if (tk === null) { /* 本 Tab 不呈现该分区（V2-C 分区渲染） */ }
			else if (!tk.ok) {
				grid.appendChild(healthCard("⏱ tickd 调度", "读不到", "h-gray", [
					["状态", tk.error ?? "butler lib 不可用"],
					["数据源", "%TEMP%/dsh-butler-tickd/state.json"]
				]));
			} else {
				const run = tk.running ?? {};
				const down = run.ok !== true;
				const fails = tk.failing ?? [];
				const lags = tk.lagging ?? [];
				const mir = tk.sessionMirror ?? null;
				const mirAlarm = !!(mir && (mir.level === "yellow" || mir.level === "red"));
				const badge = down ? "🔴 未运行"
					: (mirAlarm ? (mir.level === "red" ? "🔴 镜像停摆" : "⚠️ 镜像停摆 " + Number(mir.consecutiveUnreachable ?? 0) + " 轮")
						: (fails.length ? "⚠️ " + fails.length + " 个 job" : "运行中"));
				const cls = down ? "h-red" : ((mirAlarm || fails.length) ? "h-yellow" : "h-green");
				let extra = null;
				if (fails.length || lags.length) {
					extra = el("div", "bp-health-list");
					for (const f of fails.slice(0, 3)) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot " + (f.level === "red" ? "bp-dot-red" : "bp-dot-yellow")));
						row.appendChild(el("span", "nm", String(f.id)));
						row.appendChild(el("span", "vv", String(f.lastStatus ?? "") + (f.failures ? " · " + f.failures + " 次" : "")));
						extra.appendChild(row);
					}
					for (const g of lags.slice(0, 2)) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot bp-dot-yellow"));
						row.appendChild(el("span", "nm", String(g.id)));
						row.appendChild(el("span", "vv", "该跑没跑 · 落后 " + g.lagDays + " 天"));
						extra.appendChild(row);
					}
				}
				const lines = [
					["常驻进程", down ? ("未运行（" + (run.reason ?? "未知") + "）→ 大管家全链停摆") : ("运行中 · PID " + (run.pid ?? "?"))],
					["心跳", tk.lastLoopAt ? fmtAgo(Date.parse(tk.lastLoopAt)) + " · loop " + (tk.loopCount ?? 0) : "从未"],
					["job", (tk.jobCount ?? 0) + " 个 · 正常 " + (tk.healthyCount ?? 0) + (tk.unknownCount ? " · 未运行过 " + tk.unknownCount : "")]
				];
				// 【M5】镜像停摆告警行（四段式全文：现象 / 影响 / 建议动作 / 依据）——
				//   `.bp-health-line .v` 是 `flex:1; word-break:break-all` ⇒ 全文自然换行、不截断。
				if (mirAlarm) lines.push(["⚠️ 镜像停摆", String(mir.reason ?? "")]);
				if (tk.lastStall && tk.lastStall.from) lines.push(["上次停摆", fmtAgo(Date.parse(tk.lastStall.from)) + " → " + fmtAgo(Date.parse(tk.lastStall.to)) + "（" + Math.round(Number(tk.lastStall.gapMs ?? 0) / 60000) + " 分钟）"]);
				if (down) lines.push(["恢复", "node <大管家目录>/butler-tickd.mjs --ensure"]);
				grid.appendChild(healthCard("⏱ tickd 调度", badge, cls, lines, extra));
			}
			// 🤝 交接（P9 H4 · 2026-09-28）：§5.5 可见性铁律 —— 交接新鲜度 / 心跳 / 未推项 / 体积阈值一眼可见。
			//   口径：lastSuccessfulHandoffAt 24h 黄条 / 72h 红条（§5.7）、心跳 90min 陈旧、仓体积超阈（§5.4 R6）。
			//   失败时刻**必须显示实际状态**："显示旧数据比不显示更危险" ⇒ 不可探测时给灰卡 + 原因，绝不显示 0。
			const hnd = on("handoff") ? (h.handoff ?? {}) : null;
			if (hnd === null) { /* 本 Tab 不呈现该分区（V2-C 分区渲染） */ }
			else if (!hnd.ok || hnd.present === false) {
				grid.appendChild(healthCard("🤝 交接", hnd.present === false ? "无交接单" : "不可探测", "h-gray", [
					["原因", hnd.reason || (hnd.present === false ? "交接从未跑过 / 交接单已被清理" : "采集失败")],
					["路径", "状态目录下（随迁移模式变化）"]
				]));
			} else {
				const hf = hnd.facts ?? {};
				const rb = hf.redBar ?? [];
				const mbOf = (n) => (Number.isFinite(Number(n)) ? (Number(n) / 1048576).toFixed(1) + "MB" : "?");
				const badge = hf.running ? "进行中" : (rb.length ? "⚠️ " + rb.length + " 项" : (hf.unpushedCount ? "待处理 " + hf.unpushedCount : "正常"));
				const cls = hf.running ? "h-yellow" : (rb.length ? "h-red" : (hf.unpushedCount ? "h-yellow" : "h-green"));
				const safeAgo = (v) => {
					const t = v ? Date.parse(v) : NaN;
					return Number.isFinite(t) ? fmtAgo(t) : "—";
				};
				const asOfTxt = hf.asOf ? (safeAgo(hf.asOf) + " · " + (hf.result ?? "?")) : "—";
				const hbTxt = hf.lastHeartbeatAt ? (safeAgo(hf.lastHeartbeatAt) + (hf.heartbeatStale ? " · 陈旧 >90min" : "")) : "—";
				const volTxt = (hf.volumes ?? []).map((v) => (v.repo ?? "?") + " " + mbOf(v.sizeBytes) + (v.overThreshold ? "／超阈 " + mbOf(v.thresholdBytes) : "")).join(" · ");
				let extra = null;
				if (rb.length) {
					extra = el("div", "bp-health-list");
					for (const t of rb.slice(0, 4)) extra.appendChild(el("div", "bp-health-item", String(t)));
					if (rb.length > 4) extra.appendChild(el("div", "bp-health-more", "…还有 " + (rb.length - 4) + " 项"));
				}
				grid.appendChild(healthCard("🤝 交接", badge, cls, [
					["上次完整交接", asOfTxt],
					["心跳", hbTxt],
					["未推项", (hf.unpushedCount ?? 0) + " 项（落地跳过 " + (hf.skippedCount ?? 0) + " · 需裁决 " + (hf.skippedNeedsHuman ?? 0) + "）"],
					["告警", (hf.alerts ?? 0) + " 条（🔴 " + (hf.redAlerts ?? 0) + "）"],
					["体积 vs 阈值", volTxt || "—"]
				], extra));
			}
			const a = on("archive") ? (h.archive ?? {}) : null;
			if (a === null) { /* 分区外（V2-C） */ }
			else if (!a.ok) {
				grid.appendChild(healthCard("🗂 会话自动归档", "读不到", "h-gray", [
					["状态", "状态文件缺失或不可读"],
					["路径", "~/.dsh/_archived-sessions/.auto-archive.json"]
				]));
			} else {
				const last = a.last ?? {};
				const badge = !a.enabled ? "已停用" : (a.dryRun ? "试跑中" : "运行中");
				const cls = !a.enabled ? "h-gray" : (a.dryRun ? "h-yellow" : "h-green");
				grid.appendChild(healthCard("🗂 会话自动归档", badge, cls, [
					["上次运行", a.lastRunAt ? fmtAgo(a.lastRunAt) + (last.dryRun ? "（试跑）" : "（真归档）") : "还没跑过"],
					["上次结果", last.batch ? "归档 " + last.archived + " · 候选 " + last.candidates + " · 跳过 " + last.skipped : "—"],
					["扫描范围", last.scanned != null ? last.scanned + " 个会话（阈值 " + (a.hours ?? "?") + "h，每 " + (a.intervalHours ?? "?") + "h 一轮）" : "—"],
					["累计归档", (a.archivedSessions ?? 0) + " 个会话 · " + (a.batchesTotal ?? 0) + " 批次"],
					["上次错误", (last.errors ?? 0) > 0 ? last.errors + " 条" : "无"]
				]));
			}
			// ② 升级体检（生态面板 v0.2.0 第⑤类分组）
			const u = on("upgrades") ? (h.upgrades ?? {}) : null;
			if (u === null) { /* 分区外（V2-C）：升级体检明细只在「资产」Tab */ }
			else if (!u.ok) {
				grid.appendChild(healthCard("⬆️ 升级体检", "不可用", "h-gray", [
					["原因", u.error ?? "生态面板未响应"],
					["缓存时间", u.cacheAt ? fmtAgo(u.cacheAt) : "无"]
				]));
			} else {
				const sum = u.summary ?? {};
				const red = sum.red ?? 0;
				const yellow = sum.yellow ?? 0;
				const badge = red > 0 ? "有 🔴 " + red : (yellow > 0 ? "有 🟡 " + yellow : "全绿");
				const cls = red > 0 ? "h-red" : (yellow > 0 ? "h-yellow" : "h-green");
				const pend = u.pending ?? [];
				let extra = null;
				if (pend.length > 0) {
					extra = el("div", "bp-health-list");
					for (const p of pend.slice(0, 4)) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot " + (p.status === "red" ? "bp-dot-red" : "bp-dot-yellow")));
						row.appendChild(el("span", "nm", p.name));
						const ver = (p.local || "?") + " → " + (p.latest || p.latestTag || "?");
						row.appendChild(el("span", "vv", ver + (p.label ? " · " + p.label : "")));
						extra.appendChild(row);
					}
					const total = u.pendingTotal ?? pend.length;
					if (total > 4) extra.appendChild(el("div", "bp-health-more", "…还有 " + (total - 4) + " 项，完整清单见「生态面板 → 升级体检」"));
					// 【P1】升级项 L0 预检（方案 §4 P1 细则③）：只读符号审计 ⇒ 全程零风险，
					//   但**仍需预览确认**（统一闸门没有"免预览"通路）。
					const preActs = el("div", "bp-acts");
					preActs.appendChild(actionBtn("预检（只读 L0）", "upgrade-precheck", () => ({}), bus, {
						title: "对 🟡/🔴 待升级项跑只读 L0 符号审计（npm pack 到盘外 canary，不碰生产 profile），报告落 docs\\升级预检报告-<日期>.md"
					}));
					extra.appendChild(preActs);
				}
				grid.appendChild(healthCard("⬆️ 升级体检", badge, cls, [
					["待升级", "🔴 " + red + " · 🟡 " + yellow + " · 🟢 " + (sum.green ?? 0) + "（共 " + (sum.total ?? 0) + " 项）"],
					["体检时间", u.cacheAt ? fmtAgo(u.cacheAt) + "（" + (u.cacheSource ?? "?") + "）" : "—"]
				], extra));
			}
			// ③ 重启协调器（卡 [1] P0）：心跳异常 = 计划任务被停/被拦（验收 6）
			const rs = on("restart") ? (h.restart ?? {}) : null;
			if (rs === null) { /* 分区外（V2-C）：重启协调器只在「管家」Tab */ }
			else if (!rs.ok) {
				grid.appendChild(healthCard("🔁 重启协调器", "读不到", "h-gray", [
					["状态", rs.error ?? "状态文件不可用"],
					["路径", "状态目录下（随迁移模式变化）"]
				]));
			} else {
				const hb = rs.heartbeat ?? {};
				const q = rs.queue;
				const badge = hb.stale ? "心跳异常" : (q ? "排队中" : "正常");
				const cls = hb.stale ? "h-red" : (q ? "h-yellow" : "h-green");
				let extra = null;
				if (q && (q.active ?? []).length > 0) {
					extra = el("div", "bp-health-list");
					for (const a of q.active.slice(0, 3)) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot bp-dot-yellow"));
						row.appendChild(el("span", "nm", a.title || shortId(a.sessionId)));
						row.appendChild(el("span", "vv", a.tail ?? "执行中"));
						extra.appendChild(row);
					}
				}
				grid.appendChild(healthCard("🔁 重启协调器", badge, cls, [
					["心跳", hb.at ? Math.round((hb.ageMs ?? 0) / 1000) + "s 前（pid " + (hb.pid ?? "?") + "）" : "从未心跳"],
					["排队", q ? "等 " + q.activeCount + " 个会话 · 已等 " + Math.round(q.waitingMs / 60000) + " 分钟" : "无"],
					["维护窗口", rs.maintenance ? "重启中（剩 " + Math.round(rs.maintenance.remainingMs / 60000) + " 分钟）" : "无"],
					["最近批次", rs.lastBatch ? fmtAgo(rs.lastBatch.finishedAt) + " · 打断 " + rs.lastBatch.interrupted + " · 通知 " + rs.lastBatch.notified : "还没执行过"]
				], extra));
			}
			// ④ P6 会望风（卡 [7]）：外部信号（模型清单 / 状态页 / 公告 diff，只读 0 token）
			const ex = on("external") ? (h.external ?? {}) : null;
			if (ex === null) { /* 分区外（V2-C）：P6 外部信号明细只在「管家」Tab */ }
			else if (!ex.ok) {
				grid.appendChild(healthCard("🌐 外部信号（P6）", "读不到", "h-gray", [
					["状态", ex.reason ?? "状态文件不可用"],
					["路径", "~/.dsh/butler-external-state.json"]
				]));
			} else {
				const items = ex.items ?? [];
				const failing = ex.failing ?? [];
				const badge = failing.length ? "源失败" : (ex.reds > 0 ? "🔴 " + ex.reds : (items.length ? "🟡 " + items.length : "正常"));
				const cls = failing.length || ex.reds > 0 ? "h-red" : (items.length ? "h-yellow" : "h-green");
				const extra = el("div", "bp-health-list");
				if (items.length === 0) {
					extra.appendChild(el("div", "bp-health-item", "今日外部源无变化"));
				} else {
					for (const it of items.slice(0, 3)) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot " + (it.level === "red" ? "bp-dot-red" : "bp-dot-yellow")));
						row.appendChild(el("span", "nm", it.title || it.id));
						row.appendChild(el("span", "vv", String(it.detail ?? "").slice(0, 60)));
						extra.appendChild(row);
					}
				}
				for (const f of failing.slice(0, 2)) {
					const row = el("div", "bp-health-item");
					row.appendChild(el("span", "dot bp-dot-red"));
					row.appendChild(el("span", "nm", f.id));
					row.appendChild(el("span", "vv", "连续失败 " + f.failCount + " 次"));
					extra.appendChild(row);
				}
				grid.appendChild(healthCard("🌐 外部信号（P6）", badge, cls, [
					["源", (ex.enabledCount ?? 0) + "/" + (ex.sourceCount ?? 0) + " 启用 · 上次扫描 " + (ex.lastTickAt ? fmtAgo(Date.parse(ex.lastTickAt)) : "从未")],
					["今日信号", items.length ? "🔴 " + ex.reds + " / 🟡 " + ex.yellows : "无变化"],
					["降噪", (ex.muted ?? []).length ? (ex.muted.length + " 源已自动降噪（只存档）") : "无"],
					["抑制", (ex.suppressed ?? 0) ? (ex.suppressed + " 次变化被 24h 门抑制") : "无"]
				], extra));
			}
			// ⑤ P8 会收纳（卡 [10]，2026-09-10）：收纳审计只读卡（9 检查点口径）
			const td = on("tidy") ? (h.tidy ?? {}) : null;
			if (td === null) { /* 分区外（V2-C）：P8 产出与收纳只在「资产」Tab */ }
			else if (!td.ok) {
				grid.appendChild(healthCard("🗂 收纳", "读不到", "h-gray", [
					["状态", "状态文件缺失或采集器尚未跑过"],
					["路径", "状态目录下（随迁移模式变化）"]
				]));
			} else if (!td.ranAt) {
				grid.appendChild(healthCard("🗂 收纳", "未跑过", "h-gray", [
					["状态", "采集器已登记，但还没有一轮审计结果"],
					["路径", "状态目录下（随迁移模式变化）"]
				]));
			} else {
				const sm = td.summary ?? {};
				const blk = sm.block ?? 0;
				const wrn = sm.warn ?? 0;
				const badge = blk > 0 ? "⛔ " + blk : (wrn > 0 ? "🟡 " + wrn : "正常");
				const cls = blk > 0 ? "h-red" : (wrn > 0 ? "h-yellow" : "h-green");
				const tmpS = td.tmp ?? {};
				const arS = td.archive ?? {};
				const gt = td.gate ?? {};
				const p2 = gt.p2Events ?? null;
				const lines = [
					["上次审计", td.ranAt ? fmtAgo(td.ranAt) + (td.durationMs != null ? "（" + td.durationMs + "ms）" : "") : "还没跑过"],
					["审计口径", "检查点 " + (td.checkpoints ?? 9) + " · 产出 " + (td.produced ?? 0) + " 行（⛔" + blk + " 🟡" + wrn + " ✅" + (sm.ok ?? 0) + "）"],
					["_tmp", tmpS.fileCount != null ? tmpS.fileCount + " 文件 / " + (tmpS.bytes / 1048576).toFixed(1) + "MB（阈值 " + (tmpS.warnFiles ?? 200) + "/" + Math.round((tmpS.warnBytes ?? 0) / 1048576) + "MB）" + (tmpS.overThreshold ? " ⚠ 超限" : "") : "—"],
					["_archive", arS.dirs != null ? arS.dirs + " 目录 + " + (arS.looseFiles ?? 0) + " 散落文件 · 命名采样不合规 " + (arS.noncompliant ?? 0) + "/" + (arS.sampled ?? 0) : "—"],
					["降档态", "phase=" + (gt.phase ?? "?") + " · L2 搬移=" + (gt.l2Allowed ? "放行" : "停" + (gt.reason ? "（" + gt.reason + "）" : ""))],
					["P2 事件", p2 ? (p2.registered ? "已注册" : "未注册（只进报告，保护裸跑样本池）") : "—"]
				];
				let extra = null;
				const badRows = (td.findings ?? []).filter((f) => f.level !== "ok").slice(0, 4);
				if (badRows.length) {
					extra = el("div", "bp-health-list");
					for (const f of badRows) {
						const row = el("div", "bp-health-item");
						row.appendChild(el("span", "dot " + (f.level === "block" ? "bp-dot-red" : "bp-dot-yellow")));
						row.appendChild(el("span", "nm", f.id));
						row.appendChild(el("span", "vv", String(f.message ?? "").slice(0, 60)));
						extra.appendChild(row);
					}
				}
				grid.appendChild(healthCard("🗂 收纳", badge, cls, lines, extra));
			}
			zone.appendChild(grid);
			zone.appendChild(el("div", "bp-note", "数据来源：~/.dsh/upgrade-lock 的升级锁状态（B3 前置，经 butler lib 判读）+ dsh-archive-sessions 的 .auto-archive.json（自动归档）+ 生态面板 /state 的升级体检（缓存命中，不触发 npm 查询）+ butler-restart-state.json 的协调器心跳 + butler-external-state.json 的 P6 外部信号 + butler-tidy-state.json 的 P8 收纳审计（9 检查点口径）。只读展示，本面板不执行归档、升级、外部采集，也不搬移/删除任何文件。" + (sections === null ? "" : "（本区为 V2-C 分区渲染：这个 Tab 只呈现它负责的那几块，全量明细在「资产」/「管家」Tab。）")));
			return zone;
		}
		// 重启统筹（卡 [1] P0）：排队重启 / 立即强制重启 + 排队状态（等 N 个 / 已等 X 分钟）
		function buildRestart(rs) {
			const zone = el("div");
			zone.appendChild(groupTitle("🔁 重启统筹"));
			const r = rs ?? {};
			if (!r.ok) {
				zone.appendChild(el("div", "bp-note", "协调器状态读不到：" + (r.error ?? "未知") + "。桌面「DSH 重启.cmd」仍可立即硬重启（GUI 卡死急救通道）。"));
				return zone;
			}
			const hb = r.heartbeat ?? {};
			const q = r.queue;
			const card = el("div", "bp-health-card");
			const head = el("div", "bp-health-head");
			head.appendChild(el("span", "bp-health-title", "多会话并行下的重启闸门"));
			head.appendChild(UI.badge({ text: hb.stale ? "心跳异常" : (q ? "排队中" : "空闲"), tone: hb.stale ? "h-red" : (q ? "h-yellow" : "h-green"), variant: "soft" }));
			card.appendChild(head);
			const line = (k, v) => {
				const row = el("div", "bp-health-line");
				row.appendChild(el("span", "k", k));
				row.appendChild(el("span", "v", String(v)));
				card.appendChild(row);
			};
			line("协调器", hb.at ? "心跳 " + Math.round((hb.ageMs ?? 0) / 1000) + "s 前（pid " + (hb.pid ?? "?") + "）" : "从未心跳——计划任务 DSH-Butler-RestartTick 可能被停/被拦");
			line("排队", q ? "等 " + q.activeCount + " 个活跃会话 · 已等 " + Math.round(q.waitingMs / 60000) + " 分钟" + (q.inFallbackWindow ? "（兜底窗口）" : "") : "无排队请求");
			// 【G33·加急档·A3】档位 + 排队**分两类**（方案 §3.7「为什么还在等必须一眼可见」）：
			//   ① 卡执行会话 = 不可打断（打断 ⇒ 假结算 review，要人工 reject→run 补做）；
			//   ② 普通会话 = 可被**加急档**打断（重启后照旧收「尾巴停在 X」）。
			//   另显示三个"敢不敢执行"的可见性项：卡索引退化（fail-safe ⇒ 一律排队）/ 软保护三态 / 上次二次校验放弃原因。
			if (q) {
				const tierLabel = (t) => (t === "urgent" ? "加急" : (t === "force" ? "强制" : "常规"));
				line("档位", tierLabel(q.tier) + (q.escalated ? "（排队超时自动升档）" : "")
					+ (q.tierRequested && q.tierRequested !== q.tier ? " · 请求档 " + tierLabel(q.tierRequested) : ""));
				line("排队明细", "等 " + (q.cardActiveCount ?? 0) + " 个卡执行会话（不可打断）"
					+ " · 等 " + (q.softActiveCount ?? 0) + " 个普通会话（可加急打断）");
				const who = (list) => (list ?? []).slice(0, 3).map((x) => (String(x?.title ?? "").trim() || String(x?.sessionId ?? "").slice(0, 16)) + (x?.state ? "[" + x.state + "]" : "")).join(" / ");
				if ((q.cardActive ?? []).length) line("　卡执行会话", who(q.cardActive) + ((q.cardActive ?? []).length > 3 ? " …" : ""));
				if ((q.softActive ?? []).length) line("　普通会话", who(q.softActive) + ((q.softActive ?? []).length > 3 ? " …" : ""));
				if (q.cardSessionDegraded === true) line("⚠️ 卡索引", "卡执行会话索引不可用（fail-safe）：所有活跃会话按卡处理 ⇒ 加急档一律退回排队（账本暂不可解析）");
				const sp = q.softProtect ?? null;
				line("软保护", sp === null ? "未知（状态文件未带该字段）"
					: (sp.mode === "unavailable" ? "⚠️ 当前无输入保护（会话日志换代 / 读取失败）⇒ 加急档一律退回排队"
						: (sp.mode === "off" ? "已显式关闭（策略键 urgentProtectUserInputMs 非有限正数）"
							: "开 · 最近有输入的会话 " + (sp.holdCount ?? 0) + " 个（本轮豁免）")));
				if (q.abortedLate) line("上次放弃", "执行前二次校验放弃：" + (q.abortedLate.reason ?? "?") + "（零状态写入、退回排队）");
			}
			// 【G33·加急档·A4·可见性 · 2026-09-29】当日升档额度（只读 · **空态是常态**）：
			//   数据面 = 服务端 `collectRestartHealth().urgentDaily`（lib\urgent-quota.js 读
			//   butler-restart-state.json 顶层 `urgent` 段），**三态文案已在服务端拼好** —— 前端不重算、
			//   不补字、不猜，任何形态都不会渲染出 `?` / `undefined` / `NaN`。
			//   今日一次自动升档都没发生过时该段根本不存在（协调器不写这一键）⇒ 显示"尚未发生"。
			line("⚡ 加急档当日额度", (r.urgentDaily && r.urgentDaily.display)
				? r.urgentDaily.display
				: "额度不可读（面板未收到 urgentDaily 字段）");
			line("维护窗口", r.maintenance ? "重启中（correlationId " + shortId(r.maintenance.correlationId ?? "") + "，剩 " + Math.round(r.maintenance.remainingMs / 60000) + " 分钟）" : "无");
			line("最近批次", r.lastBatch ? fmtAgo(r.lastBatch.finishedAt) + " · 打断 " + r.lastBatch.interrupted + " 个会话 · 通知 " + r.lastBatch.notified + " 个" : "还没执行过重启");
			const btns = el("div", "bp-health-line");
			btns.appendChild(el("span", "k", "操作"));
			const wrap = el("span", "v");
			const queueBtn = el("button", "bp-btn", "排队重启");
			// 【G33·加急档·A3】加急档按钮（方案 §3.7：一个「⚡ 加急」按钮）
			const urgentBtn = el("button", "bp-btn", "⚡ 加急重启");
			urgentBtn.title = "加急档：只等「卡执行会话」（不会打断它们），普通会话会被打断（重启后照旧收「尾巴停在 X」）；最近 120 秒有输入的会话豁免一轮。空闲后 ≤1 分钟执行。";
			queueBtn.title = "写重启请求：等活跃会话收尾（排除本请求发起者）后自动重启，不打断任何人";
			const forceBtn = el("button", "bp-btn", "立即强制重启");
			forceBtn.title = "跳过等待：重启前取快照，重启后通知被打断的会话（含「尾巴停在 X」）";
			const msg = el("span", "bp-note", "");
			msg.style.marginLeft = "8px";
			wrap.appendChild(queueBtn);
			wrap.appendChild(document.createTextNode(" "));
			wrap.appendChild(urgentBtn);
			wrap.appendChild(document.createTextNode(" "));
			wrap.appendChild(forceBtn);
			wrap.appendChild(msg);
			btns.appendChild(wrap);
			card.appendChild(btns);
			const post = async (mode, confirmToken, priority) => {
				queueBtn.disabled = true;
				urgentBtn.disabled = true;
				forceBtn.disabled = true;
				msg.textContent = "提交中…";
				try {
					const body = { mode, reason: mode === "force" ? "面板立即强制重启" : (priority === "urgent" ? "面板加急重启" : "面板排队重启") };
					// 【G33·加急档·A3】档位随请求落盘（`normal` / `urgent`；强制档由 mode 表达）
					if (priority) body.priority = priority;
					// 【①-3 · P-6】force 必须带一次性确认令牌（服务端强校验；无令牌 403 且留审计）
					if (confirmToken) body.confirmToken = confirmToken;
					const out = await apiFetch("/api/dsh-butler/restart", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body)
					});
					const tg = out.notifyTarget ?? {};
					const tgLabel = tg.sessionId
						? ("通知目标：" + (tg.row?.title || tg.sessionId.slice(0, 16)))
						: ("通知目标：无（" + (tg.note ?? tg.source ?? "未认定") + "）");
					msg.textContent = mode === "force"
						? ("✓ 已强制重启（" + tgLabel + "；页面稍后会自动重连）")
						: (priority === "urgent"
							? ("✓ 已加急排队（只等 " + (out.queue?.cardActiveCount ?? out.queue?.activeCount ?? 0) + " 个卡执行会话；普通会话可被打断；" + tgLabel + "）")
							: ("✓ 已排队（等 " + (out.queue?.activeCount ?? 0) + " 个活跃会话；空闲后 ≤1 分钟自动重启；" + tgLabel + "）"));
				} catch (e) {
					msg.textContent = "✗ " + (e?.message ?? e);
				} finally {
					queueBtn.disabled = false;
					urgentBtn.disabled = false;
					forceBtn.disabled = false;
				}
			};
			queueBtn.addEventListener("click", () => post("queue"));
			// 【G33·加急档·A3】加急按钮：先确认（**会打断普通会话**），再带 priority=urgent 提交。
			//   与「排队重启」的差别只在一件事：加急不等普通会话；与「立即强制重启」的差别 = 绝不打断卡执行会话。
			urgentBtn.addEventListener("click", () => {
				if (!window.confirm("⚡ 加急重启？\n\n· 只等【卡执行会话】（不会打断它们）\n· 普通会话会被打断（重启后照旧通知「尾巴停在 X」）\n· 最近 120 秒有输入的会话豁免一轮\n· 仍需等当前在场的卡执行会话结束；空闲后 ≤1 分钟执行\n\n（要连卡一起立刻打断，请用「立即强制重启」。）")) {
					msg.textContent = "已取消（未提交、未重启）";
					return;
				}
				post("queue", undefined, "urgent");
			});
			forceBtn.addEventListener("click", async () => {
				// 【施工卡 ①-3 · P-2②/P-6】force 两步交互（原来是"点一下就 window.confirm 后提交"）：
				//   ① POST {mode:"confirm"} —— 服务端只读取「预计活跃数」并签发**一次性确认令牌**；
				//   ② 确认框**写明数量**（取不到就写"未知"，**绝不显示 0** —— ①包 §3.2 轮五 E4）；
				//   ③ 带 confirmToken 提交（服务端消费令牌；重复提交/过期/不带 = 403）。
				queueBtn.disabled = true;
				urgentBtn.disabled = true;
				forceBtn.disabled = true;
				msg.textContent = "取预计活跃数与确认令牌…";
				let tok = null;
				try {
					tok = await apiFetch("/api/dsh-butler/restart", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ mode: "confirm" })
					});
				} catch (e) {
					msg.textContent = "✗ 取确认令牌失败：" + (e?.message ?? e) + "（未提交、未重启）";
					queueBtn.disabled = false;
					urgentBtn.disabled = false;
					forceBtn.disabled = false;
					return;
				}
				queueBtn.disabled = false;
					urgentBtn.disabled = false;
				forceBtn.disabled = false;
				if (!tok?.token) {
					msg.textContent = "✗ 服务端未签发确认令牌（未提交、未重启）";
					return;
				}
				const nText = tok.activeCountKnown === true
					? ("预计 " + tok.activeCount + " 个活跃会话将被中断")
					: "活跃会话数：**未知**（取数不可用；绝不当作 0 处理）";
				if (!window.confirm("立即强制重启 DSH？\n\n" + nText + "\n（实际中断数以协调器执行时刻为准；两个数口径不同，可能相差 1 —— 正常）\n\n正在跑的回合会被硬杀打断（协调器会在重启后通知它们「尾巴停在 X」）。\nGUI 卡死时请直接用桌面「DSH 重启.cmd」。")) {
					msg.textContent = "已取消（确认令牌作废，未提交、未重启）";
					return;
				}
				post("force", tok.token);
			});
			zone.appendChild(card);
			zone.appendChild(el("div", "bp-note", "排队重启 = 低水位闸门：排除请求发起者后活跃会话为 0 才重启；并发 ≥2 时多个请求合并成一个批次。排队超 30 分钟会提醒拍板；请求 24h 未执行自动作废。桌面「DSH 重启.cmd」保持立即硬重启（急救通道，不排队）。通知目标 = 点按钮时唯一「回合未收尾」的会话；同时有多个会话在跑或没有会话在跑时认定为「无目标」→ 重启完成后不发通知（宁可不发，也不发错）。"));
			// 【G33·加急档·A3】加急档说明（方案 §3.3 / §3.7）：把"加急 vs 强制"的界线写在按钮下面
			zone.appendChild(el("div", "bp-note", "⚡ 加急重启 = 加急档：只等【卡执行会话】（不可打断 —— 打断会让卡假结算成「待验收」，得人工 reject→run 补做），普通会话会被打断并照旧收到「尾巴停在 X」；最近 120 秒有输入的会话豁免一轮。加急档的排队原因（等几个卡 / 等几个普通 / 软保护是否可用）看上面「排队明细」两行。"));
			return zone;
		}
		//#region V2-C 片加载器（进 Tab 才拉 · 同片只发一次 · TTL 内不重发 · 并发串行）
		// 设计依据：卡 V2-C 的【数据拉取】铁律 + 方案 §6.2「Tab 切换才拉数据」。
		//   ① **进 Tab 才拉自己那一片**：首屏只请求 core,metrics,feed（V2-D 三片）；资产/管家/报告 Tab 各自按需拉；
		//   ② **同片只发一次**：同一片在 TTL 内不重发（TTL 与服务端 state-cache 对齐；契约 10 分钟）；
		//   ③ **并发串行**：本机 HTTP/1.1，DSH 单页要占 8 条连接（同 origin 上限约 6）——
		//      分片请求并发 = 与主界面抢连接池（2026-09-11「同 origin 两页假死」先例），故所有片请求
		//      排**一条队列**，绝不并发；
		//   ④ 失败只影响该区（显式"不可探测 + 原因" + 重试），绝不静默、不伪造。
		const SHARD_TTL_MS = {
			core: 30000, health: 30000, feed: 30000, metrics: 30000, audit: 30000,
			assets: 300000, reports: 300000, contract: 600000, cleanup: 300000,
			// 【冲刺600·面板三小修】两片**懒取档**（`?parts=healthdetail` / `?parts=metricsdetail`）：
			//   它们不进任何 Tab 的 TAB_PARTS，只在显式操作（如点「原因全文」）时拉一次 ⇒ 默认 300s。
			//   T7 契约：本表必须覆盖服务端 `SHARD_NAMES` 全集（harness `test-v2c-tabs` 逐片断言）。
			healthdetail: 300000, metricsdetail: 300000,
			// 【2026-10-11 卡 多端线·服务面健康】`service` 片（服务面总览）：进「管家」Tab 才拉，
			//   与 health 片同节奏（都在管家 Tab 里）；判定仍是唯一入口，本处只定 TTL。
			service: 300000
		};
		/** Tab → 该 Tab 需要的片（进这个 Tab 才会发这些请求）。 */
		const TAB_PARTS = {
			tasks: ["cleanup"],
			reports: ["reports"],
			assets: ["assets", "health"],
			steward: ["health", "audit", "reports", "service"]
		};
		/**
		 * 片加载器（纯逻辑，无 DOM/无全局状态 —— 单测可直接抽出断言"发了几次、串不串行"）。
		 * @param {{fetchPart:(name:string)=>Promise<{data:any,bytes:number}>,
		 *          absorb?:(name:string,data:any)=>void,
		 *          ttlOf?:(name:string)=>number,
		 *          now?:()=>number}} opts
		 */
		function createShardLoader(opts) {
			const ttlOf = typeof opts?.ttlOf === "function" ? opts.ttlOf : ((n) => SHARD_TTL_MS[n] ?? 300000);
			const now = typeof opts?.now === "function" ? opts.now : (() => Date.now());
			const cache = new Map();     // name → { at, value, bytes, seeded }
			const inflight = new Map();  // name → Promise（同片在飞合并：并发调用只算一次真实请求）
			const log = [];              // 请求流水：{ name, at, ms, bytes }（自检/面板统计用）
			let chain = Promise.resolve(); // 串行闸门：同一时刻最多一个真实请求在飞
			/** 串行排队（失败不毒化队列）。 */
			const enqueue = (task) => {
				const run = chain.then(task, task);
				chain = run.then(() => void 0, () => void 0);
				return run;
			};
			const isFresh = (name) => {
				const hit = cache.get(name);
				return !!hit && (now() - hit.at) < ttlOf(name);
			};
			/** 首屏已随 core,metrics,feed（V2-D 三片）拿到的片：种子标记（数据已在 state 里，不必再拉）。
			 *  ⚠️ `assets` **不在种子名单里** —— 首屏已不请求它，「资产」Tab 必须真发一次请求。 */
			const seed = (names, at) => {
				for (const n of (names ?? [])) cache.set(n, { at: at ?? now(), value: null, bytes: 0, seeded: true });
			};
			const pull = (name) => {
				const flying = inflight.get(name);
				if (flying) return flying;
				const p = enqueue(async () => {
					const t0 = now();
					const r = await opts.fetchPart(name);
					const rec = { name, at: now(), ms: now() - t0, bytes: r?.bytes ?? 0 };
					cache.set(name, { at: rec.at, value: r?.data ?? null, bytes: rec.bytes });
					log.push(rec);
					if (typeof opts.absorb === "function") opts.absorb(name, r?.data);
					return rec;
				}).finally(() => { inflight.delete(name); });
				inflight.set(name, p);
				return p;
			};
			const missing = (names) => (names ?? []).filter((n) => !isFresh(n));
			/** 逐个 await → 天然串行；失败的片记进 errors，不阻断后面的片。 */
			const need = async (names) => {
				const want = missing(names);
				const pulled = [];
				const errors = [];
				for (const n of want) {
					try { pulled.push(await pull(n)); }
					catch (e) { errors.push({ name: n, error: String(e && e.message ? e.message : e) }); }
				}
				return { pulled, errors, bytes: pulled.reduce((s, x) => s + (x.bytes ?? 0), 0), requested: want };
			};
			return {
				isFresh, missing, need, seed, pull, enqueue,
				stats: () => ({ requests: log.length, bytes: log.reduce((s, x) => s + (x.bytes ?? 0), 0), log: log.slice() }),
				reset: (names) => { for (const n of (names ?? [...cache.keys()])) cache.delete(n); }
			};
		}
		/**
		 * 「管家」Tab 的片名单：**契约片只有点开全文才进名单** —— 127 KB 只在点开时发生一次
		 *（验收口径 R2；TTL 10 分钟见 SHARD_TTL_MS.contract）。
		 */
		function stewardShardNames(contractOpen) {
			return TAB_PARTS.steward.concat(contractOpen ? ["contract"] : []);
		}
		//#endregion

		//#region V2-B 首屏五块（V2-D 瘦身 → 三块：① 今日判断 / ② 待处理 / ③ 健康底栏）+ 六项 v2 指标
		// 设计依据：v2 方案 §3.8（首屏块原创条文）+ 面板 v2 方案 v1.1 修订块（B2 片定义 /
		//   B4 指标口径 / B5 今日判断=规则拼装 + 只读 P2.5 产物）+ V2-D 瘦身拍板（块 3/4 移出首屏，
		//   原「⑤ 健康底栏」顺位改为「③」，2026-09-14 主人要求编号连续）。
		// 三条硬纪律：
		//   ① 探测失败 → "不可探测 + 原因"，**绝不显示假值**（0 ≠ 没有数据，必须分开）
		//   ② 每个 🔴/🟡 可点开看证据（原始片段），不接受只有结论
		//   ③ 写动作（ack / 标误报）走**后端唯一写口**，面板绝不直接写状态文件
		// 长尾块（健康监控/重启统筹/写入审计/模块开关/趋势/契约）**一个节点都不建** ——
		//   它们由 V2-C 卡搬进「资产」「管家」两个新 Tab；块 3/4 的明细由 V2-D 归到「资产」「变更」Tab。
		//#endregion
		function pctText(v) {
			return (typeof v === "number" && isFinite(v)) ? (v * 100).toFixed(1) + "%" : "—";
		}
		function msAge(a) {
			const at = typeof a === "number" ? a : (a && typeof a.at === "number" ? a.at : null);
			return at === null ? null : (Date.now() - at);
		}
		function ageText(a) {
			const d = msAge(a);
			if (d === null) return "未标注";
			if (d < 0) return "刚刚";
			const m = Math.floor(d / 60000);
			if (m < 1) return "刚刚";
			if (m < 60) return m + " 分钟前";
			const h = Math.floor(m / 60);
			if (h < 24) return h + " 小时前";
			return (d / 86400000).toFixed(1) + " 天前";
		}
		/** 逐源 asOf → 最旧的一条（块 3 的"数据新鲜度"判据：只报最旧，逐源挂在 title 里）。 */
		function oldestOf(asOfMap) {
			let hit = null;
			for (const [k, v] of Object.entries(asOfMap ?? {})) {
				const d = msAge(v);
				if (d === null) continue;
				if (!hit || d > hit.d) hit = { key: k, d, source: v && v.source };
			}
			return hit;
		}
		/**
		 * 【V2.9 封口①·A 域 · 2026-10-14】「采集周期」取值（取不到就**不判** —— 绝不显假值）：
		 *   ① 该源自带的 `periodMs`（接口将来可逐源给）；② 面板 core 片的 `meta.cache.ttlMs`（现行 300000 = 5 分钟）。
		 */
		function periodOf(st, entry) {
			if (entry && typeof entry.periodMs === "number" && entry.periodMs > 0) return entry.periodMs;
			const ttl = st && st.meta && st.meta.cache && typeof st.meta.cache.ttlMs === "number" ? st.meta.cache.ttlMs : null;
			return (ttl && ttl > 0) ? ttl : null;
		}
		/**
		 * 方案 v2 原文：「超过 **2 × 采集周期** ⇒ 该行**标灰** + 附『数据 N 分钟未更新』」
		 *   ⇒ 本函数是这条判据的**唯一实现点**（逐源算 stale / ageMs / thresholdMs）。
		 */
		function judgeFreshness(asOfMap, st) {
			const out = {};
			for (const [k, v] of Object.entries(asOfMap ?? {})) {
				const ageMs = msAge(v);
				const periodMs = periodOf(st, v);
				const thresholdMs = periodMs ? 2 * periodMs : null;
				out[k] = { ageMs, periodMs, thresholdMs, stale: !!(ageMs !== null && thresholdMs && ageMs > thresholdMs) };
			}
			return out;
		}
		/** 「数据 N 分钟未更新」文案（方案原文措辞；不足 1 分钟按 1 分钟报，不显示 0）。 */
		function staleText(ageMs) {
			const n = Math.max(1, Math.floor(Number(ageMs) / 60000));
			return "数据 " + n + " 分钟未更新";
		}
		function unknownLine(text) {
			return el("div", "bp-note", "⚠ " + text);
		}
		function metricNum(v) { return (v === null || v === undefined || v === false) ? "—" : String(v); }
		/**
		 * 【冲刺600·面板三小修 · 1.3】「不可探测」的**原因全文**（按需懒取，绝不随首屏加载）。
		 *   背景：`metrics` 片硬 ≤ 2048 B（`SHARD_BUDGET_BYTES`），预算保险丝的阶梯降级会把分项
		 *   `reason` 删成 `reasonTrimmed:true`、`errors` 截到 24–48 字、顶层 `reason` 截到 48 字
		 *   ⇒ 面板只能显示"不可探测"，主人看不到**为什么**（1.3 缺陷单原话）。
		 *   处置：本行只画一个可点标题，**点开才**拉 `?parts=metricsdetail`（full 档 = 同一个
		 *   `lib/metrics.mjs#collectMetrics` 唯一入口的完整输出，含 part 级 reason 与 errors 全文）。
		 *   ⚠️ 不改 `available` / `count` 语义：不可探测就是不可探测，这里只补"为什么"。
		 * @param {string} label 点开前的说明文字
		 * @param {(full:any)=>string[]} pick 从 full 档提取要显示的文本行
		 */
		function reasonFullRow(label, pick) {
			const box = el("div", "bp-adv");
			const row = el("div", "bp-adv-item");
			row.appendChild(el("span", "bp-adv-tag", "原因全文"));
			row.appendChild(document.createTextNode(label + "（点击展开；按需拉取 full 档，不随首屏加载）"));
			const body = el("div", "bp-adv-full", "");
			body.style.display = "none";
			box.appendChild(row);
			box.appendChild(body);
			let loaded = null;
			let loading = false;
			const paint = (t) => { body.textContent = ""; body.appendChild(document.createTextNode(t)); };
			row.addEventListener("click", async () => {
				if (body.style.display !== "none") { body.style.display = "none"; row.classList.remove("open"); return; }
				body.style.display = ""; row.classList.add("open");
				if (loaded || loading) return;
				loading = true;
				paint("拉取 full 档…");
				try {
					const d = await apiFetch("/api/dsh-butler/state?parts=metricsdetail");
					loaded = d?.metricsdetail ?? null;
					const lines = pick(loaded ?? {});
					body.textContent = "";
					if (!lines.length) { body.appendChild(document.createTextNode("（full 档也未给出比片内更多的原因）")); return; }
					for (const t of lines) body.appendChild(el("div", "", String(t)));
				} catch (e) {
					paint("拉取失败：" + String(e?.message ?? e) + "（也可直接 GET /api/dsh-butler/state?parts=metricsdetail）");
				} finally { loading = false; }
			});
			return box;
		}

		/**
		 * 六项 v2 指标（口径唯一真相 = lib\metrics.mjs；前端**只呈现、不重算**）。
		 * 每格：数字 + 说明 + 点击去向；不可得 → "—" 且 title 写明原因（绝不显示 0）。
		 */
		function buildMetrics(metrics, bus) {
			const wrap = el("div", "bp-kpis");
			const items = metrics && typeof metrics === "object" ? (metrics.items ?? {}) : {};
			const defs = [];
			const pend = items.pendingTodo ?? {};
			const auto = items.autoActionsToday ?? {};
			const auto_ = items.autonomy ?? {};
			const asset = items.assetAnomalies ?? {};
			const inflight = items.inflight ?? {};
			const fp = items.falsePositive ?? {};
			const byM = fp.byMachine ?? null;
			// ① 🔴 待我处理（三项**分项相加不去重**：未 ack 红黄 + 待验收卡（双判据）+ 需确认动作）
			{
				const wu = pend.parts?.watchUnacked ?? {};
				const br = pend.parts?.boardReview ?? {};
				const nc = pend.parts?.needConfirm ?? {};
				const redY = (wu.byLevelKnown && wu.byLevel) ? (wu.byLevel.red ?? 0) + (wu.byLevel.yellow ?? 0) : null;
				const num = pend.available === true ? (pend.value ?? pend.knownSum ?? null) : null;
				const extra = pend.available !== true
					? (pend.reason || "指标不可探测")
					: "红黄 " + (redY === null ? String(wu.count ?? "?") + "（分色不可得）" : redY) + " · 待验收 " + (br.count ?? "?") + " · 需确认 " + (nc.count ?? "?");
				defs.push(["🔴 待我处理", metricNum(num), num === null ? "k-red" : (num > 0 ? "k-red" : "k-green"), "pending", extra, pend.partial === true]);
			}
			// ② 🚦 自治档位（L0 档位 + L2 已关模块数 / 总数；区分预期关闭与异常关闭）
			{
				const lv = auto_.l0Level ?? null;
				const num = lv === null ? null : (lv === "normal" ? "正常" : (lv === "degraded" ? "降档" : lv));
				const un = auto_.unexpectedDisabledCount;
				let extra = auto_.l2DisabledCount === null || auto_.l2DisabledCount === undefined
					? "已关模块不可探测"
					: "已关 " + auto_.l2DisabledCount + "/" + (auto_.l2TotalCount ?? "?") + (un ? " · ⚠异常关闭 " + un : "");
				if (auto_.available !== true) extra = auto_.l0Unavailable || "档位不可探测";
				defs.push(["🚦 自治档位", metricNum(num), num === "降档" ? "k-yellow" : "k-cyan", "steward", extra, false]);
			}
			// ③ ⚙️ 今日自动办好（口径 = daily[今日].noQuotaCount；今日无记录 → "尚无"，**不是 0**）
			{
				const hasData = auto.hasData === true;
				const num = auto.available !== true ? null : (hasData ? (auto.noQuotaCount ?? null) : null);
				const qg = auto.quotaGate ?? null;   // 【⑥-2】额度闸视图（used ≡ quotaCount，同一事实）
				// 【⑥-2】片里额度字段是**精简集**（省片预算）：
				//   `available` 缺省视为**可用**（不可用时后端必带 available:false + reason）；
				//   `used` 缺省回落既有 `quotaCount`（同一事实的权威字段）；`reached` 缺省 = 未达上限。
				const qgKnown = Boolean(qg) && qg.available !== false;
				const qgWarn = qgKnown && (qg.reached === true || (typeof qg.degradedToday === "number" && qg.degradedToday > 0));
				const qgUsed = (qg && qg.used !== null && qg.used !== undefined) ? qg.used
					: (auto.quotaCount !== null && auto.quotaCount !== undefined ? auto.quotaCount : null);
				const qgTxt = !qgKnown ? ""
					: (" · 额度 " + (qgUsed === null ? "?" : qgUsed) + "/" + (qg.max === null || qg.max === undefined ? "?" : qg.max)
						+ (qg.reached === true ? " ⚠️已达上限" : "")
						+ (qg.degradedToday === null || qg.degradedToday === undefined ? " · 降级未观测" : (qg.degradedToday > 0 ? " · ⚠️今日降级 " + qg.degradedToday + " 次" : "")));
				const extra = auto.available !== true
					? (auto.reason || auto.display || "不可探测")
					: (hasData ? "今天" : (auto.display || "今日尚无自动动作")) + qgTxt;
				defs.push(["⚙️ 今日自动办好", hasData ? metricNum(num) : (auto.available === true ? "尚无" : "—"), qgWarn ? "k-yellow" : (hasData ? "k-green" : "k-blue"), "steward", extra, !hasData]);
			}
			// ④ 🧩 资产异常（升级体检 + 镜像 + 补丁漂移 + 解耦违规；分项相加不去重）
			{
				const avail = asset.available === true;
				const num = avail ? (asset.value ?? null) : null;
				const extra = avail
					? ("🔴 " + (asset.red ?? 0) + " / 🟡 " + (asset.yellow ?? 0) + (asset.partial ? " · " + (asset.unavailableParts ?? []).length + " 项未就绪" : ""))
					: (asset.reason || "资产源不可探测");
				defs.push(["🧩 资产异常", metricNum(num), !avail ? "k-yellow" : (num > 0 ? "k-red" : "k-green"), "assets", extra, !avail]);
			}
			// ⑤ 📥 在途任务（保留现口径：进行中 + 待办）
			{
				const avail = inflight.available === true;
				const num = avail ? (inflight.value ?? null) : null;
				const extra = avail ? ("进行中 " + (inflight.running ?? "?") + " · 待办 " + (inflight.todo ?? "?")) : (inflight.reason || "看板不可探测");
				defs.push(["📥 在途任务", metricNum(num), "k-purple", "tasks", extra, !avail]);
			}
			// ⑥ 🎯 误报率（三格：按机 / 池级 L1·L2 / 明细完整；**达标必带限定词**）
			{
				const cum = byM?.cumulative ?? null;
				const rate = cum && typeof cum.rate === "number" ? cum.rate : null;
				const gate = byM?.gate ?? null;
				const pass = gate && gate.rateOk === true && gate.sampleOk === true && gate.suspectOk === true;
				const poolKnown = fp.poolL1?.available === true || fp.poolL2?.available === true;
				const extra = rate === null
					? (byM ? "样本不可得" : "按机数据不可探测")
					: ("按机 " + (pass ? "达标" : "未达标") + " · 累计 " + (cum.total ?? "?") + (poolKnown ? "" : " · 池级不可探测"));
				defs.push(["🎯 误报率", rate === null ? "—" : pctText(rate), rate === null ? "k-yellow" : (pass ? "k-green" : "k-red"), "steward", extra, rate === null]);
			}
			for (const [label, num, cls, tab, extra, warn] of defs) {
				const card = UI.kpi({ label: label, value: num, tone: cls, hint: extra });
				card.classList.add("clickable");
				card.title = extra + "｜点击看详情（" + tabName(tab) + "）";
				card.addEventListener("click", () => bus?.switchTab?.(tab));
				if (warn) card.style.opacity = "0.92";
				wrap.appendChild(card);
			}
			return wrap;
		}
		//#endregion

		//#region 块 1 今日判断（规则拼装 + 只读日报建议段）
		/** 一句话（规则拼装，不调 LLM）+ 建议前 3 条（来源 = 当日日报「## 💡 建议」段，P2.5 产物）。 */
		function blockVerdict(st, metrics, pending) {
			const box = el("div", "bp-block");
			const head = el("div", "bp-block-head");
			head.appendChild(el("span", "", "① 今日判断"));
			const adv = st?.feed?.advice ?? null;
			head.appendChild(el("span", "right", adv?.ok ? ("建议源：" + (adv.file ?? "日报") + " · " + String(adv.asOf ? new Date(adv.asOf.at).toLocaleTimeString() : "")) : ""));
			box.appendChild(head);

			const v = el("div", "bp-verdict");
			const items = metrics?.items ?? {};
			const pend = items.pendingTodo ?? {};
			const br = pend.parts?.boardReview ?? {};
			const wu = pend.parts?.watchUnacked ?? {};
			const auto = items.autoActionsToday ?? {};
			const total = pend.available === true ? (pend.value ?? pend.knownSum ?? null) : null;
			const redY = (wu.byLevelKnown && wu.byLevel) ? (wu.byLevel.red ?? 0) + (wu.byLevel.yellow ?? 0) : null;
			const seg = (t) => { v.appendChild(document.createTextNode(t)); };
			const strong = (t, cls) => { const s = el("b", cls ? cls : "", String(t)); v.appendChild(s); };
			if (total === null) {
				v.appendChild(el("span", "none", pending
					? "指标采集中…（指标片已移出首屏，加载完自动回填；建议段来自 feed 片，已是实时的）"
					: ("今天要处理的事：不可探测" + (pend.reason ? "（" + String(pend.reason).slice(0, 60) + "）" : "（指标源未就绪）"))));
			} else {
				seg("今天 ");
				strong(total);
				seg(" 件要你处理：");
				if (redY === null) { strong(String(wu.count ?? "?"), "none"); seg(" 件未 ack（分色不可得）"); }
				else { strong(redY, "red"); seg(" 件 🔴/🟡"); }
				seg("、");
				strong(br.count ?? "?", "none");
				seg(br.judgement === "unknown" ? " 张待验收（双判据第二半未判定）" : " 张待验收");
				const nc = pend.parts?.needConfirm?.count ?? 0;
				if (nc > 0) { seg("，另有 "); strong(nc, "none"); seg(" 项需你确认"); }
				seg("；");
				if (auto.available !== true) { seg("自动动作数不可探测"); }
				else if (auto.hasData === true) { seg("另有 "); strong(auto.noQuotaCount ?? 0); seg(" 项自动办好"); }
				else { seg("今日尚无自动动作"); }
				// 【⑥-2】额度闸上首屏：主人一眼看到"吃了几/上限几 / 今天有没有降级"。
				//   不可探测一律不显示（绝不用 0 冒充）；台账不可用 ⇒ 明写"未观测"（⑥ 包 §7.1⑤(a)）。
				{
					const qg = auto.quotaGate ?? null;
					if (qg && qg.available !== false) {
						seg("；额度 ");
						const qgUsed = (qg.used !== null && qg.used !== undefined) ? qg.used
							: (auto.quotaCount !== null && auto.quotaCount !== undefined ? auto.quotaCount : null);
						strong((qgUsed === null ? "?" : qgUsed) + "/" + (qg.max === null || qg.max === undefined ? "?" : qg.max));
						if (qg.reached === true) seg(" ⚠️已达上限（其后动作只排队）");
						if (qg.degradedToday === null || qg.degradedToday === undefined) seg("；降级未观测（台账不可用，不判 0）");
						else if (qg.degradedToday > 0) { seg("；⚠️今日降级 "); strong(qg.degradedToday, "red"); seg(" 次"); }
					}
				}
			}
			box.appendChild(v);
			if (pend.partial === true && (pend.unavailableParts ?? []).length) {
				box.appendChild(el("div", "bp-note", "（分项未就绪：" + (pend.unavailableParts ?? []).join("、") + " —— 显示的是已知和，不是完整值）"));
			}
			// 【冲刺600·面板三小修 · 1.3】不可探测时**必须能查到为什么**：
			//   片内 reason 被 2 KB 预算裁掉（`reasonTrimmed:true`）/ 顶层 reason 截到 48 字 ⇒ 给按需全文入口。
			{
				const parts = pend.parts ?? {};
				const anyUnavailablePart = Object.keys(parts).some((k) => parts[k] && (parts[k].available === false || parts[k].reasonTrimmed === true));
				if (!pending && (pend.available !== true || pend.partial === true || anyUnavailablePart)) {
					box.appendChild(reasonFullRow("待我处理 · 分项不可探测", (full) => {
						const m = full?.items?.pendingTodo ?? {};
						const out = [];
						if (m.reason) out.push("汇总：" + m.reason);
						for (const [k, v] of Object.entries(m.parts ?? {})) {
							if (v?.reason) out.push(k + "：" + v.reason);
							else if (v?.reasonTrimmed) out.push(k + "：（片内原因被预算裁掉，full 档亦未给出更多）");
						}
						for (const e of full?.errors ?? []) out.push("错误：" + e);
						return out;
					}));
				}
			}

			// 建议前 3 条：**只解析已生成的日报内容，绝不调用 generateAdvice / callZhipu**（B5）
			const advBox = el("div", "bp-adv");
			if (!adv) {
				advBox.appendChild(el("div", "bp-note", "建议：本次请求未带 feed 片（无数据源）——无法读取日报建议段。"));
			} else if (!adv.ok) {
				advBox.appendChild(el("div", "bp-note", "建议：今日未生成（" + (adv.reason ?? "日报建议段不可得") + "）"));
			} else {
				advBox.appendChild(el("div", "bp-note", "建议（日报 P2.5 产出，前 " + (adv.items ?? []).length + "/" + (adv.total ?? "?") + " 条 · 只读呈现）"));
				for (const it of adv.items ?? []) {
					// 【V31-018 卡 B · 顺手修 §7.3】旧实现在每个条目后挂一个隐藏的 bp-adv-full 空壳，
					//   点条目只 toggle 一个 class、内容永远是"（点击条目可折叠/展开；本条已完整显示）"这句废话。
					//   建议条目本身就是全文 ⇒ 不再做成可折叠（真需要折的由 row({expandable,detail}) 承载）。
					const kids = [];
					if (it.label) kids.push(el("span", "bp-adv-tag", it.label));
					kids.push(document.createTextNode(String(it.text ?? "")));
					advBox.appendChild(UI.row({ flat: true, cls: "bp-adv-item", children: kids }).root);
				}
				if (adv.note) advBox.appendChild(el("div", "bp-note", adv.note));
			}
			box.appendChild(advBox);
			return box;
		}
		//#endregion

		//#region 块 2 待处理（每条可点开证据 + ack / 标误报走唯一写口）
		// eventId（2026-09-14）：按**事件 id** ack —— 一次清光同 id 的全部延迟副本。
		//   事件超 4h 未确认会「升级重推」，副本各自带 token 攒在 deferred 里，而列表同一 id 只显示
		//   一条 ⇒ 只按 token ack 就是"点一条、冒一条"（实测主人连点 2 次还没到底）。token 仍一并带上，
		//   供后端审计与旧行为兼容。
		function pendingActions(row, kind, token, bus, onDone, eventId) {
			const acts = el("div", "bp-acts");
			const ev = el("button", "bp-act", "证据");
			acts.appendChild(ev);
			const ack = el("button", "bp-act primary", "知道了");
			acts.appendChild(ack);
			const fp = el("button", "bp-act warn", "标误报");
			acts.appendChild(fp);
			row.appendChild(acts);
			const evBox = el("div", "bp-ev");
			evBox.style.display = "none";
			row.appendChild(evBox);
			const fpBox = el("div", "bp-ev");
			fpBox.style.display = "none";
			const fpConfirm = el("button", "bp-act warn", "确认标误报（写口：butler-watch CLI --false-positive，带 p2-ack 审计）");
			fpBox.appendChild(fpConfirm);
			fpBox.appendChild(el("div", "bp-note", "影响项：该事件计入误报统计（裸跑期 KPI 的分子）；撤销方式：CLI `--unmute <token>` 或编辑 butler-falsepositives.jsonl。"));
			row.appendChild(fpBox);
			ev.addEventListener("click", () => {
				evBox.style.display = evBox.style.display === "none" ? "" : "none";
			});
			const post = async (url, body) => {
				return apiFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			};
			ack.addEventListener("click", async () => {
				ack.disabled = true; ack.textContent = "…";
				try {
					await post("/api/dsh-butler/ack", eventId ? { token, id: eventId } : { token });
					ack.textContent = "已 ack"; ack.classList.remove("primary");
					onDone?.();
				} catch (e) {
					ack.disabled = false; ack.textContent = "知道了";
					ack.title = "失败：" + String(e?.message ?? e);
				}
			});
			fp.addEventListener("click", () => {
				const open = fpBox.style.display !== "none";
				fpBox.style.display = open ? "none" : "";
			});
			fpConfirm.addEventListener("click", async () => {
				fpConfirm.disabled = true; fpConfirm.textContent = "提交中…";
				try {
					await post("/api/dsh-butler/false-positive", { token, note: "" });
					fpConfirm.textContent = "已标记误报";
					onDone?.();
				} catch (e) {
					fpConfirm.disabled = false; fpConfirm.textContent = "确认标误报";
					fpConfirm.title = "失败：" + String(e?.message ?? e);
				}
			});
			return { evBox, fpBox, ack, fp };
		}

		function blockPending(st, metrics, bus, pending) {
			const box = el("div", "bp-block");
			const head = el("div", "bp-block-head");
			head.appendChild(el("span", "", "② 待处理"));
			const watch = st?.watch ?? null;
			const board = st?.board ?? null;
			// 队列告警（遗留① 面板红标通道 · 2026-09-17）：来源 = core 片 queue.alerts
			//   （口径真源 queue-watch.mjs#alertsOf，与 CLI --status/--alerts 同一份输出；面板不复制判据）。
			//   ⚠️ undefined 与 null 语义不同：旧片/未请求 core 时 st.queue === undefined → 整段不渲染；
			//   片已返回但 ok=false（台账缺失/库版本旧）→ 显式显示不可探测 + 原因（绝不静默当"无告警"）。
			const queue = st?.queue;
			const queueItems = (queue && queue.ok && Array.isArray(queue.items)) ? queue.items : [];
			const nc = metrics?.items?.pendingTodo?.parts?.needConfirm ?? null;
			const nWatch = watch?.ok ? (watch.count ?? (watch.items ?? []).length) : null;
			const nBoard = board?.ok ? (board.settledCount ?? board.count ?? null) : null;
			const nQueue = (queue && queue.ok) ? (queue.count ?? queueItems.length) : null;
			const total = (nWatch ?? 0) + (nBoard ?? 0) + (nc?.count ?? 0) + (nQueue ?? 0);
			head.appendChild(el("span", "cnt", total > 0 ? "共 " + total + " 项" : ""));
			head.appendChild(el("span", "right", "写动作均走后端唯一写口（面板不直接写状态文件）"));
			box.appendChild(head);
			let rendered = 0;
			// 【V3-A2】指标片已移出首屏：本块里只有「需确认动作」计数依赖它 —— 明写延后，其余（未 ack / 待验收 / 队列告警）全来自 core 片，已是实时的。
			if (pending) box.appendChild(el("div", "bp-note", "⏳ 「需确认动作」计数在指标片里（该片已移出首屏，加载完自动回填）；下面的事件 / 待验收卡 / 队列告警来自 core 片，已是实时的。"));

			// ① 未 ack 的 🔴/🟡（唯一权威源 = butler lib#listUnacked，由服务端 core 片给出）
			if (!watch) {
				box.appendChild(unknownLine("watch 片未随本次请求返回（无数据源）"));
			} else if (!watch.ok) {
				box.appendChild(unknownLine("未 ack 事件不可探测：" + (watch.reason ?? "原因未知")));
			} else if ((watch.items ?? []).length === 0) {
				if ((watch.count ?? 0) > 0) box.appendChild(unknownLine("有 " + watch.count + " 条未 ack，但明细未随片返回（超出上限）"));
			} else {
				for (const it of watch.items ?? []) {
					const row = el("div", "bp-pend");
					const top = el("div", "bp-pend-top");
					const lv = String(it.level ?? "").toLowerCase();
					const lvCls = lv.includes("red") || lv.includes("🔴") ? "red" : (lv.includes("yellow") || lv.includes("🟡") ? "yellow" : "gray");
					const lvText = lvCls === "red" ? "🔴" : (lvCls === "yellow" ? "🟡" : "⚪");
					top.appendChild(UI.badge({ text: lvText, tone: lvCls, variant: "outline" }));
					const main = el("div", "bp-main");
					// 标题兜底（2026-09-14）：`it.title ?? "(无标题)"` 挡不住**空串** —— 老状态记录没有
					//   title 字段时渲染成一行空白，主人只看到英文 id 完全看不懂。空串一律落到"无标题"。
					main.appendChild(el("div", "bp-name", (String(it.title ?? "").trim() || "(无标题)") + (it.dup ? "（重复 " + it.dup + " 次）" : "")));
					// 人话详情（服务端 listUnacked 的 detail / lastValue 兜底值）
					if (it.detail) main.appendChild(el("div", "bp-meta bp-detail", String(it.detail)));
					main.appendChild(el("div", "bp-meta", "未 ack · " + (it.at ? new Date(it.at).toLocaleString() : "时间未知") + " · id " + String(it.id ?? "")));
					top.appendChild(main);
					row.appendChild(top);
					const parts = pendingActions(row, "watch", String(it.ackToken ?? it.id ?? ""), bus, () => bus?.refreshSoon?.(), String(it.id ?? ""));
					parts.evBox.textContent = [
						"来源：P2 观测状态（唯一权威源 lib\\watch-policy.mjs#listUnacked）",
						"事件 id：" + String(it.id ?? "(无)"),
						"ack token：" + String(it.ackToken ?? "(无)"),
						"级别：" + String(it.level ?? "(事件无 level 字段 → 分色不可得)"),
						"时间：" + (it.at ? new Date(it.at).toISOString() : "未知"),
						"标题：" + String(it.title ?? ""),
						"详情：" + String(it.detail ?? "(无)"),
						"（写口：POST /api/dsh-butler/ack → spawn butler-watch CLI --ack <事件 id>，一次清光同 id 全部延迟副本；原子写 + p2-ack 审计）",
					].join("\n");
					box.appendChild(row);
					rendered++;
				}
			}

			// ② 待验收卡（Host API + **双判据**：卡在 review 列 ∧ 执行会话已真结束）
			if (!board) {
				box.appendChild(unknownLine("board 片未随本次请求返回（无数据源）"));
			} else if (!board.ok) {
				box.appendChild(unknownLine("待验收卡不可探测：" + (board.reason ?? "原因未知")));
			} else {
				if (board.aliveKnown === false) {
					box.appendChild(unknownLine("双判据第二半未判定（session.list 不可得）——以下卡**不按「已结束」处理**：" + (board.reason ?? "")));
				}
				for (const c of board.items ?? []) {
					const settled = c.settled === true;
					const alive = c.execAlive === true;
					const row = el("div", "bp-pend");
					const top = el("div", "bp-pend-top");
					top.appendChild(UI.badge({ text: settled ? "🧾" : "⏳", tone: settled ? "yellow" : "gray", variant: "outline" }));
					const main = el("div", "bp-main");
					main.appendChild(el("div", "bp-name", String(c.title ?? "(无标题)")));
					main.appendChild(el("div", "bp-meta",
						(settled ? "待验收（执行会话已结束）" : (alive ? "疑似假结算：执行会话仍在跑" : "执行状态未判定"))
						+ " · 卡 " + String(c.id ?? "") + (c.updatedAt ? " · " + new Date(c.updatedAt).toLocaleString() : "")));
					top.appendChild(main);
					row.appendChild(top);
					const acts = el("div", "bp-acts");
					const ev = el("button", "bp-act", "证据");
					acts.appendChild(ev);
					const toBoard = el("button", "bp-act", "去看板");
					toBoard.addEventListener("click", () => bus?.goBoard?.());
					acts.appendChild(toBoard);
					row.appendChild(acts);
					const evBox = el("div", "bp-ev");
					evBox.style.display = "none";
					evBox.textContent = [
						"来源：Host API /api/task-board/state 的 review 列（唯一权威方 = 看板账本）",
						"卡 id：" + String(c.id ?? "(无)"),
						"标题：" + String(c.title ?? ""),
						"序号：" + String(c.seq ?? "?"),
						"更新时间：" + (c.updatedAt ? new Date(c.updatedAt).toISOString() : "未知"),
						"双判据：卡 status=review" + (settled ? " ∧ 执行会话已结束 → 可验收" : (alive ? " ∧ 执行会话仍 running → **假结算**（别直接 confirm）" : " ∧ 执行会话状态未判定")),
						"验收口径：见 docs\\看板卡「待验收」双判据；confirm/reject 走 Host API 或看板 GUI",
					].join("\n");
					ev.addEventListener("click", () => { evBox.style.display = evBox.style.display === "none" ? "" : "none"; });
					row.appendChild(evBox);
					box.appendChild(row);
					rendered++;
				}
			}

			// ③ 队列推进告警（遗留① 面板红标通道 · 2026-09-17）——
			//   队列的**失败态**：注入失败 / 四门挡下 / 疑似假结算 / 无目标 / 升级仍滞留。
			//   判据真源 = 队列表 `queue-watch.mjs#alertsOf`（与 CLI --status / --alerts 同一份输出）；
			//   面板只展示、**不写**（消解发生在队列侧：卡离开 review / 目标恢复 / 四门放行 → 下一轮 tick 自动消失）。
			//   因此本段用「证据 + 去看板」两个只读动作，**不接** P2 的 ack 写口。
			if (queue !== undefined) {
				if (!queue || !queue.ok) {
					box.appendChild(unknownLine("队列推进告警不可探测：" + ((queue && queue.reason) || "队列台账缺失或不可读")));
				} else if (queueItems.length === 0) {
					box.appendChild(el("div", "bp-note", "✅ 队列推进无告警（在册 " + (queue.entries ?? "?") + " 张待验收卡均不处于失败态）"));
				} else {
					const zone = el("div", "bp-zoneL3");
					const h = el("div", "bp-block-head");
					h.appendChild(el("span", "", "🚨 队列推进告警"));
					const bl = queue.byLevel ?? {};
					h.appendChild(el("span", "cnt", (queue.count ?? queueItems.length) + " 项（🔴 " + (bl.red ?? 0) + " / 🟡 " + (bl.yellow ?? 0) + "）"));
					zone.appendChild(h);
					zone.appendChild(el("div", "bp-note", "来源：butler-queue 台账 queue-watch.mjs#alertsOf（唯一权威判据；与 CLI --status / --alerts 同源）"));
					for (const a of queueItems) {
						const row = el("div", "bp-pend");
						const top = el("div", "bp-pend-top");
						const isRed = a.level === "red";
						top.appendChild(UI.badge({ text: isRed ? "🔴" : "🟡", tone: isRed ? "red" : "yellow", variant: "outline" }));
						const main = el("div", "bp-main");
						main.appendChild(el("div", "bp-name", (String(a.title ?? "").trim() || "(无标题)") + (a.seq ? "　[" + a.seq + "]" : "")));
						main.appendChild(el("div", "bp-meta bp-detail", (a.label ? a.label + " · " : "") + String(a.detail ?? "")));
						main.appendChild(el("div", "bp-meta", "滞留 " + (a.ageMin ?? "?") + " 分钟 · 目标来源 " + String(a.source ?? "（未评估）")));
						top.appendChild(main);
						row.appendChild(top);
						const acts = el("div", "bp-acts");
						const ev = el("button", "bp-act", "证据");
						acts.appendChild(ev);
						const toBoard = el("button", "bp-act", "去看板");
						toBoard.addEventListener("click", () => bus?.goBoard?.());
						acts.appendChild(toBoard);
						row.appendChild(acts);
						const evBox = el("div", "bp-ev");
						evBox.style.display = "none";
						evBox.textContent = [
							"来源：队列通知台账（状态目录下，只读）",
							"判据：butler lib `queue-watch.mjs#alertsOf`（**面板不复制判据**，与 CLI 同源）",
							"卡 id：" + String(a.taskId ?? "(无)") + "　序号：" + String(a.seq ?? "?") + "　主线：" + String(a.line ?? "(无)"),
							"等级：" + (isRed ? "🔴 需要人到场才能恢复" : "🟡 提醒已投出但卡仍滞留（已升级）"),
							"现象：" + String(a.label ?? "") + " —— " + String(a.detail ?? ""),
							"滞留：" + (a.ageMin ?? "?") + " 分钟　目标来源：" + String(a.source ?? "(未评估)"),
							"上次投递：" + (a.notifiedAt ? new Date(a.notifiedAt).toISOString() : "（无）") + "　升级：" + (a.escalatedAt ? new Date(a.escalatedAt).toISOString() : "（无）"),
							"消解方式：队列侧自动 —— 卡离开待验收 / 目标会话恢复 / 四门放行 → 下一轮 tick（≤1 分钟）自动消失；**无 ack 动作**（队列台账没有 ackToken 语义，不接 P2 写口）",
							"排障：`node <大管家目录>/butler-queue-tick.mjs --alerts`（同一份输出）",
						].join("\n");
						ev.addEventListener("click", () => { evBox.style.display = evBox.style.display === "none" ? "" : "none"; });
						row.appendChild(evBox);
						box.appendChild(row);
						rendered++;
					}
				}
			}

			// ④ 需确认的自动动作（L3 危险动作 → 红区 + 需主人确认；明细在 full 档）
			if (nc && nc.count !== null && nc.count !== undefined) {
				if (nc.count > 0) {
					const zone = el("div", "bp-zoneL3");
					const h = el("div", "bp-block-head");
					h.appendChild(el("span", "", "⛔ L3 危险动作待确认（需主人确认）"));
					h.appendChild(el("span", "cnt", nc.count + " 项"));
					zone.appendChild(h);
					zone.appendChild(el("div", "bp-note", "这些动作**不会自动执行**，等主人拍板；逐条明细在 metrics full 档（首屏片只带计数，守 2 KB 预算）。"));
					box.appendChild(zone);
					rendered++;
				}
			} else {
				box.appendChild(el("div", "bp-note", "需确认动作数：不可探测（auto-actions 源未就绪）"));
			}
			if (rendered === 0) box.appendChild(el("div", "bp-empty", "今天没有要你处理的事 🐳"));
			return box;
		}
		//#endregion

		// 【V2-D 首屏瘦身 · 2026-09-14 主人拍板】原「③ 资产总览」与「④ 今日动态」已**移出首屏**：
		//   · 资产明细只存「📦 资产」Tab（buildAssetsDetail；进 Tab 才拉 assets 片）；
		//   · 变更流水 / 自动动作明细只存「变更」Tab（首屏只保留块 2 内的计数）——
		//     同一状态绝不两处渲染（审核 D-2）。
		//   ⛔ 反向约束：首屏**不得**再出现块 3/4 的容器（_test\test-firstscreen-dom.mjs 有反向断言防回流）。
		//   编号顺位（2026-09-14 主人要求连续）：原「⑤ 健康底栏」→ 本块显示为「③ 健康底栏」。

		//#region 块 3 健康底栏（心跳 + 数据新鲜度 + 误报率三格）
		function blockHealth(st, metrics, bus, pending) {
			const box = el("div", "bp-block");
			const head = el("div", "bp-block-head");
			head.appendChild(el("span", "", "③ 健康底栏"));
			head.appendChild(el("span", "right", "点任意项进「管家」Tab 看全量（V2-C 提供）"));
			box.appendChild(head);
			const bar = el("div", "bp-bar");

			// ① 管家自身心跳：**只显示 judgeTickdHealth().level**（面板不自算 age —— 该字段是 UTC，混用会造 8 小时级假告警）
			{
				const th = metrics?.items?.tickdHealth ?? null;
				const seg = el("div", "seg");
				seg.appendChild(el("span", "k", "心跳"));
				if (pending) {
					seg.appendChild(UI.badge({ text: "采集中…", tone: "gray", variant: "outline" }));
					seg.title = "指标片已移出首屏，加载完自动回填（心跳仍只认 judgeTickdHealth().level，面板不自算 age）";
				} else if (!th || th.available !== true || !th.level) {
					seg.appendChild(UI.badge({ text: "不可探测", tone: "gray", variant: "outline" }));
					seg.title = (th && th.reason) ? String(th.reason) : "tickd 健康源未接入（WatchTick / 协调器 / 采集器心跳不可得）";
				} else if (th.running && th.running.ok === false) {
					// 【卡「tickd 停摆治本」2026-09-23】引擎没跑必须直说：原先这里只给「🔴 异常」，
					// 原因藏在 tooltip 里 —— 看着像"某个 job 失败"，实际是整条链根本没在跑。
					seg.appendChild(UI.badge({ text: "🔴 引擎未运行", tone: "red", variant: "outline" }));
					seg.appendChild(el("span", "v", String(th.running.reason ?? "")));
					seg.title = "judgeTickdHealth().level = " + String(th.level) + "｜" + String(th.reason ?? "") + "（唯一权威源 lib/tickd-health.mjs；恢复：butler-tickd.mjs --ensure）";
				} else {
					const lv = String(th.level);
					const cls = lv === "green" ? "green" : (lv === "yellow" ? "yellow" : (lv === "red" ? "red" : "gray"));
					// 【M5】会话异地镜像红标：该字段**只在告警态存在**（`lib/metrics.mjs` 条件带 ⇒ 常态零字节代价）
					//   ⇒ 直说「镜像停摆 N 轮」，不让主人对着"🟡 注意"猜是哪个 job。四段式全文放在「管家」Tab
					//   的 ⏱ tickd 调度卡（metrics 片硬 ≤2048 B 装不下全文）。判据源 = `butler-session-mirror.json#consecutiveUnreachable`。
					const mir = th.mirror ?? null;
					const mirAlarm = !!(mir && (mir.lv === "yellow" || mir.lv === "red"));
					seg.appendChild(UI.badge({ text: mirAlarm ? ((mir.lv === "red" ? "🔴" : "🟡") + " 镜像停摆 " + Number(mir.n ?? 0) + " 轮")
							: (lv === "green" ? "🟢 正常" : (lv === "yellow" ? "🟡 注意" : (lv === "red" ? "🔴 异常" : lv))), tone: mirAlarm ? (mir.lv === "red" ? "red" : "yellow") : cls, variant: "outline" }));
					seg.appendChild(el("span", "v", mirAlarm ? "会话异地镜像（对端）" : "WatchTick/协调器/采集器"));
					seg.title = mirAlarm
						? ("会话异地镜像：对端连续 " + Number(mir.n ?? 0) + " 轮不可达（判据 butler-session-mirror.json#consecutiveUnreachable ≥ 3）｜四段式文案见「管家」Tab 的 ⏱ tickd 调度卡｜judgeTickdHealth().level = " + lv + (th.reason ? "｜" + th.reason : ""))
						: ("judgeTickdHealth().level = " + lv + (th.reason ? "｜" + th.reason : "") + "（唯一权威源 lib\\tickd-health.mjs；面板不自算 age）");
				}
				bar.appendChild(seg);
			}
			// ② 数据新鲜度：逐源 asOf，**标注最旧那一段**（不是笼统一个"新鲜"）
			{
				const asOfMap = st?.meta?.asOf ?? null;
				const seg = el("div", "seg");
				seg.appendChild(el("span", "k", "数据新鲜度"));
				if (!asOfMap) {
					seg.appendChild(UI.badge({ text: "不可探测", tone: "gray", variant: "outline" }));
				} else {
					const oldest = oldestOf(asOfMap);
					if (!oldest) seg.appendChild(UI.badge({ text: "逐源 asOf 全缺", tone: "gray", variant: "outline" }));
					else {
						const judged = judgeFreshness(asOfMap, st);
						const staleKeys = Object.keys(judged).filter((k) => judged[k].stale)
							.sort((x, y) => judged[y].ageMs - judged[x].ageMs);
						const lines = Object.entries(asOfMap)
							.map(([k, v]) => k + "：" + ageText(v) + (v && v.source ? "（" + v.source + "）" : "")
								+ (judged[k] && judged[k].stale ? " ⚠ " + staleText(judged[k].ageMs) + "（超 2×采集周期 " + Math.round(judged[k].periodMs / 1000) + "s）" : ""))
							.sort((x, y) => x.localeCompare(y));
						if (staleKeys.length) {
							// 方案原文：超 2 × 采集周期 ⇒ 该行**标灰** + 附「数据 N 分钟未更新」（取最旧那个源作代表）
							const worst = staleKeys[0];
							seg.appendChild(UI.badge({ text: "⚠ " + staleText(judged[worst].ageMs) + "（" + worst + " 超 2×采集周期）", tone: "gray", variant: "outline" }));
						} else {
							seg.appendChild(el("span", "v", "最旧 " + oldest.key + " " + ageText({ at: Date.now() - oldest.d })));
						}
						seg.title = "逐源 asOf：\n" + lines.join("\n")
							+ "\n（判据 = 采集周期 × 2；周期来源 = 逐源 periodMs 或 core 片 cache.ttlMs）";
						const m = metrics?.asOf ?? null;
						if (m && typeof m.at === "number") {
							seg.appendChild(el("span", "k", "·"));
							seg.appendChild(el("span", "v", "指标最旧 " + ageText({ at: m.at }) + (Array.isArray(m.sources) ? "（" + m.sources.join("/") + "）" : "")));
						}
					}
				}
				bar.appendChild(seg);
			}
			// ③ 误报率三格：按机（限定词）/ 池级 L1·L2 / 明细是否完整
			{
				const fp = metrics?.items?.falsePositive ?? null;
				const seg = el("div", "seg");
				seg.appendChild(el("span", "k", "误报率"));
				if (pending) {
					seg.appendChild(UI.badge({ text: "采集中…", tone: "gray", variant: "outline" }));
					seg.title = "指标片已移出首屏，加载完自动回填（误报率仍按「按机 / 池级 L1·L2 / 明细完整」三格口径）";
				} else if (!fp || fp.available !== true) {
					seg.appendChild(UI.badge({ text: "不可探测", tone: "gray", variant: "outline" }));
					seg.title = "falsePositive 源未接入（按机 = 当日日报「📊 误报率」段同源；面板只读，不重算）";
				} else {
					const byM = fp.byMachine ?? null;
					const cum = byM?.cumulative ?? null;
					const gate = byM?.gate ?? null;
					const pass = gate && gate.rateOk === true && gate.sampleOk === true && gate.suspectOk === true;
					const cells = [];
					cells.push("按机 " + (byM ? (cum ? pctText(cum.rate) : "样本不可得") : "不可探测") + "（" + (gate ? (pass ? "达标" : "未达标") : "门槛未判定") + " · 按机 ≤5% / 累计 ≥50）");
					cells.push("池级 L1 " + (fp.poolL1?.available === true ? (fp.poolL1.pass ? "达标" : "未达标") : "不可探测") + " / L2 " + (fp.poolL2?.available === true ? (fp.poolL2.pass ? "达标" : "未达标") : "不可探测"));
					cells.push("明细完整 " + (fp.detailComplete === true ? "是" : (fp.detailComplete === false ? "否" : "未标注")));
					const lv = !byM ? "gray" : (pass ? "green" : "yellow");
					seg.appendChild(UI.badge({ text: cells[0], tone: lv, variant: "outline" }));
					seg.appendChild(el("span", "v", cells[1]));
					seg.appendChild(el("span", "k", cells[2]));
					seg.title = "三格口径：① " + cells[0] + "\n② " + cells[1] + "（池级需 barewatch-cross 子进程，面板只读不跑子进程 → 不可探测）\n③ " + cells[2];
				}
				bar.appendChild(seg);
			}
// ④ SLO 尾部 SLI（V3 功能面·面板提速②） —— 后端 core.sli 已备料（V2.9 封口②·W2），前端此前只收不画 ⇒ 人看不见。
			//   本段**只渲染结论**（可用率 / 覆盖 / 新鲜度 / 取数耗时），面板绝不重算统计：
			//   唯一真源 = dsh-butler\lib\slo-tail.mjs#sliTailLite；字段白名单见 lib\shards.mjs 的 SHARD_FIELDS.core.sli。
			// 【V3.0.0 · 判据 15 缺口 A-2 · 2026-10-26】运行期开关（键载体 = <状态目录>\ops-autonomy-limits.json
			//   #panelSwitches.sli）：键 = JSON `false` ⇒ **整段不渲染**（DOM 里查不到 SLI 这个 seg，其余面板不动）；
			//   缺键 / 值非法 / 值没到手 ⇒ 渲染（fail-open = 与 2026-10-19 以来逐项一致）。
			//   值由服务端 `meta.panelSwitches` 转手（服务端 5 s 缓存）；本文件是**实时读盘**，硬刷新即生效、不必重启 dsh。
			if (st?.meta?.panelSwitches?.sli !== false) {
				const sli = st?.sli ?? null;
				const seg = el("div", "seg");
				seg.appendChild(el("span", "k", "SLI"));
				if (!sli || sli.ok === false) {
					seg.appendChild(UI.badge({ text: "不可探测", tone: "gray", variant: "outline" }));
					seg.title = "sli 片未到或后端不可探测" + (sli && sli.reason ? "：" + String(sli.reason) : "")
						+ "（数据源 = core.sli / slo-tail.sliTailLite；面板只渲染不自算）";
				} else {
					const IT = sli.items ?? {};
					const LABEL = { guardAvailability: "守护鱼可用率", dshAvailability: "dsh 服务可用率", sessionSuccess: "会话成功率", rollbackSuccess: "回滚成功率" };
					const val = (x) => (x && typeof x.value === "number" && isFinite(x.value)) ? pctText(x.value) : "不可探测";
					seg.appendChild(el("span", "v", "守护鱼 " + val(IT.guardAvailability) + " · dsh " + val(IT.dshAvailability)
						+ " · 会话 " + val(IT.sessionSuccess) + " · 回滚 " + val(IT.rollbackSuccess)));
					const cov = sli.coverage ?? null;
					if (cov) seg.appendChild(el("span", "k", "覆盖 " + Number(cov.covered ?? 0) + "/" + Number(cov.total ?? 0)));
					const sliAt = (sli.asOf && typeof sli.asOf.at === "number") ? sli.asOf.at : (sli.at ? Date.parse(sli.at) : null);
					seg.appendChild(el("span", "k", "· " + (sliAt ? ageText({ at: sliAt }) : "未标注")));
					const rows = Object.entries(IT).map(([k, v]) => {
						const nm = LABEL[k] ?? k;
						const vv = (v && typeof v.value === "number" && isFinite(v.value)) ? pctText(v.value)
							: ("不可探测" + (v && v.reason ? "（" + v.reason + "）" : ""));
						const cnt = (v && typeof v.ok === "number" && typeof v.total === "number") ? "（" + v.ok + "/" + v.total + "）" : "";
						return "· " + nm + "：" + vv + cnt + (v && v.source ? "｜源 " + v.source : "");
					});
					const cache = st?.meta?.cache ?? null;
					const took = (cache && typeof cache.computeMs === "number")
						? (cache.computeMs + " ms" + (cache.hit ? "（命中缓存，缓存龄 " + Math.round(Number(cache.ageMs ?? 0) / 1000) + "s）" : "（本次重算）"))
						: "未标注";
					seg.title = "SLO 尾部 SLI（只渲染不自算；真源 dsh-butler\\lib\\slo-tail.mjs）\n" + rows.join("\n")
						+ "\n覆盖 " + (cov ? Number(cov.covered ?? 0) + "/" + Number(cov.total ?? 0) : "—")
						+ "｜面板 core 片取数 " + took
						+ "\n口径：守护鱼可用率 / dsh 服务可用率 / 会话成功率 / 回滚成功率（V2.9 封口②·W2 接线）";
				}
				bar.appendChild(seg);
			}
			box.appendChild(bar);
			return box;
		}
		//#endregion

		/** 【V3-A2】六指标**占位态**：指标片还没到（已移出首屏）时先画 6 个灰卡 ——
		 *  ① 版式不跳（卡片位先占住）② 值显示"…"而不是 0/空白（绝不冒充真值）
		 *  ③ 说明"采集中 + 已移出首屏"，与"不可探测（降级）"两种态在文字上明确分开。 */
		function metricsPendingCards() {
			const wrap = el("div", "bp-kpis");
			for (const label of ["🔴 待我处理", "🚦 自治档位", "⚙️ 今日自动办好", "🧩 资产异常", "📥 在途任务", "🎯 误报率"]) {
				const card = UI.kpi({ label: label, value: "…", tone: "k-gray", hint: "采集中…（指标片已移出首屏，加载完自动回填）" });
				card.style.opacity = "0.85";
				wrap.appendChild(card);
			}
			return wrap;
		}
		/** 首屏组装：六指标 + **三块**（① 今日判断 / ② 待处理 / ③ 健康底栏）——
		 *  长尾块一个节点都不建；原块 3（资产总览）/ 块 4（今日动态）已于 V2-D 移出首屏（明细在资产/变更 Tab），
		 *  健康底栏由原「⑤」顺位为「③」（2026-09-14 主人要求编号连续）。 */
		function buildFirstScreen(st, bus, view) {
			const zone = el("div", "bp-first");
			const metrics = st?.metrics ?? null;
			if (view?.degraded >= DEGRADE_STREAK_ALERT) {
				const warn = el("div", "bp-degrade", "⚠ 连续 " + view.degraded + " 次打开都未命中缓存且重算偏慢（最近 " + (view.lastMs ?? "?") + " ms）——面板数据仍是**真的**，只是每次重新采集（生态面板 HTTP 是固定价）。若持续如此，请查生态面板 / dsh 负载。");
				zone.appendChild(warn);
			}
			if (view?.fromCache) {
				zone.appendChild(el("div", "bp-note", "（当前展示的是客户端缓存内容 · " + ageText(view.cacheAt) + "；正在后台拉取最新）"));
			}
			// 【V3-A2】metrics 片已移出首屏 ⇒ 未到手时先画**占位态**（绝不拿"不可探测"冒充降级），
			//   片到手 → absorb 合并进 state → renderZone 重绘（回填）；失败 → 显式"拉取失败 + 原因"。
			const pending = view?.metricsPending === true && !metrics;
			zone.appendChild(pending ? metricsPendingCards() : buildMetrics(metrics, bus));
			zone.appendChild(blockVerdict(st, metrics, pending));
			zone.appendChild(blockPending(st, metrics, bus, pending));
			zone.appendChild(blockHealth(st, metrics, bus, pending));
			if (view?.metricsError && !metrics) {
				zone.appendChild(el("div", "bp-note", "⚠ 指标片拉取失败：" + String(view.metricsError) + "（首屏其余部分不受影响；点「刷新」可重试）"));
			}
			return zone;
		}

		/** 冷启动骨架屏：显示**真实测得**的首次耗时（localStorage 自校准，无记录时用本卡实测值）。 */
		/** 骨架屏（V31-018 卡 B：渲染交给 panel-ui 的 UI.skeleton；本函数只留大管家专属的那两句文案）。 */
		function skeletonFirstScreen(view) {
			const sec = (view && typeof view.coldSeconds === "number" && view.coldSeconds > 0)
				? view.coldSeconds
				: COLD_MS_DEFAULT / 1000;
			return UI.skeleton({
				text: "采集中（首次约 " + sec.toFixed(1) + " 秒）",
				lines: 3,
				note: "冷启动要重算 core / feed 两片（指标/健康两片已移出首屏，面板打开后异步后补回填）；5 分钟内的再次打开走进程内缓存，毫秒级。资产 / 管家 / 报告 Tab 的片进对应 Tab 时才拉。",
			});
		}

		//#region V2-C 「管家」Tab + 「资产」Tab（长尾块的新家）
		// 「管家」= 健康监控全量（归档 / P6 外部信号）+ 重启统筹 + P5 写入守门人 + 干预统计 +
		//   模块开关（熔断）+ 影子视图 + 趋势卡 + 契约全文（折叠 · 点开才拉）。
		// 「资产」= 升级锁 + 升级体检 + P8 产出与收纳（health 片）+ 组件版本 / 状态文件登记 /
		//   实体计数摘要（assets 片明细）。
		// 去重纪律（审核 D-2）：P5 / P6 / 重启统筹在首屏只以**异常行**出现（块 2），
		//   明细卡片**只存在于「管家」Tab**；升级体检明细**只存在于「资产」Tab** —— 同一状态绝不两处渲染。
		function buildStewardTab(st, bus, md, v2c) {
			const zone = el("div");
			const ignored = st?.meta?.ignored ?? { sessions: 0, tasks: 0 };
			zone.appendChild(tabHeader("🐋 管家",
				"健康监控全量 / 重启统筹 / P5 写入守门人 / 模块开关 / P6 外部信号 / 趋势 / 影子 / 契约（只读）",
				v2c, TAB_PARTS.steward));
			if (v2c?.error) zone.appendChild(tabError(v2c.error, bus, "steward"));
			if (v2c?.loading) zone.appendChild(tabLoading(v2c, "管家"));
			// ① 健康监控全量：会话自动归档 + P6 外部信号（升级体检/P8 收纳已划归「资产」Tab，见 D-2 不两处渲染）
			if (st?.health) zone.appendChild(buildHealth(st.health, { sections: ["tickd", "archive", "external", "handoff"] }));
			// ② 重启统筹（卡 [1] P0）：排队状态 + 两个入口按钮
			zone.appendChild(buildRestart(st?.health?.restart));
			// ③ P5 写入守门人 + 干预统计（数据源 = audit 片；core 片只带计数）
			zone.appendChild(buildAudit(st?.audit, v2c, bus));
			// ④ 模块级熔断开关（L2）+ 影子视图（若开启会执行）—— 数据源 = GET /modules
			if (md) zone.appendChild(buildModules(md, bus));
			else zone.appendChild(el("div", "bp-note", "模块开关数据未就绪（GET /modules 失败或还没拉到）——点「重试」再试一次。"));
			// ⑤ 趋势卡（中断 / 记忆，近 N 天；数据源 = reports 片，进本 Tab 才拉）
			const tr = st?.reports?.trends;
			if (tr && (tr.dates?.length ?? 0) >= 2) {
				const row = el("div", "bp-trends");
				row.appendChild(trendCard("中断会话 · 近 " + tr.dates.length + " 天", tr.interrupted, 46, TOK.color["state-error-fg"]));
				row.appendChild(trendCard("记忆总量 · 近 " + tr.dates.length + " 天", tr.memory, 46, TOK.color["accent-purple-fg"]));
				zone.appendChild(row);
			} else if (st?.reports) {
				zone.appendChild(el("div", "bp-note", "趋势卡：报告档案不足 2 天（reports 片已到，数据不够画线）——不画假线。"));
			}
			// ⑥ 坑升级候选（P4 会学习 · 2026-10-09 卡「冲刺600·批4-1」）：只读列表 + 采纳/忽略按钮
			zone.appendChild(buildP4Candidates(bus));
			// ⑦ 📱 服务面（外部通道健康 · 只读）：
			//   数据源 = `service` 片（进本 Tab 才拉）；判定**只有一份**（由宿主的健康判定件给），
			//   本块只渲染 —— 面板里不写任何健康判定，也不绑定任何具体通道。
			zone.appendChild(buildServiceBlock(st?.service, v2c, bus));
			// ⑧ 契约全文（折叠 · **点开才拉**：127 KB 只在点开时发生一次，TTL 10 分钟 —— 连接池铁律）
			zone.appendChild(buildContractBlock(st, bus, v2c));
			if (ignored.sessions || ignored.tasks) {
				zone.appendChild(el("div", "bp-note", "（已忽略 " + ignored.sessions + " 个会话、" + ignored.tasks + " 张卡，不在此清单显示）"));
			}
			// 【施工卡 ①-3 · ①-7】忽略清单**读路径可见化**：文件坏 ⇒ 显式报"判定不可用"，
			//   绝不静默渲染成"没有忽略项"（否则被忽略项会悄悄"复活"，主人以为忽略生效了）。
			if (st?.meta && st.meta.ignoreOk === false) {
				zone.appendChild(el("div", "bp-note", "⚠️ 忽略清单判定不可用：" + (st.meta.ignoreError ?? "未知原因") + "（本次不按「空清单」处理；修好 ~/.dsh/butler-ignored.json 后恢复正常）"));
			}
			const note = el("div", "bp-note", "中断判定（v1.4.4）：最后活动 5 分钟 ~ 3 天前「且」最后一个回合没走完才算，三种尾巴分色——① 回合停在工具调用/回答中途（红）；② turn/end 的 reason.kind 非 completed/stop：interrupted=被硬杀/重启打断（红）、aborted·user=主人手动中止（黄）、error=回合异常结束（灰）；③ 重启/停机时补写的 session/end-seed 不算尾巴，会自动往前找真尾。正常收尾的会话不进清单，闭环一个就真 -1。挂起任务 = 看板待办/待规划卡 3 天未动（任务维度，点「任务」页查看）。日报每日 09:00、周报每周一 09:05 自动生成于 docs\\管家报告。");
			zone.appendChild(note);
			return zone;
		}

		// ---- 📱 服务面（外部通道健康 · 只读）----
		// 数据源 = `service` 片（进「管家」Tab 才拉）。判定**全部**由宿主侧的健康判定件（唯一判定入口）给出 ——
		// 本段**只排版**，没有一条健康判定；连状态图标/状态词也是判定件导出的 `checkIcon` / `stateWord` 给的。
		// 下面的"状态→颜色"只是**展示映射**（四档一一对应），不构成判定。**本文件不绑定任何具体通道。**
		const SERVICE_CLS = { ok: "h-green", degraded: "h-yellow", unavailable: "h-red", declared: "h-gray", "environment-unavailable": "h-gray" };
		const svCls = (state) => SERVICE_CLS[state] ?? "h-gray";
		const svAge = (ms) => {
			if (ms === null || ms === undefined || !isFinite(Number(ms))) return "—";
			const s = Math.round(Number(ms) / 1000);
			return s < 90 ? s + " 秒" : (s < 5400 ? Math.round(s / 60) + " 分钟" : Math.round(s / 3600) + " 小时");
		};
		const svNum = (v, unit) => (v === null || v === undefined ? "—" : String(v) + (unit ?? ""));
		function buildServiceBlock(sv, v2c) {
			const zone = el("div");
			zone.appendChild(groupTitle("📱 服务面（外部通道健康 · 只读）"));
			if (!sv) {
				zone.appendChild(unknownLine(v2c?.loading ? "service 片拉取中…（串行队列，不与主界面抢连接池）" : "service 片未到（服务面健康不可探测）——进本 Tab 会按需拉它"));
				return zone;
			}
			if (sv.ok !== true) {
				zone.appendChild(unknownLine("🔴 判定入口不可用：" + (sv.reason ?? "原因未知") + " —— 这不是「服务面正常」"));
				return zone;
			}
			const v = sv.verdict ?? {};
			const c = v.counts ?? {};
			const grid = el("div", "bp-health");
			// ① 总判定
			grid.appendChild(healthCard("服务面总判定", String(v.word ?? v.state ?? "?"), svCls(v.state), [
				["判定", String(v.state ?? "?") + " · 退出码 " + String(v.exitCode ?? "?")],
				["计数", "可用 " + String(c.ok ?? 0) + " / 降级 " + String(c.degraded ?? 0) + " / 不可用 " + String(c.unavailable ?? 0) + " / 未落 " + String(c.declared ?? 0)],
				["判定时刻", String(v.asOf ?? "?")],
				["设备", String(v.host ?? "?") + " · home " + String(v.home ?? "?")]
			]));
			// ②③ 长连接（hub）存活 + 今日入站 / 丢线（判据 = 判定库的 channel 项，面板不动它一个字段）
			const h = sv.hub;
			if (!h) {
				zone.appendChild(unknownLine("channel 项缺失（判定库没给这一项）—— 面板不现造一个「正常」顶上"));
			} else {
				const hubCard = healthCard("长连接（hub）存活", String(h.icon ?? "❔") + " " + String(h.state ?? "?"), svCls(h.state), [
					["判据", String(h.title ?? "—")],
					["心跳", h.at ? String(h.at) + "（" + svAge(h.ageMs) + "前 · 阈值 " + Math.round(Number(h.staleMs ?? 0) / 1000) + " 秒）" : "无心跳文件"],
					["connected", h.connected === true ? "true" : "false"],
					["今日入站", svNum(h.todayInbound, " 条")],
					["丢线 / 被踢", svNum(h.disconnectCount) + " / " + svNum(h.kickedCount) + " 次"],
					["读数来源", h.source === "peer" ? "对端快照" : (h.source === "local" ? "本机" : "无（本机不持连接）")]
				]);
				hubCard.appendChild(el("div", "bp-note", String(h.detail ?? "")));
				grid.appendChild(hubCard);
			}
			// ④ 推送台账末行
			const p = sv.push;
			if (!p) {
				zone.appendChild(unknownLine("push-delivery 项缺失（判定库没给这一项）—— 不装成「没有问题」"));
			} else {
				grid.appendChild(healthCard("推送台账", String(p.icon ?? "❔") + " " + String(p.state ?? "?"), svCls(p.state), [
					["末行", p.lastAt ? String(p.lastAt) + "（" + String(p.lastStatus ?? "?") + "）" : "台账无行（这不等于「没有推送」，是载体没留痕）"],
					["今日真送达", svNum(p.sentToday, " 条")],
					["累计真送达", svNum(p.realSends, " 条")],
					["台账行数", svNum(p.rows, " 行") + (Number(p.bad ?? 0) > 0 ? "（坏行 " + p.bad + "）" : "")],
					["连续失败", svNum(p.consecutiveFail, " 条")]
				]));
			}
			// ⑤ 家人用量末行（S-9：载体不存在 ⇒ 写「无可读数」，绝不写「没人用」）
			const f = sv.family;
			if (f && f.error) {
				zone.appendChild(unknownLine("家人用量读失败：" + f.error + "（判定库抛错，面板不复算）"));
			} else if (f) {
				const id = f.identity ?? {};
				const us = f.usage ?? {};
				const top = (us.perUserTop ?? []).slice(0, 5);
				const famCard = healthCard("家人用量（S-9）", String(f.state ?? "?"), svCls(f.state), [
					["统计日", String(f.day ?? "?") + " · 设备 " + String(f.host ?? "?")],
					["身份表", id.exists ? (id.ok ? String(id.count ?? 0) + " 人（形态 " + String(id.shape ?? "?") + "）" : "在但读不动：" + String(id.error ?? "?")) : "未落（已声明）⇒ 只能报原始 userid"],
					["今日用量", us.exists ? ("回合 " + String(us.totalTurnsToday ?? 0) + " · tokens " + String(us.totalTokensToday ?? 0) + " · 被拒 " + String(us.rejectedToday ?? 0) + " 条") : "无可读数（台账未落 · 已声明）—— 这不是「今天没人用」"],
					["推送旁证", svNum(f.push?.sentToday, " 条真送达（今日）")]
				]);
				for (const u of top) {
					famCard.appendChild(el("div", "bp-health-line", (u.name ? String(u.name) : String(u.userid)) + "：今日 " + String(u.turnsToday ?? 0) + " 回合 · 累计 " + String(u.turnsAll ?? 0) + " · 末次 " + String(u.lastAt ?? "-")));
				}
				grid.appendChild(famCard);
			} else {
				zone.appendChild(unknownLine("家人用量不可探测（判定库未给出读数）"));
			}
			zone.appendChild(grid);
			// 全量逐项一览（8 项 · 状态 + 截断文案；仍是判定库原文，面板不改一字）
			const list = el("div", "bp-note");
			for (const x of (sv.checks ?? [])) {
				list.appendChild(el("div", "", String(x.state ?? "?") + " · " + String(x.id ?? "?") + " · " + String(x.title ?? "") + "：" + String(x.detail ?? "")));
			}
			zone.appendChild(list);
			zone.appendChild(el("div", "bp-note", "口径：判定**唯一入口**是宿主侧提供的那份健康判定件（面板**只渲染、不自算判定**；零网络、零写盘、不读密钥值）。四档 ok/degraded/unavailable/declared —— 「未落（declared）」显式成段、**永不判绿**。宿主没提供判定件时本块显式报「不可探测」，不会假装正常。本面板守零网络边界，不主动跨机取数。"));
			return zone;
		}

		// ---- V2-C Tab 通用件（页头 / 载入中 / 错误 + 重试 / 资产明细 / 契约折叠）----
		/** Tab 页头：把"本 Tab 该拉哪几片 + 本次实拉了什么"摆在明面上（进 Tab 才拉的可见性）。 */
		function tabHeader(title, sub, v2c, names) {
			const box = el("div", "bp-tab-head");
			box.appendChild(el("div", "bp-tab-title", title));
			box.appendChild(el("div", "bp-note", sub));
			const parts = names ?? [];
			const pulled = v2c?.pulled ?? [];
			const tail = pulled.length
				? "｜本次实拉：" + pulled.map((x) => x.name + " " + (x.bytes ?? 0) + "B").join(" / ") + (v2c?.ms != null ? "｜用时 " + v2c.ms + "ms" : "")
				: "｜本次命中缓存，未发请求";
			box.appendChild(el("div", "bp-note", "按需拉取：" + parts.map((n) => n + "（TTL " + Math.round((SHARD_TTL_MS[n] ?? 0) / 1000) + "s）").join(" / ") + tail));
			return box;
		}
		function tabLoading(v2c, label) {
			return el("div", "bp-skel", "「" + label + "」按需拉取中：" + ((v2c?.pulling ?? []).join(" / ") || "…") + "（串行，不与主界面抢连接池）");
		}
		function tabError(msg, bus, key) {
			const box = el("div", "bp-err");
			box.style.display = "";
			box.appendChild(el("span", "", "分片拉取失败：" + msg + "（该区按「不可探测」显示，其它区不受影响）"));
			const retry = el("button", "bp-btn", "重试");
			retry.addEventListener("click", () => bus?.retryTab?.(key));
			box.appendChild(retry);
			return box;
		}

		/** 资产明细（assets 片 → 每注册组一张卡：计数 / 异常数 / 来源 / 数据时刻 / 说明）。 */
		function buildAssetsDetail(a) {
			const zone = el("div");
			if (!a) { zone.appendChild(unknownLine("assets 片未到（不可探测）——本 Tab 会按需拉它")); return zone; }
			if (a.ok !== true) { zone.appendChild(unknownLine("资产源不可探测：" + (a.reason ?? "原因未知"))); return zone; }
			const grid = el("div", "bp-health");
			for (const r of (a.rows ?? [])) {
				const bad = Number(r.anomalies ?? 0);
				const badge = r.ok === false ? "不可探测" : (bad > 0 ? "异常 " + bad : "正常");
				const cls = r.ok === false ? "h-gray" : (bad > 0 ? (bad > 2 ? "h-red" : "h-yellow") : "h-green");
				grid.appendChild(healthCard(String(r.group ?? "?"), badge, cls, [
					["计数", r.count === null || r.count === undefined ? "—" : String(r.count)],
					["异常", bad > 0 ? String(bad) : "无"],
					["来源", String(r.source ?? "?")],
					["数据时刻", ageText(r.asOf)],
					["说明", String(r.note ?? "—")]
				]));
			}
			zone.appendChild(grid);
			zone.appendChild(el("div", "bp-note", "口径（方案 B7）：资产只承载**已知源** —— 组件版本（butler-version.json）/ 状态文件登记（lib/state-files.mjs）/ 升级体检（生态面板落盘缓存，**不打 npm**）/ P8 产出与收纳（butler-tidy-state.json）+ 术语实体摘要（butler-entities.json，只是「实体计数」，**不是资产表**）。`butler-monitor-registry.json` **不存在**，故**不做依赖图**。"));
			zone.appendChild(el("div", "bp-note", "整片 " + String(a.bytes ?? "?") + " B · 组数 " + String(a.totalGroups ?? "?") + " · 不可探测组 " + ((a.unreachable ?? []).length || 0) + "（预算 ≤ 8 KB，超限降级为计数 + Top N）"));
			return zone;
		}

		/** 📦 资产 Tab：升级锁 + 升级体检 + P8 产出与收纳（health 片）+ 资产明细（assets 片）。 */
		function buildAssetsTab(st, bus, v2c) {
			const zone = el("div");
			zone.appendChild(tabHeader("📦 资产",
				"升级锁 / 升级体检 / P8 产出与收纳 / 组件版本 / 状态文件登记 / 实体计数摘要（只读 · 不做依赖图）",
				v2c, TAB_PARTS.assets));
			if (v2c?.error) zone.appendChild(tabError(v2c.error, bus, "assets"));
			else if (v2c?.loading) zone.appendChild(tabLoading(v2c, "资产"));
			zone.appendChild(groupTitle("🔒 升级与收纳明细（health 片）"));
			if (st?.health) zone.appendChild(buildHealth(st.health, { sections: ["upgradeLock", "upgrades", "tidy"], bus }));
			else zone.appendChild(el("div", "bp-note", "health 片未到 → 升级锁 / 升级体检 / P8 收纳**不可探测**（显示「不可探测」而不是 0）"));
			zone.appendChild(groupTitle("🧩 资产明细（assets 片）"));
			zone.appendChild(buildAssetsDetail(st?.assets));
			return zone;
		}

		// ────────────────────────────────────────────────────────────────────────
		// 【卡「冲刺600·批4-1」· 2026-10-09】「坑升级候选」段（P4 会学习）
		//   为什么补：v2 方案 §P4（`docs\大管家v2方案-从只读到真管家-20260909.md` L798）明文要求
		//   面板提供本段（**一键采纳 / 忽略**），生产一直没做；而坑库正文早已指向它
		//   （`docs\坑库\*` 自动条目写「见面板「坑升级候选」」）⇒ **悬空指针**。
		//   数据 = `GET /api/dsh-butler/v1/p4-candidates`（**只读**采集，默认前 30 条、按权重排序）。
		//   动作 = 既有 P1 统一闸门（复用 `actionBtn` ⇒ 预览 → planHash → 执行，前端不拼写参数）；
		//     动作 id = `p4-candidate-adopt` / `p4-candidate-reject`，**真写在服务端**
		//     （共享底座 `manual-actions.mjs` → 既有 CLI `mark-p4-adopted.mjs`，RMW 锁 + 原子写 + 可回滚报告）。
		//   ⚠️ 硬红线（文案与实现都写死）：这里**只登记「已采纳 / 已忽略」**，
		//     **绝不自动改 persona / 技能**（A 层保护区，只能人工走 persona-maintain + P5 门）。
		// ────────────────────────────────────────────────────────────────────────
		/** 单条候选一行：左侧信息 + 右侧「采纳 / 忽略」（两个动作都走 P1 闸门）。 */
		function p4CandidateRow(c, bus) {
			const row = el("div", "bp-row");
			row.appendChild(el("span", "bp-dot bp-dot-yellow"));
			const main = el("div", "bp-main");
			main.appendChild(el("div", "bp-name",
				"🚀 " + String(c.code ?? c.name ?? "?") + " ｜ " + String(c.normText || c.sigKey || "")));
			const meta = [String(c.count ?? 0) + " 次", String(c.sessionCount ?? 0) + " 会话"];
			meta.push("score " + Number(c.score ?? 0).toFixed(2));
			meta.push("分类 " + String(c.category ?? "?"));
			if (c.suggested) meta.push("建议形态 " + String(c.suggested));
			if (Number(c.crossHost?.hostsCount ?? 0) > 1) meta.push("跨机 " + Number(c.crossHost.hostsCount) + " 台");
			if (c.firstSeen) meta.push("首见 " + String(c.firstSeen).slice(0, 10));
			main.appendChild(el("div", "bp-meta", meta.join(" · ")));
			if (c.why) main.appendChild(el("div", "bp-meta", "🗒 " + String(c.why)));
			main.appendChild(el("div", "bp-meta", "候选 id " + String(c.id ?? "?")));
			row.appendChild(main);
			const acts = el("div", "bp-acts");
			acts.appendChild(actionBtn("采纳", "p4-candidate-adopt", () => ({ candidateId: c.id }), bus, {
				primary: true,
				title: "标记这条候选为「已采纳」。**只改候选池状态**——本动作不碰 persona / 技能；真正的落地（检查项 / 内联技能 / 焊 persona）仍需人工各自走流程。"
			}));
			acts.appendChild(actionBtn("忽略", "p4-candidate-reject", () => ({ candidateId: c.id }), bus, {
				warn: true,
				title: "标记这条候选为「已忽略」（不采纳）。同样只改候选池状态，不碰 persona / 技能。"
			}));
			row.appendChild(acts);
			return row;
		}

		/** ⑥ 坑升级候选段（容器 + 异步只读拉取；失败/空态都显式，绝不静默当"没有候选"）。 */
		function buildP4Candidates(bus) {
			const zone = el("div");
			zone.appendChild(groupTitle("🚀 坑升级候选（P4 会学习 · 一键采纳 / 忽略）"));
			const box = el("div");
			zone.appendChild(box);
			const load = async () => {
				box.textContent = "";
				box.appendChild(el("div", "bp-note", "载入中…（只读拉取 GET /api/dsh-butler/v1/p4-candidates）"));
				try {
					const r = await fetch("/api/dsh-butler/v1/p4-candidates", { cache: "no-store" });
					let j = null;
					try { j = await r.json(); } catch { j = null; }
					box.textContent = "";
					if (!j || j.ok !== true) {
						box.appendChild(el("div", "bp-note", "⚠️ 候选池判定不可用：" + String(j?.reason ?? ("HTTP " + r.status)) + "（这是「不可探测」，不是「没有候选」）"));
						return;
					}
					const c = j.counts ?? {};
					box.appendChild(el("div", "bp-note",
						"共 " + String(c.total ?? 0) + " 条：待处理 " + String(c.pending ?? 0) + " · 已采纳 " + String(c.adopted ?? 0)
						+ " · 已忽略 " + String(c.rejected ?? 0)
						+ "｜池更新 " + (j.generatedAt ? String(j.generatedAt).slice(0, 16).replace("T", " ") : "—")
						+ (j.truncated ? "｜本页只列权重前 " + (j.items?.length ?? 0) + " 条" : "")));
					const items = j.items ?? [];
					if (!items.length) {
						box.appendChild(el("div", "bp-note", "⚪ 没有待处理的升级候选（空态）—— 新候选由 P4 tick 每 30 分钟重算。"));
					} else {
						for (const it of items) box.appendChild(p4CandidateRow(it, bus));
					}
					box.appendChild(el("div", "bp-note",
						"口径：候选 = 同一个坑 ≥3 次且跨 ≥2 会话。「采纳 / 忽略」只标记候选池状态"
						+ "（写入口 = 既有 CLI mark-p4-adopted.mjs：RMW 锁 + 原子写 + 幂等 + 可回滚报告；执行后用返回的报告可一键回滚）"
						+ " —— 本面板绝不自动改 persona / 技能（A 层保护区，只能人工走 persona-maintain + P5 门）。"
						+ "数据源：P4 候选池状态文件（P4 tick 每 30 分钟重算）。"));
				} catch (e) {
					box.textContent = "";
					box.appendChild(el("div", "bp-note", "⚠️ 候选池拉取失败：" + String(e?.message ?? e) + "（不影响本 Tab 其它区）"));
					const retry = el("button", "bp-act", "重试");
					retry.addEventListener("click", () => { load(); });
					box.appendChild(retry);
				}
			};
			load();
			return zone;
		}

		/** ⑥ 契约全文折叠区：**默认不拉**（127 KB）；点开才发一次请求，TTL 10 分钟。 */
		function buildContractBlock(st, bus, v2c) {
			const zone = el("div");
			const c = st?.contract ?? null;
			if (!v2c?.contractOpen) {
				const bar = el("div", "bp-acts");
				bar.style.margin = "4px 0 8px";
				const btn = el("button", "bp-act primary", "📜 展开契约全文（约 127 KB · 只在点开时拉一次）");
				btn.title = "契约全文占 /state 全量的 61%（实测 127,396 B）。默认不拉：点这里才发一次请求；10 分钟内再打开走缓存，不重复发。";
				btn.addEventListener("click", () => bus?.openContract?.());
				bar.appendChild(btn);
				zone.appendChild(groupTitle("📜 本鱼契约（只读 · 运行时解析 persona · 折叠）"));
				zone.appendChild(bar);
				zone.appendChild(el("div", "bp-note", "为什么折叠：契约全文 127 KB（占无参全量 61%）。本机 HTTP/1.1 + DSH 单页连接池紧张，一次大请求会跟主界面抢连接 —— 只在真的要看时才拉。"));
				return zone;
			}
			if (!c) {
				zone.appendChild(groupTitle("📜 本鱼契约（只读 · 运行时解析 persona）"));
				zone.appendChild(el("div", "bp-note", v2c?.contractLoading ? "契约拉取中…（127 KB，一次性）" : "契约片尚未到手（不可探测）"));
				return zone;
			}
			zone.appendChild(buildContract(c));
			return zone;
		}

		function sessionActions(s, bus, actBox) {
			const acts = el("div", "bp-acts");
			// v1.4.4：无标题会话搜不到 → 按钮直接表明语义是"复制 ID"，避免看起来像按钮坏了
			const hasTitle = String(s?.title ?? "").trim().length > 0;
			const open = el("button", "bp-act primary", hasTitle ? "打开" : "复制 ID");
			if (!hasTitle) open.title = "该会话没有标题可搜（可能是空会话），点了会把完整会话 ID 复制到剪贴板";
			open.addEventListener("click", async () => {
				open.disabled = true;
				open.textContent = "定位中…";
				const ok = await openSession(s, (msg) => { open.title = msg; });
				// 无论成败都自动关面板（主人要求）：成功=已切到目标会话；
				// 失败=侧栏搜索框已展开并带词、完整 ID 已复制，关掉遮盖让主人直接改词再搜/粘贴 ID
				open.textContent = ok ? "✓ 已跳转" : "ID 已复制";
				await sleep(ok ? 150 : 800);
				bus.closePanel();
			});
			const cardBtn = el("button", "bp-act", "转卡");
			cardBtn.addEventListener("click", async () => {
				// 【施工卡 ①-3 · ①-7】C 级「执行前预览确认」（①包 §3.1 三形态之一 = 原生 confirm）：
				//   写明后果（会开真会话跑、烧 token）；服务端另有 `DUPLICATE_INFLIGHT` 去重拒建。
				if (!window.confirm("转成看板卡？\n\n后果：看板新增一张待办卡，由独立会话执行（会消耗 token）；同会话已有在途卡时服务端会拒绝建卡。")) return;
				cardBtn.disabled = true;
				cardBtn.textContent = "转卡中…";
				try {
					const r = await apiFetch("/api/dsh-butler/card", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: s.fullId ?? s.id }) });
					cardBtn.textContent = "✓ 已转卡";
					cardBtn.title = "已加入任务看板待办";
				} catch (e) {
					cardBtn.disabled = false;
					cardBtn.textContent = "转卡失败";
					cardBtn.title = String(e?.message ?? e);
				}
			});
			const ign = el("button", "bp-act", "忽略");
			ign.addEventListener("click", async () => {
				ign.disabled = true;
				ign.textContent = "忽略中…";
				try {
					await apiFetch("/api/dsh-butler/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "session", id: s.id, ignore: true }) });
					bus.ignoreSession(s);
				} catch (e) {
					ign.disabled = false;
					ign.textContent = "失败";
					ign.title = String(e?.message ?? e);
				}
			});
			acts.appendChild(open);
			acts.appendChild(cardBtn);
			acts.appendChild(ign);
			return acts;
		}
		function sessionRowEl(s, bus) {
			const row = el("div", "bp-row");
			// v1.4.4 细分尾巴：被重启硬杀=红 / 主人手动中止=黄 / 回合异常结束=灰
			const dotCls = s.tailKind === "aborted" ? "bp-dot-yellow" : (s.tailKind === "error" ? "bp-dot-gray" : "bp-dot-red");
			row.appendChild(el("span", "bp-dot " + dotCls));
			const main = el("div", "bp-main");
			main.appendChild(el("div", "bp-name bp-sess-title", (s.title || "").trim() || "（无标题 · 会话 " + shortId(s.fullId ?? s.id) + "）"));
			main.appendChild(el("div", "bp-desc", "会话 " + shortId(s.fullId ?? s.id) + " · 工作区 " + s.group));
			main.appendChild(el("div", "bp-meta", "最后活动 " + s.lastActiveLabel + " · 已停 " + (s.idleLabel ?? "?") + " —— " + (s.tailLabel ?? "未收尾")));
			row.appendChild(main);
			row.appendChild(sessionActions(s, bus));
			return row;
		}
		// 「🔁 会话接力」只读一行（2026-09-22 卡 S1 · **只加只读展示，不动任何告警逻辑**）。
		//   数据来源 = core 片的 `sessions.relay`（`shards.mjs` 采集 / `state.js` 全量路径同名字段）；
		//   判据全在 `<工作区>/tools/session-relay.mjs`，这里只做展示（包括"不可探测"的显式出口）。
		function relayNoteEl(relay) {
			if (!relay) return el("div", "bp-note", "🔁 会话接力：不可探测（core 片未带该字段）");
			if (relay.error) return el("div", "bp-note", "🔁 会话接力：不可探测（" + relay.error + "）");
			const sid = (v) => (v ? String(v).replace(/^session-/, "").slice(0, 8) : "?");
			const t = relay.today ?? {};
			const parts = [];
			parts.push("今日 成功 " + (t.ok ?? 0) + " / 失败 " + (t.failed ?? 0) + (t.noCreate ? " / 人工 " + t.noCreate : ""));
			parts.push(relay.pendingHandoff
				? "待改绑 1 条（" + sid(relay.pendingHandoff.sourceSessionId) + " → " + sid(relay.pendingHandoff.newSessionId) + "）"
				: "无待改绑");
			if (relay.lockFiles) parts.push("在跑链锁 " + relay.lockFiles + " 把");
			parts.push(relay.orphanLeftovers ? "孤儿/宽限期遗留 " + relay.orphanLeftovers + " 条（只报不收拾）" : "孤儿/宽限期遗留 0 条");
			if (relay.graceMissingSid) parts.push("⚠️ 取数字段缺失 " + relay.graceMissingSid + " 条");
			parts.push("总闸 " + (relay.moduleEnabled ? "已放行" : "未放行"));
			return el("div", "bp-note", "🔁 会话接力：" + parts.join(" · "));
		}
		function buildSessions(st, bus) {
			const zone = el("div");
			const list = st?.sessions?.interrupted ?? [];
			const sess = st?.sessions ?? {};
			const tailNote = "（近 3 天有活动的会话 " + (sess.scanned ?? "?") + " 个，其中已正常收尾 " + (sess.endedRecent ?? 0) + " 个不再计入）";
			zone.appendChild(relayNoteEl(sess.relay));
			if (list.length === 0) {
				zone.appendChild(el("div", "bp-empty", "🟢 没有被打断的会话，一片清爽～"));
				zone.appendChild(el("div", "bp-note", "判定：最后活动 5 分钟 ~ 3 天前「且」回合没正常收尾。" + tailNote));
				return zone;
			}
			zone.appendChild(groupTitle("⚠️ 被打断的会话（回合没走完）"));
			for (const s of list) zone.appendChild(sessionRowEl(s, bus));
			zone.appendChild(el("div", "bp-note", tailNote));
			zone.appendChild(el("div", "bp-note", "提示：打开=跳到该会话继续（续上并正常收尾后，本清单会自动少一个）；转卡=交给任务看板跟进；忽略=不再提醒（本次打开内可撤销）。"));
			return zone;
		}
		// ────────────────────────────────────────────────────────────────────────
		// 【P1「会动手」· 2026-09-28】动作按钮 = 预览 → 确认 → 执行
		//   服务端唯一入口 = `POST /api/dsh-butler/v1/action`（实现全在共享底座
		//   `tools\dsh-butler\lib\manual-actions.mjs`）。前端**不算任何判据、不拼写参数**：
		//   可不可做、做了会怎样、有没有超成本，一律由服务端算完回给前端照着渲染。
		//   三条必须处理的服务端语义：
		//     ① 缺省就是预览（dryRun:true）—— 点一下永远先看"将做什么"，零写操作；
		//     ② 执行必须回传预览回执 planHash（服务端缺它直接拒 ⇒ 防"盲执行"）；
		//     ③ 409 + code='drift' ⇒ 目标状态变了：**就地把新预览渲染出来** + 提示"请重新确认"
		//        （不弹死报错；连续 2 次漂移服务端拒并提示稍后再试）。
		// ────────────────────────────────────────────────────────────────────────
		/** P1 专用 POST：与 apiFetch 的差别 = **非 2xx 也把 body 交回调用方**（drift 就在 409 上）。 */
		async function p1Post(payload) {
			const res = await fetch("/api/dsh-butler/v1/action", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				cache: "no-store"
			});
			let data = null;
			try { data = await res.json(); } catch { data = null; }
			if (!data) throw new Error("HTTP " + res.status + "（响应不是 JSON）");
			return data;
		}

		/** 渲染一个 P1 动作按钮：`paramsFor(extra)` 返回请求 params（extra 供动作自己扩展）。 */
		function actionBtn(label, actionId, paramsFor, bus, opts = {}) {
			const btn = el("button", "bp-act" + (opts.warn ? " warn" : (opts.primary ? " primary" : "")), label);
			if (opts.title) btn.title = opts.title;
			btn.__p1 = { actionId, paramsFor, opts };
			btn.addEventListener("click", () => openActionPanel(btn, bus));
			return btn;
		}

		async function openActionPanel(btn, bus) {
			const spec = btn.__p1;
			if (!spec) return;
			if (btn.__p1box && btn.__p1box.isConnected) { btn.__p1box.remove(); btn.__p1box = null; return; }
			const anchor = btn.closest(".bp-row") || btn.closest(".bp-pend") || btn.parentElement;
			const box = el("div", "bp-mod-confirm");
			btn.__p1box = box;
			if (anchor) anchor.after(box);
			const close = () => { box.remove(); btn.__p1box = null; };

			// 渲染服务端预览（或 drift 回执 —— 两者字段同构，所以同一个渲染函数）
			const render = (pv, extra, note) => {
				box.textContent = "";
				if (note) box.appendChild(el("div", "bp-mod-ask", note));
				box.appendChild(el("div", "bp-mod-ask", (pv.title || spec.actionId) + " —— " + (pv.summary || "")));
				for (const d of (pv.details || [])) box.appendChild(el("div", "bp-mod-meta", "· " + d));
				for (const w of (pv.warnings || [])) box.appendChild(el("div", "bp-mod-ask", "⚠️ " + w));
				if (pv.rollback && pv.rollback.how) box.appendChild(el("div", "bp-mod-meta", "↩️ 回滚：" + pv.rollback.how));
				const btns = el("div", "bp-mod-btns");
				const ok = el("button", "bp-act primary", pv.needsAck ? "确认执行（已知成本）" : "确认执行");
				const cancel = el("button", "bp-act", "取消");
				const msg = el("span", "bp-mod-meta", "回执 " + String(pv.planHash || "").slice(0, 8) + "（服务端核对用）");
				btns.appendChild(ok); btns.appendChild(cancel); btns.appendChild(msg);
				box.appendChild(btns);
				cancel.addEventListener("click", close);
				ok.addEventListener("click", async () => {
					ok.disabled = true; cancel.disabled = true; ok.textContent = "执行中…";
					try {
						const params = spec.paramsFor(extra);
						if (pv.needsAck) params.ackCost = true;
						const r = await p1Post({ actionId: spec.actionId, params, dryRun: false, expectedPlanHash: pv.planHash, actor: "owner-panel" });
						if (r.ok === false && r.code === "drift") { render(r, extra, "⚠️ 目标状态已变化，请**重新确认**（下面是最新的预览）："); return; }
						if (r.ok === false) {
							msg.textContent = "✗ " + (r.message || r.code || "执行被拒");
							ok.textContent = "确认执行"; ok.disabled = false; cancel.disabled = false;
							return;
						}
						msg.textContent = "✓ " + (r.summary || "已执行");
						ok.textContent = "已执行";
						setTimeout(close, 2500);
						if (bus && typeof bus.refreshSoon === "function") { try { await bus.refreshSoon(); } catch { /* 刷新失败不影响已执行事实 */ } }
					} catch (e) {
						msg.textContent = "✗ " + String(e && e.message ? e.message : e);
						ok.textContent = "确认执行"; ok.disabled = false; cancel.disabled = false;
					}
				});
			};

			const load = async (extra, note) => {
				box.textContent = "";
				box.appendChild(el("div", "bp-mod-meta", "预览中…（服务端只算不做，零写操作）"));
				try {
					const pv = await p1Post({ actionId: spec.actionId, params: spec.paramsFor(extra), actor: "owner-panel" });
					if (pv.ok === false) {
						box.textContent = "";
						box.appendChild(el("div", "bp-mod-ask", "✗ " + (pv.message || pv.code || "预览被拒")));
						const cancel = el("button", "bp-act", "关闭");
						cancel.addEventListener("click", close);
						box.appendChild(cancel);
						return;
					}
					render(pv, extra, note);
				} catch (e) {
					box.textContent = "";
					box.appendChild(el("div", "bp-mod-ask", "✗ " + String(e && e.message ? e.message : e)));
					const cancel = el("button", "bp-act", "关闭");
					cancel.addEventListener("click", close);
					box.appendChild(cancel);
				}
			};
			await load(null, null);
		}

		/**
		 * 改期按钮：看板的定时**只有"重复 cron"一种语义**（没有"单次改到某日"）⇒ 先让主人从
		 * 常用预设里选一个（不提供自由输入：写错 cron 会被看板拒绝，弹一屏报错不划算），
		 * 选定后才走标准的「预览 → 确认」。
		 */
		function rescheduleBtn(t, bus) {
			const CYCLE = [["每天 09:00", "0 9 * * *"], ["每天 20:00", "0 20 * * *"], ["工作日 09:00", "0 9 * * 1-5"], ["每周一 09:00", "0 9 * * 1"]];
			const btn = el("button", "bp-act", "改期");
			btn.title = "改这张卡的重复定时（看板只有「重复 cron」一种语义，没有「单次改到某日」）";
			btn.addEventListener("click", () => {
				if (btn.__ps && btn.__ps.isConnected) { btn.__ps.remove(); btn.__ps = null; return; }
				const row = btn.closest(".bp-row") || btn.parentElement;
				const box = el("div", "bp-mod-confirm");
				btn.__ps = box;
				box.appendChild(el("div", "bp-mod-ask", "把「" + t.title + "」的**重复定时**改成（当前 " + t.schedule + "）："));
				const btns = el("div", "bp-mod-btns");
				for (const [label, cron] of CYCLE) {
					const b = el("button", "bp-act", label);
					b.addEventListener("click", () => {
						box.remove(); btn.__ps = null;
						btn.__p1 = { actionId: "card-reschedule", paramsFor: () => ({ taskId: t.id, cron }), opts: {} };
						openActionPanel(btn, bus);
					});
					btns.appendChild(b);
				}
				const cancel = el("button", "bp-act", "取消");
				cancel.addEventListener("click", () => { box.remove(); btn.__ps = null; });
				btns.appendChild(cancel);
				box.appendChild(btns);
				row.after(box);
			});
			return btn;
		}

		function taskRowEl(t, bus, { canIgnore = true } = {}) {
			const row = el("div", "bp-row");
			const dot = t.overdue ? "bp-dot-yellow" : (t.status === "running" ? "bp-dot-green" : "bp-dot-gray");
			row.appendChild(el("span", "bp-dot " + dot));
			const main = el("div", "bp-main");
			main.appendChild(el("div", "bp-name", t.title));
			const metas = ["更新于 " + fmtAgo(t.updatedAt)];
			if (t.overdueDays) metas.push("挂起 " + t.overdueDays + " 天未动");
			if (t.schedule) metas.push("定时 " + t.schedule);
			main.appendChild(el("div", "bp-meta", metas.join(" · ")));
			row.appendChild(main);
			// 【P1】动作按钮就长在"问题行"旁边（方案 §4 P1 形态）：挂起 3 天 → 催办；有定时 → 改期。
			//   按钮只在**前端可判的显示条件**成立时出现（真正的前置检查在服务端 dry-run 里做）——
			//   前端判错了也只是点开看到一句拒绝，不会写错东西。
			const p1acts = el("div", "bp-acts");
			if (t.overdue && (t.status === "todo" || t.status === "backlog")) {
				p1acts.appendChild(actionBtn("催办", "card-nudge", () => ({ taskId: t.id }), bus, {
					title: "给这张卡追加一条催办备注（不改状态、不打扰任何人；⚠️ 会刷新更新时间 ⇒ 3 天计时重置）"
				}));
			}
			if (t.schedule) p1acts.appendChild(rescheduleBtn(t, bus));
			if (p1acts.childNodes.length) row.appendChild(p1acts);
			if (canIgnore) {
				const ign = el("button", "bp-act warn", "忽略");
				ign.title = "不再在管家提醒中显示该卡（可去任务看板正常管理）";
				ign.addEventListener("click", async () => {
					ign.disabled = true;
					ign.textContent = "忽略中…";
					try {
						await apiFetch("/api/dsh-butler/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "task", id: t.id, ignore: true }) });
						bus.ignoreTask(t);
					} catch (e) {
						ign.disabled = false;
						ign.textContent = "失败";
						ign.title = String(e?.message ?? e);
					}
				});
				row.appendChild(ign);
			}
			return row;
		}
		/**
		 * 🧾 待清账主线（P3 · 2026-09-15 卡 9bde0f9e）：只读展示 P0 判定引擎的结果。
		 *   · 判据不在前端算 —— 服务端 cleanup 片复用 butler lib 的 evaluateBoard()；
		 *   · 命令文案同样由服务端复用 P0 的 formatItemBrief/formatCommandLines（**不做第二份真相**）；
		 *   · 面板只展示，不改档位、不写台账、不发通知（写动作仍只在 queue tick 与 CLI）。
		 */
		function buildCleanupBlock(st, bus) {
			const zone = el("div");
			const c = st?.cleanup;
			if (!c) {
				zone.appendChild(unknownLine("待清账主线：cleanup 片未随本次请求返回（无数据源）"));
				return zone;
			}
			if (c.ok !== true) {
				zone.appendChild(unknownLine("待清账主线不可探测：" + (c.reason ?? "原因未知")));
				return zone;
			}
			const items = c.items ?? [];
			zone.appendChild(groupTitle("🧾 待清账主线（在板卡全部完成 · 只提示不自动归档）（" + items.length + "）"));
			// K5（2026-09-28）：观测项一行 —— 在板卡数 + 在板体积 + 整线归档建议（只读提示，非告警）
			if (c.inBoard && c.inBoard.ok !== false) {
				const ib = c.inBoard;
				const mark = (b) => (b === true ? "✅" : b === false ? "❌" : "？");
				const kb = (n) => (typeof n === "number" ? n + " B（" + (n / 1024).toFixed(1) + " KB）" : "n/a");
				const sg = ib.suggestion ?? {};
				zone.appendChild(el("div", "bp-note",
					"在板 " + (ib.cards ?? "n/a") + " 张 · 主账本 " + kb(ib.ledgerBytes) +
					" · J1 相对项 " + mark(ib.relOk) + " / 绝对项 " + mark(ib.absOk) +
					" · 整线归档建议：口径上可归档 " + (sg.eligibleLines ?? 0) + " 条 / " + (sg.eligibleCards ?? 0) + " 张" +
					"（只读提示，不自动执行；判据 = docs\\看板瘦身与归档物理化-方案-20260924.md §5 J1）"));
			}
			if (items.length === 0) {
				const eligible = c.counts?.eligibleLines ?? 0;
				zone.appendChild(el("div", "bp-note", "目前没有待清账的主线" +
					(eligible > 0 ? "（在板全完成的线 " + eligible + " 条仍在成熟期/冷却期/基线静默中）" : "") + "。"));
			}
			for (const it of items) {
				const row = el("div", "bp-pend");
				const top = el("div", "bp-pend-top");
				top.appendChild(UI.badge({ text: "🧾", tone: "yellow", variant: "outline" }));
				const main = el("div", "bp-main");
				main.appendChild(el("div", "bp-name", String(it.brief ?? it.line ?? "")));
				main.appendChild(el("div", "bp-meta", "在板 " + it.live + " 张全部完成" +
					((it.archivedCount ?? 0) > 0 ? " · 另有归档 " + it.archivedCount + " 张" : "") +
					(it.lastActivity ? " · 最后活动 " + fmtAgo(it.lastActivity) : "")));
				top.appendChild(main);
				row.appendChild(top);
				const acts = el("div", "bp-acts");
				const cp = el("button", "bp-act", "复制命令");
				cp.addEventListener("click", () => {
					const cmd = String((it.commands ?? [])[0] ?? "").replace(/^dry-run：/, "");
					if (navigator.clipboard) navigator.clipboard.writeText(cmd).catch(() => {});
					cp.textContent = "已复制";
					setTimeout(() => { cp.textContent = "复制命令"; }, 1500);
				});
				acts.appendChild(cp);
				const ev = el("button", "bp-act", "证据");
				acts.appendChild(ev);
				row.appendChild(acts);
				const evBox = el("div", "bp-ev");
				evBox.style.display = "none";
				evBox.textContent = [
					"来源：butler board-cleanup（唯一权威源 = lib\\board-cleanup.mjs#evaluateBoard）",
					"主线：" + String(it.line ?? "(无)"),
					"在板卡：" + it.live + " 张 · id " + (it.cardIds ?? []).join(", "),
					"最后活动：" + (it.lastActivity ? new Date(it.lastActivity).toISOString() : "未知"),
					...((it.commands ?? []).map((x) => String(x))),
					"口径：在板卡全部 done 才算；多卡线立即提示，单卡线需成熟期；线级冷却；只提示不自动归档",
					"人工出口：<大管家目录>/butler-board-cleanup.mjs --dismiss/--reopen/--status",
				].join("\n");
				ev.addEventListener("click", () => { evBox.style.display = evBox.style.display === "none" ? "" : "none"; });
				row.appendChild(evBox);
				zone.appendChild(row);
			}
			const bits = [];
			if ((c.stale ?? []).length > 0) bits.push("第三态 " + c.stale.length + " 条（" + c.stale.map((x) => x.line).join(" / ") + "）");
			if ((c.suppressed ?? []).length > 0) bits.push("冷却中 " + c.suppressed.length + " 条");
			if (c.counts) bits.push("看板 " + c.counts.tasks + " 卡（归档 " + c.counts.archivedCards + "）· 线 " + c.counts.lines + " 条");
			bits.push("档位 " + (c.mode ?? "?") + " · 评估于 " + (c.lastCheckAt ? new Date(c.lastCheckAt).toLocaleString("zh-CN", { hour12: false }) : "未知"));
			zone.appendChild(el("div", "bp-note", bits.join(" · ") + " · 本卡只读，不自动归档"));
			return zone;
		}
		function buildTasks(st, bus) {
			const zone = el("div");
			zone.appendChild(buildCleanupBlock(st, bus));
			const t = st?.tasks ?? {};
			const sections = [
				["running", "▶ 进行中（Host 正在跑）", false],
				["todo", "📋 待办", true],
				["overdue", "⏰ 挂起任务（待办/待规划卡 3 天未动，可能被忘）", true],
				["backlog", "🗂 待规划", true]
			];
			let any = false;
			for (const [key, title, canIgnore] of sections) {
				const items = t[key] ?? [];
				if (items.length === 0) continue;
				any = true;
				zone.appendChild(groupTitle(title + "（" + items.length + "）"));
				for (const it of items) {
					const od = key === "overdue" && it.updatedAt ? Math.floor((Date.now() - it.updatedAt) / 86400000) : 0;
					zone.appendChild(taskRowEl({ ...it, overdue: key === "overdue", overdueDays: od }, bus, { canIgnore }));
				}
			}
			if (!any) {
				const empty = el("div", "bp-empty", "📋 看板空空如也～没有进行中/待办/挂起/待规划的任务。");
				zone.appendChild(empty);
			}
			// 【P1】失败卡重试（方案 §4 P1 细则②）：数据源 = `tasks.recentClosed` 里 status==='failed' 的卡
			//   （近 7 天）。**成本门全在服务端**：预估 >¥1 需在确认框里确认（前端自动带 ackCost）、
			//   >¥5 服务端直接拒并建议人工开会话 —— 前端不做任何金额判断。
			const failed = (t.recentClosed || []).filter((x) => x && x.status === "failed");
			if (failed.length > 0) {
				zone.appendChild(groupTitle("❌ 最近失败的卡（近 7 天，" + failed.length + "）"));
				for (const it of failed) {
					const row = el("div", "bp-row");
					row.appendChild(el("span", "bp-dot bp-dot-red"));
					const fmain = el("div", "bp-main");
					fmain.appendChild(el("div", "bp-name", it.title));
					fmain.appendChild(el("div", "bp-meta", "失败于 " + fmtAgo(it.updatedAt) + " · 卡 " + shortId(it.id)));
					row.appendChild(fmain);
					const facts = el("div", "bp-acts");
					facts.appendChild(actionBtn("重试", "card-retry", () => ({ taskId: it.id }), bus, {
						warn: true,
						title: "重新跑这张卡（会新建一次执行、烧 token；预估成本 >¥1 会要求确认、>¥5 直接拒绝）"
					}));
					row.appendChild(facts);
					zone.appendChild(row);
				}
			}
			zone.appendChild(el("div", "bp-note", "完整管理（改内容/拖列/定时/删除）请去「任务看板」。忽略只影响管家提醒，不动看板数据。"));
			return zone;
		}
		/**
		 * 变更流水归一化（2026-09-15 修复「变更」Tab 恒显示"尚未建立"）。
		 *
		 * 病根：V2-D 分片瘦身后，变更流水数据由 **feed 片**承载 ——
		 *   分片路径（首屏 `?parts=core,metrics,feed`）：`st.feed = {ok,file,mtime,changedToday,today:{items:[{time,main,meta:string}],truncated,total}}`
		 *   全量路径（无参）：`st.changelog = {ok,file,mtime,changedToday,items:[{type:'day'|'entry'|'note'},…]}`
		 * 而旧代码只读 `st.changelog` ⇒ 分片路径下恒判空（且 `TAB_PARTS` 无 changelog 条目 ⇒ 进 Tab 也不会补拉）。
		 * 修法：两条路径归一化成同一渲染输入；`meta` 兼容 字符串 / 数组 两种形态。
		 */
		function normalizeChangelog(st) {
			const f = st?.feed;
			if (f && f.ok !== false && (f.today?.items?.length ?? 0) > 0) {
				return {
					file: f.file, mtime: f.mtime, changedToday: !!f.changedToday,
					items: (f.today.items ?? []).map((it) => ({
						type: "entry",
						time: it.time,
						main: it.main,
						meta: it.meta ? (Array.isArray(it.meta) ? it.meta : [it.meta]) : [],
						extra: it.extra ?? []
					})),
					truncated: !!f.today?.truncated,
					total: f.today?.total ?? null,
					source: "feed"
				};
			}
			const c = st?.changelog;
			if (c?.ok && (c.items?.length ?? 0) > 0) {
				return {
					file: c.file, mtime: c.mtime, changedToday: !!c.changedToday,
					items: (c.items ?? []).map((it) => (it.type === "entry"
						? { ...it, meta: it.meta ? (Array.isArray(it.meta) ? it.meta : [it.meta]) : [] }
						: it)),
					truncated: false,
					total: null,
					source: "full"
				};
			}
			return null;
		}

		// 变更 Tab（v1.4 从档案页拆出；逐行卡片式渲染，替代一大坨等宽 code）
		function buildChangelog(st) {
			const zone = el("div");
			const c = normalizeChangelog(st);
			if (!c || !c.items.length) {
				zone.appendChild(el("div", "bp-empty", "📝 变更流水尚未建立（docs\\变更流水\\ 为空或不可读）。"));
				return zone;
			}
			zone.appendChild(groupTitle("📝 变更流水 · " + c.file));
			const n = new Date();
			const today = String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0");
			for (const it of c.items ?? []) {
				if (it.type === "day") {
					const head = el("div", "bp-cl-day", it.date);
					if (it.date === today) head.appendChild(el("span", "today", "· 今天"));
					zone.appendChild(head);
				} else if (it.type === "entry") {
					const box = el("div", "bp-cl-item");
					const top = el("div", "bp-cl-top");
					top.appendChild(el("span", "bp-cl-time", it.time));
					top.appendChild(el("div", "bp-cl-main", it.main || "（无描述）"));
					box.appendChild(top);
					if ((it.meta ?? []).length > 0) {
						const meta = el("div", "bp-cl-meta");
						meta.textContent = "｜ " + it.meta.join("\n｜ ");
						box.appendChild(meta);
					}
					// v0.2.0：条目后的续行（如「↳ 12:45 …」）跟着条目走，倒序渲染不串位
					for (const x of it.extra ?? []) box.appendChild(el("div", "bp-cl-extra", x));
					zone.appendChild(box);
				} else {
					zone.appendChild(el("div", "bp-cl-note", it.text));
				}
			}
			const truncNote = c.truncated && c.total ? " · 今日段仅显示最近 " + c.items.length + " 条 / 共 " + c.total + " 条" : "";
			zone.appendChild(el("div", "bp-note", (c.changedToday ? "✓ 今天有记" : "今天未记") + " · 文件更新于 " + fmtAgo(c.mtime) + truncNote + "（全文：<工作区>/docs/变更流水/" + c.file + "）"));
			return zone;
		}
				function memoryRowEl(mem) {
			// 【V31-018 卡 B】折叠改由 panel-ui 的 row({expandable, detail}) 承载：
			//   预览在 main 里、全文作为 detail 也在 main 里，靠 root 的 open 类切换 —— 与历史 DOM 逐节点一致。
			const top = el("div", "bp-mem-top");
			top.appendChild(el("span", "bp-mem-id", "#" + mem.id));
			if (mem.pinned) top.appendChild(UI.badge({ text: "pinned", variant: "pin" }));
			for (const tg of mem.tags ?? []) top.appendChild(UI.badge({ text: tg, variant: "tag" }));
			top.appendChild(el("span", "bp-mem-time", mem.createdAt ? new Date(mem.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""));
			const full = el("div", "bp-mem-full", mem.text);
			return UI.row({
				cls: "bp-mem-row",
				leading: el("span", "bp-dot " + (mem.pinned ? "bp-dot-yellow" : "bp-dot-gray")),
				children: [top, el("div", "bp-mem-prev", mem.firstLine || "（空记忆）")],
				expandable: true,
				detail: full,
				onClick: () => {
					const root = full.closest(".bp-mem-row");
					if (root && root.classList.contains("open")) full.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
				},
			}).root;
		}
		// 记忆 Tab（v1.4 从档案页拆出；分页拉全量，点击展开全文）
		function buildMemory(st, bus) {
			const zone = el("div");
			if (st?.memory?.ok === false) {
				zone.appendChild(el("div", "bp-empty", "🧠 记忆库不可读：" + (st.memory.error ?? "未知错误")));
				return zone;
			}
			const m = bus?.memLoaded ?? null;
			const needLoad = m === null || (m.items.length === 0 && !m.done && !m.loading);
			if (needLoad) {
				zone.appendChild(el("div", "bp-note", "🧠 记忆加载中…"));
				bus?.loadMemory?.();
				return zone;
			}
			if (m.items.length === 0 && m.done) {
				zone.appendChild(el("div", "bp-empty", "🧠 记忆库空空的，还没有记忆沉淀。"));
				return zone;
			}
			zone.appendChild(groupTitle("🧠 记忆库 · 共 " + m.total + " 条 · pinned " + m.pinned + "（点任意一条展开全文）"));
			for (const item of m.items) zone.appendChild(memoryRowEl(item));
			if (m.err) zone.appendChild(el("div", "bp-err", "加载出错：" + m.err));
			if (!m.done) {
				const foot = el("div", "bp-mem-foot");
				const more = el("button", "bp-btn", "加载更多（已显示 " + m.items.length + " / " + m.total + "）");
				if (m.loading) { more.disabled = true; more.textContent = "加载中…"; }
				more.addEventListener("click", () => bus?.loadMemory?.());
				foot.appendChild(more);
				zone.appendChild(foot);
			} else {
				zone.appendChild(el("div", "bp-note", "✓ 已全部加载（共 " + m.total + " 条）。记忆全文管理/导出：memory_search 与 <工作区>/tools/memory-db-tools/。"));
			}
			return zone;
		}
		// 报告 Tab（v1.4 从档案页拆出：日报/周报点开预览全文；P6 会望风后并入 external-*.md）
		function buildReportsOnly(st) {
			const zone = el("div");
			const r = st?.reports;
			if (!r?.ok || ((r.dailies?.length ?? 0) === 0 && (r.weeklies?.length ?? 0) === 0 && (r.externals?.length ?? 0) === 0)) {
				zone.appendChild(el("div", "bp-empty", "🗓 报告档案还空着——日报每日 09:00、周报每周一 09:05 自动生成于 docs\\管家报告（P6 外部信号报告在有事件时追加）。"));
				return zone;
			}
			const grid = el("div", "bp-report-grid");
			const list = el("div", "bp-report-list");
			const preview = el("div", "bp-preview");
			preview.appendChild(el("div", "bp-meta", "选择左侧报告查看全文…"));
			const items = [
				["🗓 周报", r.weeklies ?? []],
				["📅 日报", r.dailies ?? []],
				["🌐 外部信号（P6）", r.externals ?? []]
			];
			const KIND_LABEL = { weekly: "本周报", daily: "日报", external: "外部信号" };
			const select = async (name) => {
				preview.replaceChildren(el("div", "bp-meta", "加载 " + name + " …"));
				try {
					const d = await apiFetch("/api/dsh-butler/report?file=" + encodeURIComponent(name));
					preview.replaceChildren(el("div", "bp-code", d.text ?? "(空)"));
				} catch (e) {
					preview.replaceChildren(el("div", "bp-err", "加载失败：" + (e?.message ?? e)));
				}
			};
			for (const [head, arr] of items) {
				if (arr.length === 0) continue;
				list.appendChild(el("div", "bp-rep-head", head + "（" + arr.length + "）"));
				for (const f of arr) {
					const btn = el("button", "bp-rep-row", "");
					const d = el("span", "d", f.date);
					btn.appendChild(d);
					btn.appendChild(document.createTextNode("  " + (KIND_LABEL[f.kind] ?? "报告")));
					btn.addEventListener("click", () => {
						for (const b of list.querySelectorAll(".bp-rep-row")) b.classList.remove("bp-on");
						btn.classList.add("bp-on");
						select(f.name);
					});
					list.appendChild(btn);
				}
			}
			grid.appendChild(list);
			grid.appendChild(preview);
			zone.appendChild(grid);
			const latest = (r.dailies?.[0] ?? r.weeklies?.[0] ?? r.externals?.[0]);
			if (latest) setTimeout(() => select(latest.name), 0);
			return zone;
		}
		//#endregion
		//#region mountPanel（v1.1）
		function mountPanel(onDismiss) {
			const overlay = el("div");
			overlay.setAttribute(PANEL_ATTR, "");
			const card = el("div", "bp-card");
			const head = el("div", "bp-head");
			const titleBox = el("div");
			titleBox.appendChild(el("div", "bp-title", "大管家总览"));
			const sub = el("div", "bp-sub", "");
			titleBox.appendChild(sub);
			head.appendChild(titleBox);
			const boardBtn = el("button", "bp-btn", "去任务看板");
			const refreshBtn = el("button", "bp-btn", "刷新");
			const closeBtn = el("button", "bp-btn", "关闭");
			head.appendChild(boardBtn);
			head.appendChild(refreshBtn);
			head.appendChild(closeBtn);
			card.appendChild(head);
			// 【卡「冲刺600 · audit-off 限时」】顶栏常驻横幅：紧贴 bp-head 之下、Tab 之上（面板一打开就看得见，
			//   不受"进哪个 Tab"影响）。数据自己拉（GET /audit-off），不依赖 audit 片是否已加载。
			const auditBanner = buildAuditBanner();
			card.appendChild(auditBanner.node);
			// Tab 栏（v1.4 档案拆三页；**V2-C：7 → 8** —— 去掉「📜 契约」（并入「🐋 管家」），
			//   新增「📦 资产」「🐋 管家」两个长尾块的新家。Tab 集合断言见 _test/test-v2c-tabs.mjs）
			const tabs = el("div", "bp-tabs");
			const tabDefs = [
				["overview", "📊 总览"],
				["sessions", "💬 会话"],
				["tasks", "📋 任务"],
				["changelog", "📝 变更"],
				["memory", "🧠 记忆"],
				["reports", "🗓 报告"],
				["assets", "📦 资产"],
				["steward", "🐋 管家"]
			];
			const tabBtns = {};
			for (const [key, label] of tabDefs) {
				const b = el("button", "bp-tab", label);
				b.addEventListener("click", () => switchTab(key));
				tabBtns[key] = b;
				tabs.appendChild(b);
			}
			card.appendChild(tabs);
			const body = el("div", "bp-body");
			card.appendChild(body);
			const errRow = el("div", "bp-err");
			errRow.style.display = "none";
			body.appendChild(errRow);
			const zones = {};
			for (const [key] of tabDefs) {
				const z = el("div");
				z.style.display = "none";
				body.appendChild(z);
				zones[key] = z;
			}
			overlay.appendChild(card);
			// 状态
			let state = null;
			let currentTab = "overview";
			// v0.6.0（规则 R4「开关是活的」）：模块级熔断开关数据（独立端点 GET /modules；失败降级不拖垮面板）
			let modules = null;
			// 【V2-B】首屏视图态（骨架 / 耗时 / 缓存命中 / 连续退化）—— **必须声明在 renderZone 之前**
			//（renderZone 在总览分支里读它；放后面会撞 TDZ → 面板打不开，v1.1 的 bus/fireClose 同款坑）
			const view = {
				skeleton: false, fromCache: false, cacheAt: null,
				elapsedMs: null, cacheHit: null, lastMs: null,
				degraded: 0, coldSeconds: COLD_MS_DEFAULT / 1000,
				// 【V3-A2】指标片已移出首屏 ⇒ 首屏先出占位态，片到手后回填（三态：采集中 / 到手 / 拉取失败）
				metricsPending: false, metricsError: null, metricsMs: null,
			};
			// 【V2-C】按需拉取的片加载器 + 每 Tab 视图态（加载中 / 错误 / 实拉字节 / 契约是否点开）
			//   ① loader 管"同片只发一次 + TTL 内不重发 + 串行 + 在飞合并"；
			//   ② tabPull 只是**呈现态**（不参与去重判定，判定唯一源 = loader 的 isFresh）。
			const tabPull = {};
			const tabVal = (key) => {
				if (!tabPull[key]) tabPull[key] = { loading: false, error: null, pulling: [], pulled: [], ms: null, contractOpen: false, contractLoading: false };
				return tabPull[key];
			};
			/** 片数据合并进 state（meta 只做浅合并 + asOf 逐源合并，不覆盖已有 asOf）。 */
			const absorbShard = (name, data) => {
				if (!state || !data || typeof data !== "object") return;
				for (const [k, v] of Object.entries(data)) {
					if (k === "meta") continue;
					state[k] = v;
				}
				if (data.meta) {
					state.meta = {
						...state.meta, ...data.meta,
						asOf: { ...(state.meta?.asOf ?? {}), ...(data.meta.asOf ?? {}) }
					};
				}
			};
			const shards = createShardLoader({
				fetchPart: async (name) => {
					const r = await apiFetchMetered(API + "?parts=" + encodeURIComponent(name));
					return { data: r.data, bytes: r.bytes };
				},
				absorb: absorbShard
			});
			/**
			 * 进 Tab 才拉：只拉这个 Tab 需要的、且 loader 判定**不新鲜**的片。
			 *   失败 → 该 Tab 顶部错误条 + 重试（其它区不受影响）；成功 → 若仍在该 Tab 则重绘。
			 *   契约片例外：只有 `contractOpen`（点了「展开契约全文」）才进名单。
			 */
			const ensureTab = async (key) => {
				const names = key === "steward" ? stewardShardNames(tabVal(key).contractOpen) : (TAB_PARTS[key] ?? []).slice();
				const v2c = tabVal(key);
				const want = shards.missing(names);
				if (key === "steward" && modules === null) {
					// /modules 是独立端点（不是片）：走 loader 的**同一条串行队列**，不与片请求并发
					try { await shards.enqueue(() => loadModules()); } catch { /* loadModules 自带降级对象，不抛 */ }
					if (currentTab === key) renderZone(key);
				}
				if (want.length === 0) { v2c.loading = false; v2c.pulling = []; return; }
				v2c.loading = true; v2c.error = null; v2c.pulling = want;
				if (want.includes("contract")) v2c.contractLoading = true;
				if (currentTab === key) renderZone(key);
				const t0 = Date.now();
				const r = await shards.need(names);
				v2c.pulled = r.pulled;
				v2c.ms = Date.now() - t0;
				v2c.error = r.errors.length ? r.errors.map((x) => x.name + "：" + x.error).join("；") : null;
				v2c.loading = false; v2c.pulling = []; v2c.contractLoading = false;
				if (currentTab === key) renderZone(key);
			};
			const loadModules = async () => {
				try {
					modules = await apiFetch("/api/dsh-butler/modules");
				} catch (e) {
					modules = { ok: false, error: String(e && e.message ? e.message : e), level: "unknown", modules: [] };
				}
				return modules;
			};
			// 注意：onKey/fireClose 必须先于 bus 定义（bus 在对象字面量里立即求值引用 fireClose，
			// 若后定义会撞 TDZ 抛 ReferenceError → mountPanel 崩、面板打不开（v1.1 首个线上 bug）。
			const onKey = (e) => { if (e.key === "Escape") fireClose(); };
			const fireClose = () => {
				document.removeEventListener("keydown", onKey);
				try { auditBanner.dispose(); } catch { /* 清理失败不影响关面板 */ }
				overlay.remove();
				onDismiss?.();
			};
			// 本次打开内忽略撤销表（刷新后服务端已过滤，撤销仅对本次生效）
			const undone = { sessions: [], tasks: [] };
			const bus = {
				closePanel: fireClose,
				// 【卡「audit-off 限时」】管家 Tab 里切换了暂停开关 ⇒ 立刻让顶栏横幅对齐（不等它的 60s 轮询）
				refreshAuditBanner: () => { void auditBanner.refresh(); },
				// 【V2-B】ack / 标误报成功后重拉首屏（写口已 invalidate 服务端分片缓存 → 立刻能看到变化）
				refreshSoon: () => { refresh(); },
				goBoard: () => { openBoard(); },
				switchTab: (k) => switchTab(k),
				reloadModules: async () => { await loadModules(); render(); },
				// 【V2-C】进 Tab 才拉的三个交互入口：重试失败的分片 / 点开契约全文（127 KB 一次性）
				retryTab: (k) => { const v = tabVal(k); v.error = null; void ensureTab(k); },
				openContract: () => { tabVal("steward").contractOpen = true; if (currentTab === "steward") renderZone("steward"); void ensureTab("steward"); },
				memLoaded: null,
				loadMemory: () => loadMemory(),
				ignoreSession: (s) => {
					undone.sessions.unshift(s);
					if (state) {
						state.sessions.interrupted = (state.sessions.interrupted ?? []).filter((x) => x.id !== s.id);
						state.summary.interrupted = state.sessions.interrupted.length;
					}
					render();
				},
				ignoreTask: (t) => {
					undone.tasks.unshift(t);
					if (state) {
						for (const k of ["running", "todo", "backlog", "overdue"]) {
							state.tasks[k] = (state.tasks[k] ?? []).filter((x) => x.id !== t.id);
						}
						state.summary.todo = (state.tasks.todo ?? []).length;
						state.summary.backlog = (state.tasks.backlog ?? []).length;
						state.summary.overdue = (state.tasks.overdue ?? []).length;
					}
					render();
				}
			};
			// v1.4 记忆 Tab 分页加载（60/页；bus.memLoaded 累积，完成后若仍停在记忆页则重绘）
			const loadMemory = async () => {
				if (bus.memLoaded === null) bus.memLoaded = { total: 0, pinned: 0, items: [], done: false, loading: false, err: "" };
				const m = bus.memLoaded;
				if (m.loading || m.done) return;
				m.loading = true;
				try {
					const d = await apiFetch("/api/dsh-butler/memories?limit=60&offset=" + m.items.length);
					m.total = d?.total ?? 0;
					m.pinned = d?.pinned ?? 0;
					m.items = (m.items ?? []).concat(d?.items ?? []);
					m.done = m.items.length >= m.total;
					m.err = "";
				} catch (e) {
					m.err = String(e?.message ?? e);
				}
				m.loading = false;
				if (currentTab === "memory") renderZone("memory");
			};
			const switchTab = (key) => {
				// 目标 Tab 不存在 → 明确提示，绝不切到空页（V2-C 后 8 个 Tab 全部落地，
				//   此分支只剩"未来新增 key 但按钮没加"的兜底；静默无反应才是坑）。
				if (!tabBtns[key]) {
					errRow.textContent = "「" + (TAB_NAMES[key] ?? key) + "」Tab 不存在（当前 Tab 集合见 _test/test-v2c-tabs.mjs 的 8 项断言）；仍在「" + (TAB_NAMES[currentTab] ?? currentTab) + "」";
					errRow.style.display = "";
					if (switchTab._t) clearTimeout(switchTab._t);
					switchTab._t = setTimeout(() => { errRow.style.display = "none"; }, 4000);
					return;
				}
				currentTab = key;
				for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle("bp-on", k === key);
				render();
			};
			const subText = () => {
				const parts = [];
				if (state?.meta?.generatedAt) parts.push("生成于 " + new Date(state.meta.generatedAt).toLocaleTimeString());
				const ig = state?.meta?.ignored;
				if (ig && (ig.sessions || ig.tasks)) parts.push("已忽略 " + ig.sessions + " 会话 / " + ig.tasks + " 卡");
				if (undone.sessions.length || undone.tasks.length) parts.push("本次撤销可用：" + undone.sessions.length + " 会话 / " + undone.tasks.length + " 卡");
				return parts.join(" · ");
			};
			const renderUndoBar = () => {
				const holder = el("div");
				if (undone.sessions.length || undone.tasks.length) {
					const line = el("div", "bp-note", "↩ 已忽略（本次可撤销）：");
					const undo = el("button", "bp-act", "");
					const labels = [];
					if (undone.sessions.length) labels.push("会话 " + shortId(undone.sessions[0].fullId ?? undone.sessions[0].id));
					if (undone.tasks.length) labels.push("卡 " + shortId(undone.tasks[0].id));
					undo.textContent = "撤销 " + labels.join("、");
					undo.addEventListener("click", async () => {
						const t = undone.tasks.shift() ?? null;
						if (t) {
							try { await apiFetch("/api/dsh-butler/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "task", id: t.id, ignore: false }) }); } catch { undone.tasks.unshift(t); }
						} else {
							const s = undone.sessions.shift();
							if (s) {
								try { await apiFetch("/api/dsh-butler/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "session", id: s.id, ignore: false }) }); } catch { undone.sessions.unshift(s); }
							}
						}
						refresh();
					});
					line.appendChild(undo);
					holder.appendChild(line);
				}
				return holder;
			};
			const renderZone = (key) => {
				const z = zones[key];
				if (!z) return;
				z.replaceChildren();
				// 【V2-D】总览 = 六指标 + **三块**（①②③，健康底栏由原⑤顺位）；长尾块**一个节点都不建**（V2-C 搬进新 Tab），
				//   原块 3/4（资产总览 / 今日动态）已移出首屏（明细在「资产」「变更」Tab）。
				//   state 还没到手时按骨架屏渲染（冷启动"采集中（首次约 N 秒）"），不空白。
				if (key === "overview") {
					if (!state) { if (view.skeleton) z.appendChild(skeletonFirstScreen(view)); return; }
					z.appendChild(buildFirstScreen(state, bus, view));
					return;
				}
				if (!state) return;
				// 【V2-C】Tab 分区：契约 Tab 已并入「管家」；资产/管家 = 长尾块的新家（数据按需拉）
				if (key === "sessions") {
					z.appendChild(buildSessions(state, bus));
					z.appendChild(renderUndoBar());
				} else if (key === "tasks") {
					z.appendChild(buildTasks(state, bus));
					z.appendChild(renderUndoBar());
				} else if (key === "changelog") z.appendChild(buildChangelog(state, bus));
				else if (key === "memory") z.appendChild(buildMemory(state, bus));
				else if (key === "reports") z.appendChild(buildReportsOnly(state, bus));
				else if (key === "assets") z.appendChild(buildAssetsTab(state, bus, tabVal("assets")));
				else if (key === "steward") z.appendChild(buildStewardTab(state, bus, modules, tabVal("steward")));
			};
			// 【V2-B】首屏视图态（不塞进 state）：骨架 / 耗时 / 缓存命中 / 连续退化
			const readStats = () => { try { return JSON.parse(localStorage.getItem(LS_STATS) ?? "{}") ?? {}; } catch { return {}; } };
			const writeStats = (o) => { try { localStorage.setItem(LS_STATS, JSON.stringify(o)); } catch { /* 隐私模式等：静默降级 */ } };
			const readCache = () => {
				try {
					const j = JSON.parse(localStorage.getItem(LS_CACHE) ?? "null");
					return (j && j.payload && typeof j.at === "number") ? j : null;
				} catch { return null; }
			};
			const writeCache = (payload) => {
				try { localStorage.setItem(LS_CACHE, JSON.stringify({ at: Date.now(), payload })); }
				catch { /* 超配额：缓存只是加速，丢了不影响正确性 */ }
			};
			const applyPayload = (data, ms) => {
				state = data;
				// 【V2-D】首屏片（core/metrics/feed 三片）已在手 → 给 loader 种子：
				//   ⚠️ `assets` **不 seed**（首屏已不请求它）——进「资产」Tab 时它会真发一次请求；
				//   误 seed 会让资产 Tab 拿到「判定为新鲜但 state 里没有」的片 → 明细恒空。
				// 【V3-A2】首屏只剩 core/feed 两片；`metrics` 已移出首屏（异步后补）⇒ **不 seed**
				//   （误 seed 会让 loader 判"新鲜"却不发请求 ⇒ 指标区永远停在占位态）。
				shards.seed(["core", "feed"]);
				const cache = data?.meta?.cache ?? null;
				const computeMs = cache && typeof cache.computeMs === "number" ? cache.computeMs : ms;
				const coldSlow = cache ? (cache.hit !== true && computeMs > SLOW_MS) : ms > SLOW_MS;
				view.elapsedMs = ms;
				view.cacheHit = cache ? cache.hit === true : null;
				view.lastMs = computeMs;
				view.fromCache = false;
				const stats = readStats();
				let degraded = Number(stats.degraded ?? 0) || 0;
				degraded = coldSlow ? degraded + 1 : 0;
				if (coldSlow && computeMs > (Number(stats.lastColdMs) || 0)) stats.lastColdMs = computeMs;
				stats.degraded = degraded;
				writeStats(stats);
				view.degraded = degraded;
				view.coldSeconds = (Number(stats.lastColdMs) || COLD_MS_DEFAULT) / 1000;
				view.skeleton = false;
				if (!cache || cache.hit !== true) writeCache(data);
				refreshBtn.textContent = "刷新 · " + (ms / 1000).toFixed(2) + "s" + (view.cacheHit ? "·缓存" : "·重算");
				refreshBtn.title = "本次请求 " + ms + " ms｜服务端：" + (cache
					? ("命中缓存=" + (cache.hit ? "是" : "否") + " / 重算 " + (cache.computeMs ?? "?") + " ms / 缓存年龄 " + Math.round((cache.ageMs ?? 0) / 1000) + " s / TTL " + Math.round((cache.ttlMs ?? 0) / 1000) + " s")
					: "无缓存元数据");
			};
			// 【V3-A2】后补装载（指标/健康两片挪出首屏后的回填入口）
			//   · 先置 view.metricsPending 并重绘 → 指标区立刻显示"采集中"占位（不空白、不冒充"不可探测"）；
			//   · 走 loader 的**同一条串行队列**（不与主界面抢连接池）；到手 → absorb 合并进 state → 重绘回填；
			//   · 失败 → view.metricsError 显式报原因（绝不静默、绝不伪造 0）；
			//   · 注：`health` 片本来就**不在**首屏组合里（只在「资产」/「管家」Tab 按需拉），本次零改动。
			const loadDeferred = async (parts) => {
				const want = (parts ?? DEFERRED_PARTS).filter((n) => !shards.isFresh(n));
				if (want.length === 0) { view.metricsPending = false; return; }
				view.metricsPending = true;
				view.metricsError = null;
				if (currentTab === "overview") renderZone("overview");
				const t0 = Date.now();
				const errors = [];
				for (const n of want) {
					try { await shards.pull(n); }
					catch (e) { errors.push(n + "：" + (e?.message ?? e)); }
				}
				view.metricsMs = Date.now() - t0;
				view.metricsPending = false;
				view.metricsError = errors.length ? errors.join("；") : null;
				if (!errors.length && state) writeCache(state);   // 合并后的完整 state 进客户端缓存（下次打开先画全量）
				if (currentTab === "overview") renderZone("overview");
				else render();
			};
			const loadFirst = async (opts) => {
				refreshBtn.disabled = true;
				if (!refreshBtn.textContent.startsWith("刷新 ·")) refreshBtn.textContent = "加载中…";
				errRow.style.display = "none";
				// 【V2-C】手动刷新 = 强制重算：连按需片的前端缓存一起失效（否则 Tab 还在用旧片）
				if (opts?.force) shards.reset();
				const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
				try {
					const data = await apiFetch(opts?.force ? (API_FIRST + "&refresh=1") : API_FIRST);
					const ms = Math.round(((typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now()) - t0);
					applyPayload(data, ms);
					bus.memLoaded = null; // 记忆分页缓存随刷新重置（重进记忆页自动重拉）
					// 【V3-A2】首屏（core,feed）已渲染 → 再去拉后补片（指标），到手后回填（不阻塞首屏）
					void loadDeferred(DEFERRED_PARTS);
					switchTab(currentTab);
				} catch (e) {
					errRow.textContent = "首屏加载失败：" + (e?.message ?? e) + "（可再点「刷新」；此前的缓存内容仍在下方，不会被清掉）";
					errRow.style.display = "";
					view.skeleton = view.skeleton && state === null;
				} finally {
					refreshBtn.disabled = false; // v1.4.1：成功分支原先没恢复按钮 → 永远卡"刷新中"（主人目测点破）
				}
			};
			const render = () => {
				sub.textContent = subText();
				if (!state) return;
				for (const key of Object.keys(zones)) {
					const z = zones[key];
					if (key !== currentTab) { z.style.display = "none"; z.replaceChildren(); continue; }
					z.style.display = "";
					renderZone(key);
				}
				// 【V2-C】渲染完当前 Tab 后检查"该拉的片拉了没"：TTL 内/已 fresh → 零请求直接返回；
				//   需要拉 → 走串行队列，完成后只重绘本 Tab（renderZone 不再回调 ensureTab，无循环）。
				void ensureTab(currentTab);
			};
			const refresh = async () => loadFirst({ force: true });
			const openBoard = () => {
				let hit = null;
				const entries = document.querySelectorAll("[data-dsh-plugin]");
				for (const e of entries) {
					const p = e.getAttribute("data-dsh-plugin") ?? "";
					if (p.includes("task-board") || p.includes("task_board")) { hit = e; break; }
				}
				if (hit === null) {
					const all = document.querySelectorAll("button");
					for (const b of all) {
						const label = (b.getAttribute("aria-label") ?? "") + (b.getAttribute("title") ?? "") + b.textContent;
						if (label.includes("任务看板")) { hit = b; break; }
					}
				}
				if (hit !== null) { try { hit.click(); } catch { /* ignore */ } }
			};
			boardBtn.addEventListener("click", openBoard);
			refreshBtn.addEventListener("click", refresh);
			closeBtn.addEventListener("click", fireClose);
			overlay.addEventListener("click", (e) => { if (e.target === overlay) fireClose(); });
			document.addEventListener("keydown", onKey);
			// 【V2-B】首屏装载（总览恒为落地页）：
			//   ① 有客户端缓存 → 先画缓存并标 asOf（SWR），后台再拉最新
			//   ② 冷启动 → 骨架屏 "采集中（首次约 N 秒）"（N = 本机真实测得，非编造）
			//   ③ 唯一首屏请求 = ?parts=core,metrics,feed（**现存三块**的数据源并集，V2-D 瘦身后）
			const prime = async () => {
				const stats = readStats();
				view.degraded = Number(stats.degraded ?? 0) || 0;
				view.coldSeconds = (Number(stats.lastColdMs) || COLD_MS_DEFAULT) / 1000;
				const cached = readCache();
				if (cached) {
					state = cached.payload;
					view.fromCache = true;
					view.cacheAt = cached.at;
					switchTab("overview");
				} else {
					view.skeleton = true;
					renderZone("overview");
				}
				await loadFirst({});
			};
			prime();
			// 面板一打开就拉一次暂停状态（横幅要"打开就准"，不能等进管家 Tab 才准）
			void auditBanner.refresh();
			const cleanup = () => {
				document.removeEventListener("keydown", onKey);
				try { auditBanner.dispose(); } catch { /* 同上 */ }
				overlay.remove();
			};
			return { root: overlay, refresh, close: fireClose, cleanup };
		}
		//#endregion
		//#region apply
		function apply(ctx) {
			ctx.effect(() => {
				injectCss();
				let panel = null;
				let active = false;
				const setActive = (v) => {
					active = v;
					const entry = document.querySelector(ENTRY_SELECTOR);
					if (entry) {
						if (v) entry.setAttribute("data-active", "true");
						else entry.removeAttribute("data-active");
					}
				};
				const onDismiss = () => {
					panel = null;
					setActive(false);
				};
				const close = () => {
					if (panel === null) return;
					const p = panel;
					p.close();
					onDismiss();
				};
				const open = () => {
					if (panel !== null) return;
					const ui = mountPanel(onDismiss);
					document.body.appendChild(ui.root);
					panel = ui;
					setActive(true);
				};
				const toggle = () => { if (panel !== null) close(); else open(); };
				const disposers = [];
				const slotMount = mountSlotEntry(ctx, toggle);
				disposers.push(slotMount.dispose);
				// 槽注册不成立（老主包 / 无 React / 无 slots 服务）才走旧的 DOM 注入 —— 两条路不并存，不会出两个按钮。
				if (!slotMount.ok) disposers.push(mountEntry(toggle, setActive));
				return () => {
					for (const d of disposers.splice(0)) { try { d(); } catch {} }
					close();
				};
			}, "butler-panel: ui");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
