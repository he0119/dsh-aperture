# Agent Note: 推理等级默认只给两档

Status: implemented

## Problem

`reasoningEfforts` 的等级就是实际发出去的参数值，多给一档就是多一种能被选中的
非法请求。实测：

- DeepSeek 接受 `minimal/low/medium/high/xhigh/max/none`，且默认就会返回
  `reasoning_content`，要用 `thinking: {type: disabled}` 才关得掉；
- MiMo（`mimo-v2.6-pro`）对 `minimal` / `xhigh` / `max` 直接 **HTTP 400**。

## Decision

默认只发布两档，够用且不会挑出 400：

| 模型 | `reasoningEfforts` | `compat` |
| --- | --- | --- |
| DeepSeek 系（id / name / provider 含 `deepseek`） | `{off: disabled, high: high, max: max}` | `{supportsReasoningEffort: true, thinkingFormat: deepseek}` |
| 其它会推理的模型 | `{off: null, high: high}` | `{supportsReasoningEffort: true}` |

Anthropic 路由**默认不给推理档位**：Anthropic 的 thinking 是另一套开关（要
budget），发 `reasoning_effort` 没有意义。要开就用 `thinking: true` 显式声明。

## Alternatives considered

**按网关声明把每档都发出去。** 网关报的是「这个模型支持推理」，不是「这几个字面量
都收」；MiMo 那份 400 就是这么来的。

**一档都不给。** 关不掉推理，DeepSeek 系模型会在每次请求里都带上思考过程。

**按模型名硬编码档位表。** 名字是网关起的，会变；判据落在 `deepseek` 这个词上，
比维护一张表更不容易过期。

## Consequences

- 用户想要更多档位得自己在设置文档里写 `reasoningEfforts`，插件不覆盖已有声明。
- `off` 在 DeepSeek 上是 `disabled`、在别的模型上是 `null`（即不写这个参数），
  两者语义不同，不能合并成一种。
