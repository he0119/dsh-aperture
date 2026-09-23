# dsh-aperture

把 [Aperture](https://tailscale.com/kb/1542/aperture) 网关暴露的模型**自动发现**出来，写进 DeepSeek Harness 的 `llm-pi-ai` 设置里，让它们直接出现在模型选择器中。

参考实现是 [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)。区别在于：那个扩展需要自己实现一套 provider；而 DSH 里已经有 `@deepseek-ai/dsh-llm-pi-ai`，它本来就讲 OpenAI Chat Completions 和 Anthropic Messages——正好是 Aperture 唯一暴露的两种协议。所以这个插件**只做发现，不做任何 API 格式转换**：它把探测结果翻译成 `llm-pi-ai` 的 provider profiles，剩下的交给现成的适配器。

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

## 特性

- **零配置发现**：只需一个 `baseUrl`。`GET {baseUrl}/v1/models` 不需要密钥，靠网络身份（Tailscale）认证。
- **按协议自动分流**：读每个模型的 `supported_endpoints`，把它发到它真正应答的那条路由上，而不是让它每条请求都 404。
- **容量与能力补全**：Aperture 自己的字段优先，缺失时用 [models.dev](https://models.dev) 补全，再缺失时用可配置的保守默认值。
- **推理等级映射**：只暴露后端实测接受的等级，并按 DeepSeek 的 `thinking` 方言生成 `compat`。
- **只写自己拥有的键**：写入是路径寻址的，你手写的其它 provider 原样保留；内容没变就不写；探测失败绝不删空已有目录。
- **`/aperture` 命令**：查看状态、列出模型、强制刷新、撤销路由。

## 安装

```sh
# 从本地目录（开发时）
dsh plugin --profile web add /path/to/dsh-aperture

# 或从 git
dsh plugin --profile web add git@github.com:he0119/dsh-aperture.git
```

`dsh plugin add` 会把包加进 profile，并自动把本包的 bundle patch 追加到 `dsh.profile.bundles`。**装完需要重启这次 DSH**（bundle 变化不会热加载）。

> 本地目录方式装的是软链接，**不会**自动构建：先 `npm install && npm run build`，之后每次改代码也要重新 `npm run build` 才生效。git 方式会跑 `prepare` 自动构建。

然后填上你的 Aperture 地址，二选一：

```yaml
# ~/.dsh/settings.yaml（用户层，推荐）
aperture:
  baseUrl: https://ai.example.ts.net
```

或者直接改 profile 里的 `cordis.patch.yml`（组合层）。用户层覆盖组合层。

重启后模型就会出现在选择器里（路由名 `Aperture`）。用 `/aperture` 确认：

```
Aperture: https://ai.example.ts.net
  last refresh: load · 2026-09-22T16:31:02.184Z · 412ms · ok
  catalog: 422 entries
  endpoint: https://ai.example.ts.net/v1/models listed 16 row(s)
  route aperture: 11 model(s) via openai-completions → https://ai.example.ts.net/v1
  route aperture-anthropic: 1 model(s) via anthropic-messages → https://ai.example.ts.net
  unserved: 4 model(s) (gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, gemini-3.1-flash-image-preview)
  settings: wrote 2 op(s) to llm-pi-ai (aperture, aperture-anthropic)
```

## 工作原理

```
GET {baseUrl}/v1/models
        │
        ├─ 每个模型：supported_endpoints ──► 分流
        │     /v1/chat/completions        ──► route            （openai-completions）
        │     /v1/messages                ──► anthropicRoute   （anthropic-messages）
        │     只有原生 generateContent     ──► 不发布（列进 unserved）
        │
        ├─ 容量：Aperture 字段 ─► models.dev ─► 默认值
        ├─ 推理：Aperture 字段 ─► models.dev ─► 关闭
        │
        └─ 生成 llm-pi-ai 的 providers.<route>，按 revision 写入 settings.yaml
```

### 为什么有两条路由

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

### 关于“占位凭据”

`llm-pi-ai`（更准确地说，它背后的 pi-ai）在没有任何密钥时会直接抛 `No API key for provider`。Aperture 靠网络身份认证，本不需要密钥，所以插件默认写入一个占位请求头：

- `aperture` 路由 → `authorization: Bearer dsh-aperture`
- `aperture-anthropic` 路由 → `x-api-key: dsh-aperture`

**这不是密钥**，只是让适配器愿意发请求。实测 Aperture 对垃圾 Bearer 照常返回 200。如果你确实需要真密钥，用 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

### 容量与能力的来源优先级

| 事实 | 优先级 |
| --- | --- |
| `contextWindow` | Aperture `context_window_tokens` / `max_input_tokens` / `limit.context` → models.dev → `defaultContextWindow` |
| `maxTokens` | Aperture `max_output_tokens` / `limit.output` → models.dev → **不写** |
| `input`（多模态） | `images: metadata` 时取 Aperture 能力字段 → models.dev → `["text"]`；`images: ignore` 时恒为 `["text"]` |
| `reasoning` | Aperture 能力字段 → models.dev → 关闭 |

`maxTokens` 没人声明时**故意不写**：在 `llm-pi-ai` 里它同时是「输出能力」和「每次请求的 max_tokens 上限」，凭空编一个 16384 会把每次请求都截断。

### 推理等级是保守的

`reasoningEfforts` 的等级 = 实际发出去的参数值。实测：

- DeepSeek 接受 `minimal/low/medium/high/xhigh/max/none`，且默认就会返回 `reasoning_content`，用 `thinking: {type: disabled}` 才能关掉；
- MiMo（`mimo-v2.6-pro`）对 `minimal`/`xhigh`/`max` 直接 **HTTP 400**。

所以默认只给两档：

| 模型 | `reasoningEfforts` | `compat` |
| --- | --- | --- |
| DeepSeek 系（id/name/provider 含 `deepseek`） | `{off: disabled, high: high, max: max}` | `{supportsReasoningEffort: true, thinkingFormat: deepseek}` |
| 其它会推理的模型 | `{off: null, high: high}` | `{supportsReasoningEffort: true}` |

想要更多档位，用 `models` 自己加：

```yaml
aperture:
  models:
    - id: deepseek-v4-pro
      reasoningEfforts:
        off: disabled
        minimal: minimal
        low: low
        medium: medium
        high: high
        max: max
```

Anthropic 路由**默认不给推理档位**：Anthropic 的 thinking 是另一套开关（要 budget），发 `reasoning_effort` 没有意义。要开就用 `thinking: true` 显式声明。

### models.dev id 对不上时

网关会改名。实测里 `deepseek-flash`、`k3` 在 models.dev 上找不到对应条目（那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`），靠打分是猜不出来的，于是显式映射：

```yaml
aperture:
  modelAliases:
    deepseek-flash: deepseek/deepseek-v4-flash
    k3: moonshotai/kimi-k3
```

映射之后这两个模型才会拿到 models.dev 的推理标记和容量。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/aperture` | 上一次刷新的状态（默认） |
| `/aperture models` | 列出每个模型、它的路由，以及每条事实的来源 |
| `/aperture refresh` | 立刻重新发现并发布 |
| `/aperture remove` | 把本插件的路由从 `llm-pi-ai` 段里撤掉 |

## 配置

所有键都可写在 `~/.dsh/settings.yaml` 的 `aperture:` 段（用户层），或 profile 的 `cordis.patch.yml`（组合层）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture 实例地址。末尾 `/v1` 会被容忍并去掉；空值表示休眠（不探测、不写入） |
| `route` | `aperture` | OpenAI 兼容模型的路由名 |
| `anthropicRoute` | `aperture-anthropic` | Anthropic Messages 模型的路由名 |
| `displayName` | `Aperture` | 选择器里的名字 |
| `anthropicDisplayName` | `Aperture (Anthropic)` | 同上，Anthropic 路由 |
| `apiKeyEnv` | `''` | 凭据 seam 里的引用名；非空时不再写占位头 |
| `placeholderCredential` | `dsh-aperture` | 占位凭据的值；设成 `''` 就完全不写占位头 |
| `headers` | `{}` | 每条请求额外带的头，**优先于**占位头 |
| `enabledModelIds` | `[]` | 非空时只保留这些 id（`models` 里显式列出的不受限） |
| `modelAliases` | `{}` | 网关 id → models.dev id |
| `models` | `[]` | 逐模型覆盖或补充：`id`、`name`、`api`、`contextWindow`、`maxTokens`、`input`、`thinking`、`reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | 目录地址；设成 `''` 关闭补全 |
| `defaultContextWindow` | `128000` | 谁都没说容量时的上下文 |
| `images` | `ignore` | `metadata` = 采用 models.dev 的输入模态（图片） |
| `reasoning` | `auto` | `off` = 所有模型都当不会推理 |
| `sync` | `true` | `false` = 只探测不写设置（`/aperture` 仍可查看） |
| `refreshIntervalMinutes` | `0` | 定时刷新间隔；`0` = 只在启动和配置变化时刷新 |
| `timeoutMs` | `20000` | 网关与目录的单次请求超时 |

`models` 既能覆盖已发现的模型（只覆盖你写了的字段），也能补充网关**没**列出的模型——比如上面那 4 个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用：

```yaml
aperture:
  models:
    - id: gemini-2.5-pro
      api: openai-completions
```

## 写入行为

插件只碰 `llm-pi-ai.providers` 下的两个键（`route` / `anthropicRoute`），并且：

- **内容相同就不写**——每次刷新都对比解析后的段，避免无意义的重写和文件监听回环；
- **用路径操作写**——你的其它 provider 一个字段都不会动；
- **探测失败就不写**——网关临时不可达时保留已经生效的目录，而不是清空；
- **带 revision 写**——与其它写入者（比如模型页）冲突时重读一次再写；
- **路由没模型了就删掉**——避免留下指向旧目录的空路由。

`/aperture` 里说 `settings: no write (already in sync)` 是正常状态。

## 开发

```sh
npm install                # 若机器级 npm 缓存不可写：npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/
npm run typecheck          # 含 test/
npm test                   # 纯函数单测（79 个，离线）
npm run test:live          # 端到端：真实 DSH 栈 + 真实网关
npm run inspect            # 打印真实生成的 settings.yaml 与解析结果
```

`npm run test:live` 需要网关地址：

```sh
DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live
```

它会拉起真实的 `dsh-settings-file` + `dsh-llm` + `dsh-llm-pi-ai` + 本插件，跑一次真实发现，然后断言：设置文件写对了、两条路由注册了、`ctx.llm.listModels()` 能看到模型、容量与推理档位与预期一致。这是唯一能证明“写进去的东西适配器真的收”的测试。

## 已知边界

- **不转换 API 格式**，这是设计目标而不是缺陷。也因此只支持 `llm-pi-ai` 讲得了的两种协议；Gemini 原生端点接不了。
- `supported_endpoints` 是唯一的协议依据。网关如果不报，就按 OpenAI 兼容处理。
- models.dev 是尽力而为的补全：拉不到就是拉不到，发现本身照常成功。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）——`llm-pi-ai` 已经认领了那件事，重复注册会抛错。

## License

MIT
