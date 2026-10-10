# Agent Note: 自带 provider 适配器

Status: implemented

## Problem

只做发现的做法（见[只做发现，不做转换](2026-09-23-discovery-only-delegates-to-llm-pi-ai.md)）
把发现结果翻译成 `llm-pi-ai` 的 provider profiles。那意味着本插件的产出是一份**别人的配置**：
它得跟上那个包的 provider 形状，而它的设置段是用户与那个包共有的——同一份文件里既有它的
provider，也有本插件写进去的那三条。

代价在三处露出来。其一，用户改一处 `llm-pi-ai` 的配置就可能把本插件的路由顺手改掉或者删掉，
而本插件只能在下一次刷新时把它写回去。其二，pi-ai 的模型描述符里有 `llm-pi-ai` 的 provider
schema 表达不了的东西（兼容开关、`thinkingLevelMap` 的逐档位写法、`maxTokens` 的「必填但不该
凭空编」），于是发现结果只能在翻译过程里被削平。其三，安装本插件就必须装另一个插件，而那份
依赖的方向是反的：谁做发现，谁就该拥有自己的路由。

## Decision

本插件自己实现 provider 侧：依赖 `@earendil-works/pi-ai`，实现一个 `LlmAdapter`，经
`ctx.llm.registerAdapter` 把三条路由注册到宿主的 LLM 服务，**不写任何配置**。

- 三条路由各自只承载一种协议，键是 `<routePrefix>` 加协议名的小写连字符写法（默认
  `aperture-openai-chat-completions` / `aperture-openai-responses` / `aperture-anthropic-messages`；
  命名与
  配置键的来历见[三条路由的名字都写出自己的协议](2026-10-04-route-names-carry-their-protocol.md)）。协议实现在
  `src/adapter/route.ts` 里从 pi-ai 的 `.lazy` 入口取——聚合入口会连带拉进整份 provider 目录，
  本插件一条都不需要。
- 线缆转换在 `src/adapter/` 下分四块：`context.ts`（宿主消息词汇 → pi-ai 的 `Context`）、
  `stream.ts`（pi-ai 的事件流 → 宿主的块）、`replay.ts`（原生重放元数据的信封）、
  `index.ts`（`ApertureAdapter`：元数据查询、快照、派发）。注册那一层在 `src/provider.ts`。
- 派发直接调 `ProviderStreams.streamSimple(model, context, options)`，不走 pi-ai 的
  `Models` / `Provider` 封装：那一层为「一个集合里的多个 provider」服务，而本插件只有自己声明
  的三条路由，凭据由宿主的凭据接缝解析、头由本插件自己拼齐。
- 每次请求都带上归因头；没有 `apiKeyEnv` 的路由按协议带占位凭据（见[占位凭据]
  (2026-09-23-placeholder-credential-header.md)）——pi-ai 在既无密钥、又无非空
  `authorization` / `x-api-key` 头时会拒绝派发。
- 重放元数据用自己的信封（`kind: 'aperture'`）。升级上来的部署里，同一条历史可能是
  `llm-pi-ai` 写的，读不出来时降级成 provider 中立的内容（丢掉没有签名的思考块，文本与工具调用
  照旧），而不是把别人的字段硬套。
- `prepareCall` 把「模型元数据」与「派发」绑在同一代路由上：`stream` 只读一次当前路由，因此一次
  请求不会把这一代的容量配上下一代的端点。
- 路由同时注册进 provider 目录（`registerConfigurableProviders`），官方「模型」页里因此看得到
  它们——只列**真的有模型**的那些：一种协议在这个网关上没有模型时，那一行既选不出东西也声明不了
  任何事实。那边的编辑器对本插件只读，要改就走本插件的配置页。

## Alternatives considered

**继续写 `llm-pi-ai` 的 provider profiles。** 就是上面的问题：改的是别人的配置、被别人的 schema
削平、安装被反向依赖绑住。它也解释不了「本插件自己的模型参数为什么要在另一个插件的设置段里
才能生效」。

**自己手写三种线缆协议。** 参考实现
[he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot) 走的
是这条路，代价是三种协议的流式语义、工具调用约定、重放元数据都要自己跟。pi-ai 已经讲了一遍，
抄第二遍只会分化——真正要写的只有「发现结果 → 模型描述符」这一层翻译。

**用 pi-ai 的 `Models` / `Provider` 封装。** 那层的 auth 语义要求一个永远解析成功的 `apiKey`
才肯派发，而本插件的路由本来就靠占位凭据工作；它还会按 provider 合并默认头、延迟到首次消费时
才 dispatch——对只有三条自声明路由的插件，每一件都是多余的间接。直接调 `streamSimple` 少一层，
且不读任何 auth。

**只注册 provider 目录，让用户自己填 `baseUrl`。** 那样用户要自己维护模型清单，而那份清单正是
本插件要发现的东西（见[只写 baseURL 不够](2026-09-23-discovery-only-delegates-to-llm-pi-ai.md)）。

## Consequences

- 安装重量大幅上升：`@earendil-works/pi-ai` 把 `openai`、`@anthropic-ai/sdk`、`@google/genai`、
  AWS Bedrock、typebox、partial-json 与 pi-telemetry 一起带进来。换来的是三种协议不用自己维护。
- 版本线跟着宿主的 pi-ai 走：`dependencies` 里写 `^1.0.2`（与 `dsh-llm-pi-ai` 同一行，实装
  1.1.0）。0.85.x 只是最初的落点——0.86.0 起 `ProviderStreams` 只收带 brand 的
  `TranscriptContext`，`Context` 不再能被直接派发。迁移就两处：`streamSimple` 之前先过 pi-ai 的
  `normalizeContext()`（system 提示与工具声明必须折进 transcript 头部那条指令消息，否则它们不
  报错、只是从线上请求里整个消失），以及 `ToolCall.arguments` 收紧成 `JsonObject`。再动这条
  版本线时先看三样：`.lazy` 入口、事件词汇、`Model` 描述符；`test/live.test.ts` 里那条「system
  提示与工具声明都到线上」的用例钉的是 `normalizeContext` 这一步。
- `engines.node` 跟着 pi-ai 提到 `>= 22.19.0`。
- pi-ai 的工具参数解析是 O(n²)（每个增量都重解析一次累积的 JSON），0.85.1 与 1.1.0 都如此
  （`utils/json-parse.js` 逐字节没变）：正确性不受影响，长工具调用会慢一点。这是上游的事，
  本插件只记录。
- pi-ai 的失败是流里的终态事件而不是抛出，因此「该不该重试」的机器码由 `src/adapter/stream.ts`
  按文本分类给出；分类表是这一层唯一的猜测，宁可给 `PI_AI_ERROR` 也不要错报成可重试的类别。
- 本插件从此要跟 pi-ai 的模型描述符与事件词汇走：`reasoning` 的档位名、`thinkingLevelMap` 的
  语义、`.lazy` 入口的形状都是外部契约，动它们要同时改 `src/adapter/route.ts` 与那一份单元测试。
