# Agent Note: 按端点分路由

Status: implemented

## Problem

Aperture 是**按端点**网关的：同一个模型不是所有协议都收。探测结果里的
`supported_endpoints` 是唯一的协议依据，而 `llm-pi-ai` 的每条 provider 路由只讲
一种协议。实测（`https://ai.long-antares.ts.net/`）的分布：

| 模型 | `supported_endpoints` | 结果 |
| --- | --- | --- |
| 11 个（DeepSeek / MiMo / Grok / Qwen / LongCat …） | `/v1/chat/completions` | 走 `aperture` |
| Responses 模型 | `/v1/responses` | 走 `aperture-responses` |
| `MiniMax-M3` | `/v1/messages` | 走 `aperture-anthropic` |
| 4 个 Gemini | `/v1beta/models/{model}:generateContent` | 不发布 |

## Decision

按模型声明的端点把它分到对应的那条路由，最多三条，路由名与协议一一对应。走错端点
的失败是明确的——Aperture 直接告诉你该用哪个：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

`llm-pi-ai` 不讲 Gemini 原生协议，所以那 4 个 Gemini **列出来但不发布**。

## Alternatives considered

**只发一条 chat 路由，把别的模型也塞进去。** 走错端点不是静默降级，而是一次必然
失败的请求；用户看到的是「模型在列表里、一用就 404」，比这个模型根本不出现更难查。

**接不了就不列出来。** 报告里少一行不带任何原因，用户只会以为插件漏读了这个模型。

## Consequences

- `supported_endpoints` 缺席时按 OpenAI 兼容处理。
- 路由名可配置；改过名字之后旧键会留在 `llm-pi-ai.providers` 里
  （见[写入只碰自己拥有的键](2026-09-23-owned-write-plan.md)）。
- 要不要支持一种新协议，先看 `llm-pi-ai` 讲不讲，而不是先看网关收不收。
