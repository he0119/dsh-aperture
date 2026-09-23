# dsh-aperture 实现细节

安装与配置请看 [README](../README.md)；这里放的是设计取舍与内部行为，给需要改这个插件、或者想弄清「为什么是现在这样」的人看。

## 只做发现，不做转换

参考实现 [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot) 需要自己实现一套 provider；而 DSH 里已经有 `@deepseek-ai/dsh-llm-pi-ai`，它本来就讲 OpenAI Chat Completions 和 Anthropic Messages——正好是 Aperture 唯一暴露的两种协议。所以本插件**不做任何 API 格式转换**：它把探测结果翻译成 `llm-pi-ai` 的 provider profiles，剩下的交给现成的适配器。

```yaml
# ~/.dsh/settings.yaml —— 由插件自动写入，不需要手写
llm-pi-ai:
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

## 为什么有两条路由

Aperture 是按**端点**网关的：同一个模型不是所有协议都收。实测（`https://ai.long-antares.ts.net/`）：

| 模型 | `supported_endpoints` | 结果 |
| --- | --- | --- |
| 11 个（DeepSeek / MiMo / Grok / Qwen / LongCat …） | `/v1/chat/completions` | 走 `aperture` |
| `MiniMax-M3` | `/v1/messages` | 走 `aperture-anthropic` |
| 4 个 Gemini | `/v1beta/models/{model}:generateContent` | 不发布 |

走错端点的失败是明确的（Aperture 直接告诉你该用哪个）：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

`llm-pi-ai` 只讲 OpenAI 兼容协议和 Anthropic Messages，所以 Gemini 那 4 个**无法**接入——插件会把它们列出来，而不是发布一堆必然 404 的模型。

## 关于「占位凭据」

`llm-pi-ai`（更准确地说，它背后的 pi-ai）在没有任何密钥时会直接抛 `No API key for provider`。Aperture 靠网络身份认证，本不需要密钥，所以插件默认写入一个占位请求头：

- `aperture` 路由 → `authorization: Bearer dsh-aperture`
- `aperture-anthropic` 路由 → `x-api-key: dsh-aperture`

**这不是密钥**，只是让适配器愿意发请求。实测 Aperture 对垃圾 Bearer 照常返回 200。如果你确实需要真密钥，用 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

## 容量与能力的来源优先级

| 事实 | 优先级 |
| --- | --- |
| `contextWindow` | Aperture `context_window_tokens` / `max_input_tokens` / `limit.context` → models.dev → `defaultContextWindow` |
| `maxTokens` | Aperture `max_output_tokens` / `limit.output` → models.dev → **不写** |
| `input`（多模态） | `images: metadata` 时取 Aperture 能力字段 → models.dev → `["text"]`；`images: ignore` 时恒为 `["text"]` |
| `reasoning` | Aperture 能力字段 → models.dev → 关闭 |

`maxTokens` 没人声明时**故意不写**：在 `llm-pi-ai` 里它同时是「输出能力」和「每次请求的 max_tokens 上限」，凭空编一个 16384 会把每次请求都截断。

## 推理等级是保守的

`reasoningEfforts` 的等级 = 实际发出去的参数值。实测：

- DeepSeek 接受 `minimal/low/medium/high/xhigh/max/none`，且默认就会返回 `reasoning_content`，用 `thinking: {type: disabled}` 才能关掉；
- MiMo（`mimo-v2.6-pro`）对 `minimal`/`xhigh`/`max` 直接 **HTTP 400**。

所以默认只给两档：

| 模型 | `reasoningEfforts` | `compat` |
| --- | --- | --- |
| DeepSeek 系（id/name/provider 含 `deepseek`） | `{off: disabled, high: high, max: max}` | `{supportsReasoningEffort: true, thinkingFormat: deepseek}` |
| 其它会推理的模型 | `{off: null, high: high}` | `{supportsReasoningEffort: true}` |

Anthropic 路由**默认不给推理档位**：Anthropic 的 thinking 是另一套开关（要 budget），发 `reasoning_effort` 没有意义。要开就用 `thinking: true` 显式声明。

## models.dev id 对不上时

网关会改名。实测里 `deepseek-flash`、`k3` 在 models.dev 上找不到对应条目（那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`），靠打分是猜不出来的，于是显式映射（`modelAliases`）。映射之后这两个模型才会拿到 models.dev 的推理标记和容量。

## 生命周期与依赖

- `settings` 是**硬依赖**（`inject = ['settings']`）。本插件的职责就是往设置里写，没有它发布对象都不存在，所以宁可让框架把插件挂在 `PENDING`，provider 被替换时自动卸载、恢复后重新加载，而不是留着一个无处发布的实例。
- `commands` **不声明**。没有命令服务的部署也该照常获得发现能力，所以它走 `ctx.inject(['commands'])` 可选挂载。
- 定时刷新用 `ctx.effect` 注册，卸载自动清理；配置变更会按新值重新计算间隔。
- **注册配置段本身就是第一次发现的触发器**：`installSection` 挂载时先 `setSource` 再通知 `onChange`，所以首次刷新看到的就是叠加了用户层的配置，不需要为了对齐两份配置再刷一遍。
- 配置段是**活引用**（thunk）而不是快照：改 `~/.dsh/settings.yaml` 里的 `aperture:` 段，下一次刷新立刻用新值，不必重启、也不必重载插件。

## 写入行为

插件只碰 `llm-pi-ai.providers` 下的两个键（`route` / `anthropicRoute`），并且：

- **内容相同就不写**——每次刷新都对比解析后的段，避免无意义的重写和文件监听回环；
- **用路径操作写**——你的其它 provider 一个字段都不会动；
- **探测失败就不写**——网关临时不可达时保留已经生效的目录，而不是清空；
- **带 revision 写**——与其它写入者（比如模型页）冲突时重读一次再写；
- **路由没模型了就删掉**——避免留下指向旧目录的空路由。

`/aperture` 里说 `设置：未写入（已处于同步状态）` 是正常状态。

## 已知边界

- **不转换 API 格式**，这是设计目标而不是缺陷。也因此只支持 `llm-pi-ai` 讲得了的两种协议；Gemini 原生端点接不了。
- `supported_endpoints` 是唯一的协议依据。网关如果不报，就按 OpenAI 兼容处理。
- models.dev 是尽力而为的补全：拉不到就是拉不到，发现本身照常成功。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）——`llm-pi-ai` 已经认领了那件事，重复注册会抛错。
- **改了 `route` / `anthropicRoute` 的路由名之后，旧键会留在 `llm-pi-ai.providers` 里**（插件只认自己当前拥有的两个键，无法知道历史上用过哪些名字）。它不会报错，只是不再刷新；要清理就手动删掉那一行。
