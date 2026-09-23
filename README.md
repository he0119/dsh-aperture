# dsh-aperture

把 [Aperture](https://tailscale.com/kb/1542/aperture) 网关上的模型自动发现出来，写进 DeepSeek Harness 的 `llm-pi-ai` 设置，让它们直接出现在模型选择器里。

装好后你只需要填一个 Aperture 地址，其余交给插件。

## 安装

前提：Node ≥ 24，以及一个你能访问的 Aperture 实例。

### 1. 装上插件

从 [npm](https://www.npmjs.com/package/dsh-aperture) 装（推荐）：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture
```

发布产物里带着编译好的 `lib/`，安装时不需要授权任何构建脚本。

想锁 commit、或跟进未发布的改动，就从 git 装：

```sh
npx @deepseek-ai/dsh plugin --profile web add github:he0119/dsh-aperture#<sha>
```

git 安装拉下来的是**源码**，靠 `prepare` 脚本在安装时编译。pnpm ≥10 默认拒绝运行 git 依赖的构建脚本，所以**第一次 `add` 会失败**：dsh 会把你需要的包键打印出来，写进 profile 的 `pnpm-workspace.yaml` 后重跑一次即可。

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-aperture: true
```

（键是**映射**形式，值为 `true`；写成列表无效。）

> 这项授权等于允许该包在你机器上、于 agent 沙箱之外执行安装脚本。只对信任的源码授权。

本地改代码时，直接装仓库目录（先 `npm run build`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-aperture
```

### 2. 填上你的 Aperture 地址

```yaml
# ~/.dsh/settings.yaml
aperture:
  baseUrl: https://ai.example.ts.net
```

也可以写进 profile 的 `cordis.patch.yml`（组合层）；用户层覆盖组合层。

### 3. 重启 DSH

bundle 变化不会热加载。重启前可以先只看组合结果：

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # 应出现 "# == dsh-aperture" 层
```

### 4. 确认

模型会出现在选择器里，路由名 `Aperture`。用 `/aperture` 看一眼：

```
Aperture：https://ai.example.ts.net
  最近一次刷新：配置变更 · 2026-09-22T16:31:02.184Z · 412ms · 成功
  清单：422 个条目
  端点：https://ai.example.ts.net/v1/models 列出了 16 行
  路由 aperture：11 个模型，经由 openai-completions → https://ai.example.ts.net/v1
  路由 aperture-anthropic：1 个模型，经由 anthropic-messages → https://ai.example.ts.net
  未服务：4 个模型（gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.5-pro, gemini-3.1-flash-image-preview）
  设置：向 llm-pi-ai 写入 2 个操作（aperture, aperture-anthropic）
```

## 使用

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

容量与推理档位缺失时，按 Aperture 字段 → [models.dev](https://models.dev) → 保守默认值补全；`maxTokens` 没人声明时**故意不写**（在 `llm-pi-ai` 里它同时是每次请求的 `max_tokens` 上限，凭空编一个值会把请求截断）。

## 常见问题

**从 git 装的时候，第一次 `add` 失败、说构建脚本被忽略？**
按[安装](#1-装上插件)里 git 那段的 `allowBuilds` 写一行，然后重跑；或者直接用 npm 安装，不需要任何授权。

**装的时候警告 `Issues with peer dependencies found`？**
预期内。本包依赖的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 都由 DSH 自带并自行解析，不进 profile 的 `node_modules`，pnpm 看不到它们不影响运行。

**`Failed to resolve dependency: 文件名、目录名或卷标语法不正确。 (os error 123)`？**
git 地址用了 `git@github.com:he0119/dsh-aperture.git` 这种 scp 风格——在 Windows 上冒号会被当作盘符，于是被当成**本地路径**。改用 pnpm 认的写法：`github:he0119/dsh-aperture`、`git+https://…` 或 `git+ssh://…`。

**本机 git 的 HTTPS 不可用（报 schannel / `SEC_E_NO_CREDENTIALS`）？**

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

**有些模型没出现在选择器里？**
看 `/aperture` 的「未服务」一行。只提供 Gemini 原生 `generateContent` 端点的模型接不进来——`llm-pi-ai` 只讲 OpenAI 兼容和 Anthropic Messages 两种协议。走错端点时 Aperture 会明确告诉你该用哪个：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

**想给某个模型更多推理档位？**
默认只给保守的两档（DeepSeek 系 `off/high/max`，其它会推理的模型 `off/high`），自己加：

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

**网关没列出的模型也想接？**
用 `models` 显式补一条即可（比如 `/aperture` 里「未服务」的那几个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用）：

```yaml
aperture:
  models:
    - id: gemini-2.5-pro
      api: openai-completions
```

**模型的容量/推理标记没补上？**
网关会改名，models.dev 上可能对不上（实测 `deepseek-flash`、`k3` 那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`）。显式映射：

```yaml
aperture:
  modelAliases:
    deepseek-flash: deepseek/deepseek-v4-flash
    k3: moonshotai/kimi-k3
```

**`/aperture` 说 `设置：未写入（已处于同步状态）`？**
正常状态，表示设置里已经是最新内容。

**需要真密钥而不是占位头？**
Aperture 靠网络身份（Tailscale）认证，本不需要密钥；插件默认写入 `authorization: Bearer dsh-aperture` / `x-api-key: dsh-aperture`，只是让适配器愿意发请求，**不是密钥**。真要密钥时把 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

**改了 `route` / `anthropicRoute` 之后旧路由还在？**
插件只认自己当前拥有的两个键，不知道历史上用过哪些名字，所以旧键会留在 `llm-pi-ai.providers` 里。它不报错、只是不再刷新；要清理就手动删掉那一行。

## 它做了什么

```
GET {baseUrl}/v1/models
        │
        ├─ 每个模型：supported_endpoints ──► 分流
        │     /v1/chat/completions        ──► route            （openai-completions）
        │     /v1/messages                ──► anthropicRoute   （anthropic-messages）
        │     只有原生 generateContent     ──► 不发布（列进「未服务」）
        │
        ├─ 容量：Aperture 字段 ─► models.dev ─► 默认值
        ├─ 推理：Aperture 字段 ─► models.dev ─► 关闭
        │
        └─ 生成 llm-pi-ai 的 providers.<route>，按 revision 写入 settings.yaml
```

写入只碰 `llm-pi-ai.providers` 下属于本插件的两个键：内容没变就不写；用路径操作写，你手写的其它 provider 原样保留；探测失败绝不删空已有目录；路由没模型了就删掉。

实现细节（两条路由的取舍、容量与推理的来源优先级、生命周期与依赖、写入行为）见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)。

## 开发

```sh
npm install                # 若机器级 npm 缓存不可写：npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/
npm run typecheck          # 含 test/
npm test                   # 纯函数单测（93 个，离线，不需要 node_modules）
npm run inspect            # 打印真实生成的 settings.yaml 与解析结果

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live   # 端到端：真实 DSH 栈 + 真实网关
```

> `lib/` 是构建产物：git 安装与 `npm publish` 都由 `prepare` 脚本现场编译。
> 从本地目录安装（`link:`）不会跑 `prepare`，所以本地调试前先 `npm run build`。

发布流程见 [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md)。

## 致谢

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)：本插件的参考实现，Aperture 模型发现的做法来自这个 VS Code 扩展。
- [Aperture](https://tailscale.com/kb/1542/aperture)（Tailscale）：提供被发现的网关。
- [models.dev](https://models.dev)：为 Aperture 未声明的容量与能力做补全。
- `@deepseek-ai/dsh-llm-pi-ai`：本插件只做发现，协议对接交给它。

## License

MIT
