# Agent Note: peer 范围是一条并集

Status: implemented

## Problem

组合层会在挂载前拿插件的兼容声明去比运行时版本（`evaluatePluginCompatibility`），
不满足的那一行整行被拒——界面上什么也不出现，只有一行诊断，而 `pnpm test` 与类型
检查照样全绿。0.2.1-alpha.3 起判定顺序变了：包自己的 `engines.dsh` 单独决定，忽略 DSH
的 peer；只有缺 `engines.dsh` 时才逐包比 `@deepseek-ai/dsh-*` 的 peer 范围。

同时发布线是分开的：dsh 的 `latest` 停在 0.1.7-rc.2，0.2.0 只在 `next`。

## Decision

`engines.dsh` 与 `peerDependencies` 都声明成并集 `^0.1.7-rc.1 || ^0.2.0-rc.1`：前者是
预检实际读的那一份，后者是它的回退路径，两份必须说同一件事。预检把预发布版本算进范围
（`0.2.3-alpha.2` 落在 `^0.2.0-rc.1` 里），所以 alpha 线不必单独列出来。

2026-11-22 起支持线收窄为一条（`^0.2.3-alpha.2`），这份并集不再适用，见
[只支持一条 DSH 版本线](2026-11-22-single-supported-dsh-line.md)。

下界是 0.1.7：更早的宿主在预检处就被挡下，那一版起 `installSection` /
`SettingsProvider` 这套接缝已经不存在，本插件的界面代码在旧宿主上无法工作。

**每个本插件用到的 `@deepseek-ai/dsh*` 包都写进 peer**，`engines.dsh` 缺席时预检逐包核对
「这句话在 0.1.7 上也成立」：`test/manifest.test.ts` 因此专门清空 `engines` 再走一遍回退路径。`dsh-llm`、`dsh-attachment`、`dsh-credentials`、`dsh-timeout` 四个 LLM 侧
的接缝都核对过 0.1.7-rc.1 发布的类型，本插件用到的导出一个不少（0.2.0 新增的
`toolUpdate` / `ToolHistory` / `ACCOUNT_QUOTA_EXCEEDED_CODE` 那几项没有用到）。

## Alternatives considered

**只留 `^0.2.0-rc.1`。** 还在 `latest` 上的人一升级插件就被挡下，而他们在 0.2.0
发布之前没有别的选择。

**只留 `^0.1.7-rc.1`。** 0.2.0 的宿主会把整行拒掉：界面上什么也不出现，只有一行诊断，
而三层测试全绿。

## Consequences

- 两条线上本插件用到的接缝一致：`dsh-settings`、`dsh-typert-protocol`、
  `dsh-client-ui-renderer/client` 与 `dsh-client-ui-slots` 的产物逐字节相同；原语包
  那一版改了观感（按钮圆角、新增 `MenuSurface` 一类），但本插件引用的导出与
  `SettingsFormModel` 的草稿 / `revision` 围栏语义没动。
- 同一份源码在两条线上跑过同一套用例，0.2.0 那一版还在真宿主里量过两种主题。
- 丢掉 0.1.7 是一次有意的破坏性升级：改范围时 `test/manifest.test.ts` 会跟着红。
  **升级 devDependencies 而忘了跟 `engines.dsh` 或 peer 范围**时，真机上就是整行被拒、
  界面安静，盯着这件事的只有这一份用例。
