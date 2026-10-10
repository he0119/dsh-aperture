<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<div align="center">

# dsh-aperture

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

</div>

把 [Aperture](https://tailscale.com/kb/1542/aperture) 网关上的模型自动发现出来，按模型自己在哪个端点上应答，注册成 DeepSeek Harness 里本插件自己的 provider 路由，让它们直接出现在模型选择器里。装好后你只需要填一个 Aperture 地址。

## 安装

前提：Node ^22.19.0 或 ≥24.0.0（与官方 DSH 一致），以及一个你能访问的 Aperture 实例。

### 1. 装上插件

```sh
# npm（推荐）：发布产物里带着编译好的 lib/，安装时不需要授权任何构建脚本
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture

# git：拉下来的是源码，靠 prepare 脚本在安装时编译，可以锁 commit
npx @deepseek-ai/dsh plugin --profile web add github:he0119/dsh-aperture#<sha>

# 本地仓库：先 pnpm run build
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-aperture
```

pnpm ≥10 默认拒绝运行 git 依赖的构建脚本，所以 git 那条**第一次会失败**：dsh 会把要授权的包键打印出来，写进 profile 的 `pnpm-workspace.yaml` 后重跑一次即可（键是**映射**形式，值为 `true`）。

```yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-aperture: true
```

> 这项授权等于允许该包在你机器上、于 agent 沙箱之外执行安装脚本。只对信任的源码授权。

### 2. 填上你的 Aperture 地址

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
```

这一行就是本插件的设置命名空间 `aperture`。补丁层是**整行替换**而不是深合并：你写几项就只有几项，没写的键回落 schema 里的缺省值。也可以直接在界面里填：**插件**页里点开本插件，「实例地址」写的就是同一个 `aperture.baseUrl`，保存后落在同一个文件里。

### 3. 重启 DSH

bundle 变化不会热加载。重启前可以先只看组合结果：

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # 应出现 "# == dsh-aperture" 层
```

### 4. 确认

模型出现在选择器里，路由名 `Aperture`。界面分两处：

- **插件 → dsh-aperture**：实例地址、注册开关与「立刻刷新」。设置挂在插件这个包上，因此没有单独的「配置」按钮。
- **设置 → 模型**：本插件的每一条路由是那一页上的一行，行里一块**默认收着**的模型目录——点开就是这条路由能服务的模型，以及逐模型的覆盖编辑器（显示名称、目录别名、协议、容量、输入类型、推理）。没有路由可服务的模型不占座位，由插件页那句话交代：几个、叫什么、去哪儿给它们写协议。

界面怎么排、每条限制的来历，见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)。

## 使用

地址、开关与逐模型参数在按下「保存」之前都只是草稿；模型那部分**按行来**，收起一行不算放弃。

- **插件页 · 实例地址与注册开关**：保存只发真的改动过的那一项，并按版本设栅挡住已经与设置文档脱节的表单；写着「已覆盖」的键旁边那颗「恢复默认」把它从设置文件里删掉（与官方「插件配置」页同一对词、同一个位置）。
- **插件页 · 立刻刷新**：不写设置，直接重跑一轮发现与注册，成功或失败的原因贴在同一页上。
- **插件页 · 注册开关**：关掉就只探测、不注册——那一轮会把本插件已经注册出去的三条路由撤下来，别处注册的同名路由不受影响。
- **模型页 · 保存 / 清空覆盖 / 取消**：只写这一行；或者只清掉后台报告里确实覆盖过的那几项；或者丢掉这一行的草稿。「保存」等一轮重新发现落地才返回，所以按完看到的就是新值。
- **容量写法**：认 `1M`、`100K`（十进制后缀，`1M` 是 1000000，不是 1048576）；留空表示这一项不覆盖、回落到发现值与目录。

就地编辑写下去的都是配置：容量与输入类型落在 `aperture.models` 的对应条目上，目录别名落在 `aperture.modelAliases[id]`，写入按字段合并，界面没提到的字段原样留着（比如 `reasoningEfforts`）。

## 配置

所有键都写在 profile 补丁文档里那一行的 `config:` 下，不写的键回落下面的缺省值（默认一栏写 `—` 的键没有缺省值，不写就是缺失）。`baseUrl` 与 `sync` 能在插件页上就地编辑，`models`、`modelAliases` 里的逐模型参数能在「设置 → 模型」页里就地编辑；其余键只有配置文件这一条路。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture 实例地址。末尾 `/v1` 会被容忍并去掉；空值表示休眠（不探测、不注册） |
| `routePrefix` | `aperture` | 三条路由名的共同前缀：路由键是前缀加协议名的小写连字符写法（`aperture-openai-chat-completions`、`aperture-openai-responses`、`aperture-anthropic-messages`），三个选择器名称同样由它推出来，逐字取官方「模型」页给协议用的产品名：`Aperture (OpenAI Chat Completions)`、`Aperture (OpenAI Responses)`、`Aperture (Anthropic Messages)` |
| `apiKeyEnv` | `—` | 凭据 seam 里的引用名（须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`）；不写这一项就按协议带占位凭据。空串不是引用名，别写 |
| `headers` | `{}` | 每条请求额外带的头；同名时**归因头**与**占位凭据**仍会按协议补齐 |
| `enabledModelIds` | `[]` | 非空时只保留这些 id（`models` 里显式列出的不受限） |
| `modelAliases` | `{}` | 网关 id → models.dev id |
| `models` | `[]` | 逐模型覆盖或补充：`id`、`name`、`protocol`、`contextWindow`、`maxTokens`、`input`、`thinking`、`reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | 目录地址；设成 `''` 关闭补全 |
| `images` | `ignore` | `metadata` = 采用 models.dev 的输入类型（图片） |
| `reasoning` | `auto` | `off` = 所有模型都当不会推理 |
| `sync` | `true` | `false` = 只探测不注册路由（配置页仍可查看） |
| `refreshIntervalMinutes` | `0` | 定时刷新间隔；`0` = 只在启动和配置变化时刷新 |

三个常用例子：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
    models:
      # 给某个模型更多推理等级（默认只给保守的两档）
      - id: deepseek-v4-pro
        reasoningEfforts: { off: disabled, minimal: minimal, low: low, medium: medium, high: high, max: max }
      # 网关没列出的模型，显式补一条
      - id: gemini-2.5-pro
        api: openai-completions
    modelAliases:
      # 网关改了名，models.dev 上对不上
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

容量与推理等级缺失时，按 Aperture 字段 → [models.dev](https://models.dev) → 保守默认值补全（兜底容量 128000、单次请求超时 20s、流式空闲上限 5 分钟是代码里的常量，不是配置项）；`maxTokens` 只有模型自己声明过才会作为默认输出上限报给宿主，没人声明时不报。

## 常见问题

### 从 git 装的时候，第一次 `add` 失败、说构建脚本被忽略？

按[安装](#1-装上插件)里 git 那段的 `allowBuilds` 写一行，然后重跑；或者直接用 npm 安装，不需要任何授权。

### 装的时候警告 `Issues with peer dependencies found`？

预期内：本包依赖的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 都由 DSH 自带并自行解析，不进 profile 的 `node_modules`，pnpm 看不到它们不影响运行。

### `Failed to resolve dependency: 文件名、目录名或卷标语法不正确。 (os error 123)`？

git 地址用了 `git@github.com:he0119/dsh-aperture.git` 这种 scp 风格——在 Windows 上冒号会被当作盘符，于是被当成**本地路径**。改用 pnpm 认的写法：`github:he0119/dsh-aperture`、`git+https://…` 或 `git+ssh://…`。

### 本机 git 的 HTTPS 不可用（报 schannel / `SEC_E_NO_CREDENTIALS`）？

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

### 有些模型没出现在选择器里？

看**插件 → dsh-aperture** 配置页上那句话：有几个模型没有路由可服务、都叫什么（路由卡里列的只是那一条路由真的能服务的模型）。只提供 Gemini 原生 `generateContent` 端点的模型接不进来——本插件只发布 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages。接不上时 Aperture 会明确告诉你该用哪个端点，比如 `404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat`。

### 想给某个模型更多推理等级？

默认只给保守的两档（DeepSeek 系 `off/high/max`，其它会推理的模型 `off/high`），要加就在 `models` 里给这一条写 `reasoningEfforts`，例子见[配置](#配置)。

### 网关没列出的模型也想接？

在 `models` 里显式补一条就行（比如插件页那句话里报出来的那几个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用），例子见[配置](#配置)。

### 模型的容量/推理标记没补上？

网关会改名，models.dev 上可能对不上（实测 `deepseek-flash`、`k3` 那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`），用 `modelAliases` 显式映射，例子见[配置](#配置)。

### 界面上说 `没注册（路由 aperture-openai-responses 已被另一个适配器注册…）`？

那个路由键已经被别人服务了，最常见的原因是**旧版本的本插件**（0.2 及更早只做发现，会把自己发现的路由写进 `llm-pi-ai.providers`）。本插件不替你改别人的配置：照那句话给出的键名删掉 `llm-pi-ai` 段里对应的 `providers.<键>`，或者那个名字属于别的插件时改本插件的 `routePrefix`（三条路由键一起变）。下一次适配器集合变化（改完配置的重载、或按「立刻刷新」）会重新尝试注册，不必重启。

### 从 0.2 或更早升上来，`llm-pi-ai.providers` 里那几个 `aperture*` 键要不要自己删？

要，而且这次没有哪个键会替你报错：现在的路由键是前缀加协议名（默认 `aperture-openai-chat-completions` / `aperture-openai-responses` / `aperture-anthropic-messages`），与那时写下的 `aperture`、`aperture-responses`、`aperture-anthropic` 都不同名，注册不会撞键。留着只会让 `llm-pi-ai` 继续服务一份过期的路由（选择器里出现重复模型）。

### 配置里的 `route` 键去哪了？

改名叫 `routePrefix` 了。旧键不报错，但会被 schema 忽略——前缀于是静默回到缺省的 `aperture`。写过别的名字（`route: my-gateway`）就把它抄到 `routePrefix` 上，只写过缺省值就删掉旧键。

### 保存了但没生效？

DSH 的补丁层是叠加的：profile 的补丁文档之上还有 `$DSH_HOME/cordis.patch.yml` 这类更高优先级的层。`aperture` 那一行在那里也被写过时，配置页的保存会落在 profile 的补丁文档里、却被上面那层盖住（也可能被设置接缝直接拒收，配置页会说没被收下）。把那一行从高优先级的层里删掉，或者直接改那一处。

### 从 0.2 升上来，我的 `settings.yaml` 去哪了？

0.1.7 起设置不再有独立文件，而是落在 profile 的补丁文档里。首次启动时 `$DSH_HOME/settings.yaml` 会被改名成 `settings.yaml.imported`，各段按设置命名空间搬进补丁文档——`aperture:` 段原样搬过去，仍能过 schema 的键与值都不变，所以地址与逐模型覆盖都还在。此后被读的只有补丁文档，那份留档改了没用；搬不过去的段（值已不合法）也只留在留档里，并在日志里说一声。

### 本部署没有「插件」页 / 没有界面？

两处界面都只在 Web 界面里有。headless profile 里插件照常发现、照常注册路由，只是没有可点按的页面，改配置即可。模型在官方「模型」页里也会有相应的行——那一行自己的编辑器对本插件是只读的（设置段是 `aperture`），能编辑的是本插件挂进去的那一块。

### 需要真密钥而不是占位凭据？

不需要：Aperture 靠网络身份（Tailscale）认证。插件默认在每条请求上带 `authorization: Bearer dsh-aperture`（Anthropic 路由是 `x-api-key: dsh-aperture`），只是让 pi-ai 愿意把请求发出去，**不是密钥**。真要密钥时把 `apiKeyEnv` 指向凭据 seam 里的记录，占位凭据就不再带。

### 改了 `routePrefix` 之后旧路由还在？

插件只认自己当前请求的三个键，进程退出后旧键就没有服务者了；它不再出现在选择器里，也不需要清理，除非有别的适配器顶上那个键。

## 它做了什么

插件只请求网关上那份 `GET {baseUrl}/v1/models` 清单，再按每个模型的 `supported_endpoints` 分流：`/v1/chat/completions` 对到 `openai-completions`、`/v1/responses` 对到 `openai-responses`、`/v1/messages` 对到 `anthropic-messages`，各自挂上同一前缀的三条路由之一；只提供原生 `generateContent` 的模型不发布，由配置页那句话报出来。

三条路由各自只承载一种协议，模型 id 就是网关的 id；本插件不写任何配置，发现结果只活在这一次注册里。路由键被别的适配器占着时不硬闯：跳过注册、在报告里点名那个键，并在适配器集合变化时重试。每条决定的依据与被放弃的备选方案见 [.agents/notes/implemented/](https://github.com/he0119/dsh-aperture/tree/main/.agents/notes/implemented)（中文），当前机制与已知边界见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)（中文）。

## 开发

```sh
pnpm install
pnpm run build      # tsdown -> lib/index.js + lib/types/index.d.ts + lib/client.js
pnpm test           # 单元测试 + 端到端（离线运行；需要已安装的 devDependencies）
```

改代码、跑测试与开发实例见 [docs/development.md](https://github.com/he0119/dsh-aperture/blob/main/docs/development.md)，发布流程与产物构成见 [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md)。

## 致谢

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)：本插件的参考实现，Aperture 模型发现的做法来自这个 VS Code 扩展。
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup)：界面接线的参考实现，Remote 端点的形状来自这个插件；配置页本身的挂载方式在 0.1.7 之后改由插件页的槽位契约给出。
- [Aperture](https://tailscale.com/kb/1542/aperture)（Tailscale）：提供被发现的网关。
- [models.dev](https://models.dev)：为 Aperture 未声明的容量与能力做补全。
- [pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)（`@earendil-works/pi-ai`）：三种线缆协议的实现来自它，本插件只负责把发现结果翻译成它的模型描述符。

## License

MIT
