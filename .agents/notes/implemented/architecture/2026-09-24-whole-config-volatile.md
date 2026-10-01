# Agent Note: 整段配置都是 volatile 的

Status: implemented

## Problem

0.1.7 的设置面只把 **volatile** 字段当成可以就地生效的配置。本插件的每个键都只被
下一轮刷新读取，没有哪个键改完需要重挂插件，但 schema 上必须把这件事说清楚。

## Decision

`schema.volatile()` 标在**整段** `Config` 上，而不是逐个字段。

`volatileForm()` 遇到整体 volatile 的 schema 会把整段原样交出去（`isVolatilePath()`
于是对每条路径都为真），`projectForm()` 也会投影每个声明的字段，因此「改配置 →
Loader 发 `loader/volatile-update` → 不重挂插件」这条路对每个键都成立，而设置面看到
的仍是一份有 schema、有默认值的完整表单。

代价与收益都在 Loader 那边：`equalExceptVolatile()` 判定为纯 volatile 变化时，新配置
直接生效、不重载；提交失败只记一条 `logger.warn`，旧值继续用。

volatile 只改**配置怎么被持有**，不改校验：非法值仍然在 `Config(raw)` 就抛
（`ValidationError`，带 `$.models[0].id missing required value` 这种路径），缺省值
仍然会补齐，`accepts()` 那类用例一个都不用动；只有**读值**要改成 `configValue(ref)`
（内部一句 `ref.get()`）。

## Alternatives considered

**逐个字段标 `volatile()`。** 那等于把「哪些键改完需要重挂插件」写进 schema 当成
契约；本插件每个键都只被下一轮刷新读取，重挂只会白掉一次发现，因此这个区分在这里
没有承载任何东西。

**不做 volatile，靠重载插件生效。** 每次改一个地址都要重挂插件、重新跑一轮发现，
而配置本来就是下一轮刷新的输入。

## Consequences

- 读配置的每一处都必须走 `configValue(ref)`；直接当普通值读会读到注册时的那一份。
- Loader 提交失败只留一条 `logger.warn`，旧值继续用：界面上的「已保存」不等于
  「已生效」，这一点由每轮刷新的结果承担，而不是由配置服务。
