# Agent Note: 只做发现，不做转换

Status: implemented

## Problem

Aperture 是按端点供模型的网关，而 DSH 侧已经有一套讲 OpenAI Chat Completions、
OpenAI Responses 与 Anthropic Messages 的适配器（`@deepseek-ai/dsh-llm-pi-ai`）。
参考实现 [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)
自己实现了一套 provider，本插件面对的是同一个问题：把探测到的模型接到宿主上，
要不要自己也写一层 API 适配。

## Decision

本插件不做任何 API 格式转换：它把探测结果翻译成 `llm-pi-ai` 的 provider profiles，
剩下的交给现成的适配器。

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 插件写进去的内容，不需要手写
- id: llm-pi-ai
  config:
    providers:
      aperture:
        api: openai-completions
        baseURL: https://ai.example.ts.net/v1
        models:
          - id: deepseek-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1048576
            maxTokens: 384000
```

设置命名空间就是 profile 里那一行的 `id`：`llm-pi-ai` 那一行由官方基础 profile
声明，本插件写的那一行是 `aperture`。`dsh-llm-pi-ai` 自己也是这么取命名空间的
（`ctx.fiber.entry?.options.id ?? 'llm-pi-ai'`）。

## Alternatives considered

**自己做一套 provider 实现。** 参考实现走的就是这条路，代价是要跟上三种协议的线
格式、流式语义与工具调用约定——这些 `llm-pi-ai` 已经讲过一遍，抄第二遍只会分化。

**只写 `baseURL`，不写模型目录。** 宿主不会去问网关有哪些模型：模型清单要么来自
配置、要么来自 `models.dev` 这类目录。只写地址等于让用户自己维护一份清单，而那份
清单正是本插件要发现的东西。

## Consequences

- 能接入的协议上限就是 `llm-pi-ai` 讲得了的三种；Gemini 原生端点接不了
  （见[按端点分路由](2026-09-23-endpoint-keyed-routes.md)）。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）：
  `llm-pi-ai` 已经认领了那件事，重复注册会抛错。
- `llm-pi-ai` 的 provider 形状一变，本插件的发布侧就得跟着变。这条依赖是刻意的，
  换来的是不必维护协议实现。
