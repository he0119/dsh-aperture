# Agent Note: 配置页挂在包级槽位

Status: implemented

## Problem

配置页要出现在插件页里，而插件页提供两种槽位：行级 `plugins.row.config` 与包级
`plugins.bundle.config`。本插件的设置段与插件页里那一行是同一份，选错槽位会让同一
份界面出现在两个入口。

## Decision

只注册**包级**槽位 `plugins.bundle.config`，键就是包名 `dsh-aperture`；页面里只有
正文是插件的，页头（面包屑、图标、名字、`aperture` 与 `dsh-aperture` 两行代码、
那句描述）由插件页自己画。名字、图标与描述来自包元数据：`locale/*.json` 的
`meta.title` / `meta.description`（文件名就是语言 id，`readPluginMeta` 读整个目录）
与 `package.json` 的 `icon`（清单目录内的 SVG，≤256 KiB，读成 `data:` URL）。

注册只给三件事：

```js
scope.slots.inject('plugins.bundle.config', () => scope.slots.register(
  {
    name: 'plugins.bundle.config',
    key: 'dsh-aperture',
    locale: NS,
    inject: () => ({ hooks: { apertureCard: card }, panel, edit, resetField, discard, save, failed }),
  },
  AperturePanel,
))
```

**必须走 `inject`，不能直接 `register`**：这个槽位由**插件页**自己声明，那个声明
完全可能晚于本插件的 `apply`，直接注册会撞上「槽位尚未声明」。

宿主侧另用 `ctx.settings.configure({ auto: false }, ctx.fiber)` 声明「这一行自己出
页面」；这一句必须在 `ctx.effect` 里注册（`configure` 重复注册会抛）。

## Alternatives considered

**两个槽位都注册。** 同一份界面出现在两个入口，用户在行级入口改的与包级入口看到的
是同一份数据，两个入口只会让人怀疑哪一份才算数。

**用行级槽位。** 插件页里一行有「配置」按钮，是因为那一行有它自己的设置段；本插件
的设置段与那一行是同一份。

**自己画页头、或者把图标读进自己的资源。** 名字、图标与描述是包元数据，插件页已经
在读它们；再画一份就要跟插件页的改版对齐。

## Consequences

- 包级页面只有 `'page'` 一种用法：插件页只在这一处渲染它，没有行级页那种
  `'summary'` 简写，也不像行级页与条目级页那样收到页主递来的 `form`——因此
  `baseUrl` 与 `sync` 得按设置命名空间自己取（见
  [发现走 Remote，设置走表单](../architecture/2026-09-23-discovery-over-remote-settings-over-forms.md)）。
- 官方唯一一个包级配置页是 `dsh-experimental-client-ui-voice-input`，写法相同，
  可以对着它核对注册形状。
