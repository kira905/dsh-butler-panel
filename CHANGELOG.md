# 变更记录

## 0.9.3 · 2026-11-09

**服务面降级路径说清楚：那个模块不开源，不是坏了。**

- 起因：engine 0.5.2 把 `lib/secretary-health.mjs`（外部通道健康判定件）**撤回**了 —— 它撞「通道不开源」红线。
  于是「只装包、没有私有工具目录」的机器上，`collectServiceShard` 一定会解析不到它。
- `collectServiceShard` 的降级分支改成**显式占位 + 一行可照做的指引**：
  `{ ok:false, unavailable:'module-not-shipped', reason:'该模块不开源，本功能不可用（…要接就由宿主自己提供同名模块…）' }`。
  面板 UI 本来就把 `ok:false` 渲染成「判定入口不可用 + reason」这一行，所以页面显示的是**一句人话**，
  不是报错、不是空块。**没有替身实现**：面板里不内联一份"最小健康判定"。
- 其余片一个字没改；新增的 `unavailable` 字段是加法（老的消费方读不到就忽略）。
- 判据：`node --check` 全通过；独立进程里把 engine 预设成"不含该模块"（= 开源包真实形态）后调
  `collectServiceShard` ⇒ 返回上面的降级结构、**不抛**；同一进程里把该模块放回去 ⇒ 回到 `ok:true` 渲染真结论。

## 0.9.2 · 2026-11-09

**在「没有私有工具目录」的机器上，面板也能出真数据。**

- 新增 `lib/engine-search.mjs`：只做一件事 —— 定位 `@kira905/dsh-butler-engine` 包根，并列出它里面的库目录。
  三档探测：显式 `DSH_BUTLER_ENGINE_ROOT` → Node 模块解析（`createRequire`）→ 全局 npm 前缀常见位置
  （`%APPDATA%\npm\node_modules` 等）。**为什么不止靠 `createRequire`**：engine 在装载清单里是 CLI
  类型（`npm i -g`），落在全局前缀，而面板在 `~/.dsh/profiles/web/node_modules/` —— Node 只会从面板
  所在目录向上爬，爬不到全局前缀，所以单靠模块解析在真实装载形态下必然找不到。
- `lib/butler-root.mjs` 改为**四路回落**：显式环境变量 → 工作区约定 `<工作区>/tools/dsh-butler/lib` →
  engine 包（依次试 `lib/` → `src/dsh-butler/lib/` → `src/lib/` → `jobs/lib/`）→ 占位 + 指引。
  新增导出 `butlerLibPath` / `toolLibPath` / `butlerFilePath` / `*SearchDirs` / `guidanceFor`。
- 降级话术从「不可用」改成**可照做**的一句：`缺 <模块名>：装 npm i -g @kira905/dsh-butler-engine@^<版本>，
  或设 BUTLER_ROOT=<你的大管家工具目录>`（版本号读盘上那份包的 `package.json`，没装就不带版本）。
- 把 5 处「自己拼目录」的调用点收口到上面的解析器（`shards.mjs` · `state.js` · `advice-hook.mjs` ·
  `modules-route.mjs` · `p4-learnings.mjs`），`metrics.mjs` 的探测链并入 engine 目录（仍不 import 面板业务模块）。
- 判据：隔离进程里（只装包、没有 `<工作区>/tools/dsh-butler`）面板需要的 38 个跨包模块**全部解析到真模块**；
  阴性对照（`BUTLER_ROOT` 指错 + 包不在）全部落占位且给指引；`node --check` 全通过；脱敏扫描 `待复核=0`。

## 0.9.1 · 2026-11-08

- 服务面中性化：去掉通道名与内部判定件路径，改成「外部通道健康（由宿主提供，可选）」；解析不到时显式降级。

## 0.9.0

- 开源首发（脱敏 + 根参数化）。
