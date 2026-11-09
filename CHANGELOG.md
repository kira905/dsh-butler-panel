# 变更记录

## 0.9.6 · 2026-11-09

**修面板「🛑 模块开关」卡那句判错的「常见原因」——它把两种完全不同的故障混成了一句。**

- **归因拆两句。** 原来不管什么原因都写「面板刚部署但 dsh 还没重启（GET /modules 返回 404）」。
  可现场真正常见的是另一种：`DSH_WORKSPACE` 指到了没有 `tools/dsh-butler/lib` 的目录，
  接口回的是 **200 + `Cannot find module '<路径>'`**。照原话去重启 = 白折腾一轮。
  现在：真 404 才说"没重启"；`Cannot find module` 改成「找不到 <实际那个路径>：多为工作区或大管家目录指错」，
  并把变量与实路径并排写出来（`DSH_WORKSPACE` / `BUTLER_ROOT`）+「改完需重启 DSH 才生效」。
- **兜底补第三条。** 宿主日志那行 `[butler-panel] 缺 …` 原来只给「装 engine 包」和「设 `BUTLER_ROOT`」，
  漏掉了 README 变量表里第一顺位的 `DSH_WORKSPACE`。现在三条齐了。
- **README 用词统一**：缺数据一律叫「不可探测」（与面板实际渲染一致），不再混用「不可用」。
- 只动文案与兜底数组，**采集逻辑、判定阈值一行未改**。

## 0.9.5 · 2026-11-09

**0.9.4 同日修订：客户端模块 id 也必须带 scope，否则桌面版直接起不来。**

- 0.9.4 修好了「挂载条目 name」与「require 适配层的名字」，但客户端 bundle 顶层的
  `window.__ModuleLoader__.load({ id: "dsh-butler-panel" })` 还是**不带 scope 的旧名**。
  宿主按 boot graph 的行 id（= `package.json#name`）核登记，对不上就报
  `…/@kira905/dsh-butler-panel/client.js already executed without registering
  "@kira905/dsh-butler-panel" via __ModuleLoader__`，**整个桌面版弹「应用无法启动」**。
- 真机证据：2026-11-09 06:2x 桌面版（`D:\DSH Desktop`）装完 0.9.4 启动即弹崩溃框，
  报告 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`。
- 同一个病根在本包一共三处：① `cordis.patch.yml` 的 insert `name` ② 这句客户端
  `id` ③ `require` 适配层的名字。三处全部按 **发行名（带 scope）** 对齐；此处另留注释说明。
- ⚠️ **0.9.4 请勿使用**（会让桌面版起不来）。npm 上没有 deprecate 它（按当期禁令），
  以本文与 README 为准：直接装 0.9.5。

判据：装 0.9.5 后重启桌面版 ⇒ 正常进界面、侧边栏出现「管家面板」入口、
点开有真数据（读数与 `/api/dsh-butler/state` 一致）。

## 0.9.4 · 2026-11-09

**修「装完了、侧边栏却没有管家面板，而且一个错都不报」。**

两处都是同一个病根的两面，缺一条面板都不会出现：

- **挂载条目写的是不带 scope 的旧名。** `cordis.patch.yml` 里写 `name: 'dsh-butler-panel'`，
  那是"本地手放实体"时代的名字；从注册表装进 profile 的实体叫 `@kira905/dsh-butler-panel`。
  宿主按 `name` 解析不到那一行 ⇒ **宿主半根本没挂** ⇒ 它的 `dsh.client` 也就不会被扫进
  boot graph ⇒ 侧边栏连入口都不出现，且没有任何报错（2026-11-09 A-8 关 4，真桌面版实测）。
  现在 `name` 与 `package.json#name` 逐字一致；同一处坑在 `@kira905/dsh-task-board-local`
  的 patch 里早有同文提醒。
- **客户端顶层 `require` 认死一个名字。** 过去是 `require("dsh-host-adapter-client")`，
  而注册表装来的包名带 scope（`@kira905/dsh-host-adapter-client`，boot graph 的行 id 就是
  这个 name）⇒ 找不到行、factory 顶层直接抛、整块界面消失。现在**两个名字都试**，
  真拿不到也只丢一个常量（`inject` 用同值兜底），面板照常挂 —— 绝不为一个依赖名字把整块弄没。
  `dsh.client.external` 同步列出两个名字（排序用；不存在的名字不产生边，无副作用）。

影响面：`dsh plugin --profile <p> add @kira905/dsh-butler-panel` 装完重启即能看到入口。
依赖下界同步抬到 `@kira905/dsh-host-adapter-client@^0.2.0`（那一版起自带 bundle 层，
宿主会自己把它挂上，不再需要手工跑部署命令）。

判据：`node --check lib/client.js` 通过；隔离 profile（独立 DSH_HOME + 组合列表只有
base/web-app）上装本包 + 适配层 0.2.0 ⇒ `--dump-config` 里出现 `name: '@kira905/dsh-butler-panel'`
行、boot graph 里出现两条行 id；侧边栏出现「管家面板」入口且 `/api/dsh-butler/state` 200。

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
