# Agent Note: peer 范围是一条并集

Status: implemented

## Problem

0.2.0 起，组合层会在挂载前拿**每个** `@deepseek-ai/dsh-*` 的 peer 范围去比运行时
版本（`evaluatePluginCompatibility`），不满足的那一行整行被拒——界面上什么也不出现，
只有一行诊断，而 `pnpm test` 与类型检查照样全绿。

同时发布线是分开的：dsh 的 `latest` 停在 0.1.7-rc.2，0.2.0 只在 `next`。

## Decision

`peerDependencies` 声明成并集 `^0.1.7-rc.1 || ^0.2.0-rc.1`。

下界是 0.1.7：更早的宿主在预检处就被挡下，那一版起 `installSection` /
`SettingsProvider` 这套接缝已经不存在，本插件的界面代码在旧宿主上无法工作。

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
  **升级 devDependencies 而忘了跟 peer 范围**时，真机上就是整行被拒、界面安静，
  盯着这件事的只有这一份用例。
