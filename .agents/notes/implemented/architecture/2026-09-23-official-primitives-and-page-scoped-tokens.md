# Agent Note: 界面用官方原语，颜色只引用本页定义过的 token

Status: implemented

## Problem

配置页要与官方设置页逐像素一致，又要能独立改版。自画一套控件意味着抄官方的字面量，
而抄来的字面量没有任何东西守着；颜色更危险：引用一个本页没有定义的 token，
`var()` 会静默落到回落值，界面上只是「看起来有点不对」。

实测过：卡片引用官方「模型」页那张卡的配方
（`--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke`）时，在插件页
上连边都看不见——那两个名字只活在官方「模型」页自己那份组件 CSS 里，这一页根本
没有，于是 `var()` 落到回落值：白 16% 的描边画在白底上，亮色主题下等于没有。
暗色主题反而正常，这就是它一直没被发现的原因。

## Decision

控件全部来自官方原语包 `@deepseek-ai/dsh-client-ui-primitives`
（`SettingsForm` / `SettingsValueField` / `Button` / `Switch` / `Checkbox` /
`SegmentedControl` / `Tag` / `StateDot`），本仓库只补排版（分组间距、字段栅格、
事实的排法）与模型行那张卡：`border-l4` 一档发丝描边加 `--dsw-radius-xl`，编辑器
内嵌面用 `bg-layer-3` 加一圈 `border-l2`。

颜色只许引用**这一页真的定义过**的 token：Theme 检查面列出的 `--dsw-alias-*`，
加上官方原语自己引用的那几个（`bg-layer-3` / `border-l4` / `interactive-bg-hover`
等）与圆角 `--dsw-radius-*`。名单外的名字要登记进 `test/client.test.ts` 的那份
白名单并写明理由；每条 `var()` 都带中立回落值。

## Alternatives considered

**把官方控件抄进本仓库。** 与官方插件指南「不要 require 任何 Harness Client 包」
一致，但抄来的控件与配色会随官方改版过期，而且抄完就没人再对齐了。用原语的代价由
`peerDependencies` 里的 `@deepseek-ai/dsh*` 范围兜底（宿主按**运行时 dsh
版本**校验；原语包本身不走 npm 解析，没有版本可以被 peer 拦住）。

**自己维护一份颜色字面量。** 与官方改版脱钩，且深浅两套主题各要维护一遍。

## Consequences

- 官方原语包只有运行时导出、没有随包发布的类型声明，因此这一页 `require` 的是构建
  产物里的名字；拼错一个名字只会在挂载时抛一句 `undefined is not a function`，所以
  那份名单与每个原语的 prop 语义由 `test/client.test.ts` 的替身模块钉住（替身只保证
  接缝语义，官方组件的观感不在本仓库的测试范围内）。
- 亮色主题下 `bg-layer-*` 全是白色——官方那些层靠阴影分开——所以卡片只能靠描边立住，
  底色只是给暗色主题加一点抬起感。
- 界面与样式的改动要在真实 dev GUI 里量 `getComputedStyle` 的实测值，深浅两套主题
  各量一遍再下结论。
