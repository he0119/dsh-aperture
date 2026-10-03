# Agent Note: cosmokit 写成直接依赖

Status: implemented

## Problem

`src/config.ts` 的 `Config` 由 schemastery 的 `.volatile()` 推导，而 `.volatile()`
的结果类型是 `Schema<…, 'volatile'>`，其输出类型 `Volatile<T>` 定义在 cosmokit 里。
pnpm 的隔离布局只在 `.pnpm/` 里保留这个包，于是声明生成直接报：

```text
error TS2742: The inferred type of 'Config' cannot be named without a reference to
'.pnpm/@deepseek-ai+cosmokit@1.8.5/node_modules/@deepseek-ai/cosmokit'. A type annotation is necessary.
```

## Decision

把 `@deepseek-ai/cosmokit` 写成 devDependencies 里的**直接依赖**，版本与 schemastery
要求的 `~1.8.5` 一致，让它和其余依赖一样出现在根 `node_modules` 里。它不进
`peerDependencies`：本包运行时并不解析它，只有声明文件里会出现对它的引用。

**直接把依赖写进 package.json 还不够**：命名这个类型要看**哪一个模块在引用它**。`Config` 的
三个字典字段因此显式写成 cosmokit 的 `Dict`（`src/config.ts` 里 `import type { Dict }`），而不是
等价的 `Record<string, string>`——只在 schema 里由 `z.dict()` 推导时，声明打包仍会报同一个
TS2742。写下这个类型也让「这一项的类型来自哪里」在源码里读得出来。

## Alternatives considered

**照官方用 `'@deepseek-ai/cosmokit': 'link:vendor/cosmokit'` 钉在仓库内的固定路径
上。** 官方 DSH 这么做是因为它本来就有 vendor 目录；本仓库为这一个声明期的依赖建
一个 vendor 目录，成本比多写一行依赖大。

**给 `Config` 加类型注解绕开 TS2742。** 等于在每个导出点上手写一遍推导结果，schema
一改就过期，而且抄错的时候不会有任何东西报错。

**不用 `.volatile()`。** 那要放弃整段 volatile 的收益，见
[整段配置都是 volatile 的](../architecture/2026-09-24-whole-config-volatile.md)。

## Consequences

- devDependencies 里多一个本包**从不 import** 的包（只在声明文件里被引用），升级
  schemastery 时要跟着核对它的 `~1.8.5`。
- npm 的平铺 `node_modules` 本来就会把它提升到根目录，这条依赖只在 pnpm 的隔离
  布局下才显得多余——因此升级包管理器时要重新验证一次声明生成。
