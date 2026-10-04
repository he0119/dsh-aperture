# dsh-aperture

把 [Aperture](https://tailscale.com/kb/1542/aperture) 网关上的模型自动发现出来，按模型自己在哪个端点上应答，注册成 DeepSeek Harness 里本插件自己的 provider 路由，让它们直接出现在模型选择器里。装好后你只需要填一个 Aperture 地址，其余交给插件。

## 安装

前提：Node ^22.19.0 或 ≥24.0.0（与官方 DSH 一致），以及一个你能访问的 Aperture 实例。

### 1. 装上插件

从 [npm](https://www.npmjs.com/package/dsh-aperture) 装（推荐）：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-aperture
```

发布产物里带着编译好的 `lib/`，安装时不需要授权任何构建脚本。想锁 commit、或跟进未发布的改动，就从 git 装：

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

本地改代码时，直接装仓库目录（先 `pnpm run build`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add /path/to/dsh-aperture
```

### 2. 填上你的 Aperture 地址

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
```

这一层（profile 的补丁文档，即用户层）就是本插件的设置命名空间 `aperture`。补丁层是**整行替换**而不是深合并——这一行的 `config` 会整个取代本包自带 `cordis.patch.yml`（组合层）那一行的，而组合层只声明这一行、不写 `config`，所以你写几项就只有几项；每个键的缺省值都在 schema 里，不写的键回落缺省值。也可以直接在界面里填：**插件**页里点开本插件，配置页上第一个格子「实例地址」写的就是同一个 `aperture.baseUrl`，保存后落在同一个文件里。

### 3. 重启 DSH

bundle 变化不会热加载。重启前可以先只看组合结果：

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # 应出现 "# == dsh-aperture" 层
```

### 4. 确认

模型会出现在选择器里，路由名 `Aperture`。设置分在两处：**插件 → dsh-aperture** 那个包的配置页上是实例地址、注册开关与「立刻刷新」，模型目录在官方**设置 → 模型**页里本插件的路由卡上。

```
（插件 → dsh-aperture）
实例地址   已覆盖 恢复默认
[https://ai.example.ts.net                            ]
填 Aperture 的地址；留空即休眠，不再发现模型。

自动同步                              已覆盖 恢复默认   ●━
每轮发现之后，把这批模型注册成 dsh 里本插件自己的 provider 路由。   [保存]

已保存：已重新发现并发布。

模型目录与逐模型覆盖在「设置 → 模型」页里本插件的路由卡上：点开那一行，模型就列在下面。   ⟳ 立刻刷新
另有 1 个模型没有路由可服务（gemini-2.5-flash）：在配置里给它们写上 models[].protocol 就有路由；
接不进来的删掉即可。
```

```
（设置 → 模型）
DeepSeek                                            编辑
Aperture (OpenAI Chat Completions)  自定义                  编辑
  ────────────────────────────────────────────────────
  模型  18 个                                        ⌄
  一行一个模型；展开改这一行的覆盖，「保存」只写这一行。顺序来自发现顺序。

  ● deepseek-v4-flash
    上下文 1,048,576 · 输出 384,000 · 输入类型 文本+图像 · 推理 开 · 已覆盖 1 项

    （点开一行就是这一行的覆盖编辑器：名称与协议一组、容量一组，输入类型与推理各占一行，下面是「保存 / 清空覆盖 / 取消」。
      同一张卡里每一行都是同一条路由，卡片头已经写着它，行内不再重复「路由 / 协议」）

+ 添加模型提供商
```

**地址与注册开关**是同一份官方设置表单里的两个字段：写着「已覆盖」时，右边那颗「恢复默认」把它从设置文件里删掉（与官方「插件配置」页同一对词、同一个位置），按「保存」只发真的改动过的那一项。

分组靠标题与间距分开，模型那一行则是一张卡（发丝描边加大圆角，颜色只用本页真的定义过的主题 token），能点开的只有模型行。

**模型目录挂在官方「模型」页本插件那几行的扩展位上**（页主自己叫 Extension slots）：本插件注册的每一条路由就是那一页上的一行，那一行里挂一块，只画**那一条路由**的模型——能列在那一页上的模型因此一定真的有路由。

没有路由可服务的模型（配置里手写的、目录里没有的那些）不在那一页占座位，它们由配置页一句话交代：几个、叫什么，以及去哪儿给它们写协议。

这一块**默认收着**：折叠头（自己画的一行，上面一条细线）左边是标题与模型数目，右边常驻一枚箭头，点一下才摊开这一块——那一页的每一行都有这一块，摊开一次是十几行，收着才不喧宾夺主。

同一张卡里每一行都是同一条路由，卡片头已经写着它，行内因此不再重复「路由 / 协议」。

## 使用

界面分两处，各管各的：

- **插件 → dsh-aperture**：在插件列表里点开本插件，设置页挂在包上，所以没有单独的「配置」按钮。页头的名字、图标与那句描述来自本包的 `locale/*.json` 与 `package.json` 的 `icon`，页面本身由插件页画出。这一页只有实例地址与注册开关两项。
- **设置 → 模型**：本插件的模型目录挂在官方那一页上——每条路由的行里一块（那一行自己的模型）；没有路由可服务的模型不在这一页出现，它们由插件页那句话交代。那个座位的名字由页主自己声明，本插件只往里注册内容。

地址、开关与逐模型参数在按下「保存」之前都只是草稿；模型那部分**按行来**，收起一行不算放弃，行上的「有未保存的改动」标签会一直挂着。

| 位置 | 作用 |
| --- | --- |
| 插件页 · 实例地址 | 改 `baseUrl`（写入设置接缝；写着「已覆盖」时旁边那颗「恢复默认」把它放回缺省值） |
| 插件页 · 注册开关 | 改 `sync`：关掉就只探测、不注册——那一轮刷新会把本插件已经注册出去的三条路由撤下来，别处注册的同名路由不受影响；同样带「已覆盖 / 恢复默认」这一对 |
| 插件页 · 保存 | 表单下方，把地址与开关的草稿写进设置文档；有版本设栅，表单已经与设置文档脱节时会拒绝写入，而不是覆盖别处的改动；写完等这一轮重新发现落地才返回，界面随即显示新配置 |
| 插件页 · 立刻刷新 | 保存按钮旁边那一颗：不写设置，直接重跑一轮发现与注册，结果（成功，或者失败的原因）贴在同一页上，「这一轮哪里不对」那句话跟着变新 |
| 模型页 · 路由卡里的模型 | 一行一个模型，一行一张卡：行首一颗状态点（绿=这一轮注册上了路由，灰=这一轮注册过而它没注册上，鼠标停在上面或读屏都能听到这句话），第一行是名字与「已覆盖 N 项 / 有未保存的改动」几枚标签，第二行是带标签的事实（容量、输入类型、推理、别名；路由与协议同卡每一行都一样，卡片头已经写着，行内不再重复），长名字省略、事实随宽度换行；点开就是这一行的覆盖编辑器——显示名称、目录别名、API 协议三个输入框一组，「容量」一组（上下文窗口、最大输出 token 数），输入类型两个勾选框与推理一个三段开关（跟随发现 / 开 / 关）各占一行；字段下面只留一句来源（「来源：Aperture」），「留空即用发现到的名字」这类怎么做的话在标签旁边那颗「i」里，点开才占位置 |
| 模型页 · 保存 / 清空覆盖 / 取消 | 只写这一行，或者只清掉后台报告里确实被覆盖过的那几项，或者把这一行的草稿整个丢掉；「保存」同样等一轮重新发现落地，所以按完看到的就是新值 |
| 插件页 · 未服务的模型 | 报告里没有路由可服务的模型有几个、叫什么（最多报五个名字，多的写「等 N 个」）：给它们写上 `models[].protocol` 就有路由，接不进来的删掉即可；一条路由都没注册时改说这一句 |

就地编辑写的都是配置：容量与输入类型等落在 `aperture.models` 的对应条目上，目录别名落在 `aperture.modelAliases[id]`，写入按字段合并——界面没提到的字段原样留着（比如 `reasoningEfforts`），留空则表示这一项不覆盖、回落到发现值与目录。

容量认 `1M`、`100K` 这种写法（十进制后缀，跟官方「模型」页同一套词汇：`1M` 是 1000000，不是 1048576），存下去的仍是普通 token 数，输入框回写成能原样读回来的最短那个（`384000` → `384K`，而 `1048576` 不是整千，照原样写）。

「未服务」的模型不在这一页出现，它们的出路在配置里：给 `models` 里那一条写上 `protocol`，只在原生端点上应答的模型就能在对应路由上发布。

## 配置

所有键都写在 profile 补丁文档里那一行的 `config:` 下（用户层），不写的键一律回落下面这些缺省值。`baseUrl` 与 `sync` 能在插件页上就地编辑，`models`、`modelAliases` 里的逐模型参数能在「设置 → 模型」页里就地编辑；其余键只有配置文件这一条路。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture 实例地址。末尾 `/v1` 会被容忍并去掉；空值表示休眠（不探测、不注册） |
| `routePrefix` | `aperture` | 三条路由名的共同前缀：路由键是前缀加上协议名的小写连字符写法——`aperture-openai-chat-completions`、`aperture-openai-responses`、`aperture-anthropic-messages`；三个选择器名称同样由它推出来，各自写出同一串协议名：`Aperture (OpenAI Chat Completions)`、`Aperture (OpenAI Responses)`、`Aperture (Anthropic Messages)`（这三个名字逐字取官方「模型」页给协议用的产品名） |
| `apiKeyEnv` | `''` | 凭据 seam 里的引用名；非空时不再带占位凭据 |
| `headers` | `{}` | 每条请求额外带的头；同名时**归因头**与**占位凭据**仍会按协议补齐 |
| `enabledModelIds` | `[]` | 非空时只保留这些 id（`models` 里显式列出的不受限） |
| `modelAliases` | `{}` | 网关 id → models.dev id |
| `models` | `[]` | 逐模型覆盖或补充：`id`、`name`、`protocol`、`contextWindow`、`maxTokens`、`input`、`thinking`、`reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | 目录地址；设成 `''` 关闭补全 |
| `images` | `ignore` | `metadata` = 采用 models.dev 的输入类型（图片） |
| `reasoning` | `auto` | `off` = 所有模型都当不会推理 |
| `sync` | `true` | `false` = 只探测不注册路由（配置页仍可查看） |
| `refreshIntervalMinutes` | `0` | 定时刷新间隔；`0` = 只在启动和配置变化时刷新 |

容量与推理等级缺失时，按 Aperture 字段 → [models.dev](https://models.dev) → 保守默认值补全（兜底容量 128000、单次请求超时 20s、流式空闲上限 5 分钟是代码里的常量，不是配置项）。

`maxTokens` 只有模型自己声明过才会作为**默认输出上限**报给宿主：没人声明时不报，凭空编一个值会让每次请求都按它截断。

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

看**插件 → dsh-aperture** 配置页上那句话——它说有几个模型没有路由可服务、都叫什么（本插件的路由卡下面列的是那一条路由真的能服务的模型）。

只提供 Gemini 原生 `generateContent` 端点的模型接不进来——本插件可发布 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages，不能转换 Gemini 原生协议。走错端点时 Aperture 会明确告诉你该用哪个：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

### 想给某个模型更多推理等级？

默认只给保守的两档（DeepSeek 系 `off/high/max`，其它会推理的模型 `off/high`），自己加：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: deepseek-v4-pro
        reasoningEfforts: { off: disabled, minimal: minimal, low: low, medium: medium, high: high, max: max }
```

### 网关没列出的模型也想接？

用 `models` 显式补一条即可（比如配置页那句话里报出来的那几个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: gemini-2.5-pro
        api: openai-completions
```

### 模型的容量/推理标记没补上？

网关会改名，models.dev 上可能对不上（实测 `deepseek-flash`、`k3` 那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`）。显式映射：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    modelAliases:
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

### 界面上说 `没注册（路由 aperture-openai-responses 已被另一个适配器注册…）`？

说明请求的路由键里有一个已经被别人服务了——最常见的原因是**旧版本的本插件**：0.2 及更早只做发现，它会把自己发现的路由写进 `llm-pi-ai.providers`。

本插件不替你改别人的配置，照那一行给出的键名手工处理：删掉 `llm-pi-ai` 段里对应的 `providers.<键>`；如果那个路由名是别的插件在用的，就改本插件配置里的 `routePrefix`（三条路由键一起变）。下一个适配器集合变化（改完配置的重载、或者在插件页按那颗「立刻刷新」）就会重新尝试注册，不必重启。

### 从 0.2 或更早升上来，`llm-pi-ai.providers` 里那几个 `aperture*` 键要不要自己删？

要，而且这次没有哪个键会替你报错。

本插件现在的路由键是前缀加协议名（默认 `aperture-openai-chat-completions` / `aperture-openai-responses` / `aperture-anthropic-messages`），与那时写下的 `aperture`、`aperture-responses`、`aperture-anthropic` 一个都不同名，因此注册不会撞键。那三个遗留键留着只会让 `llm-pi-ai` 继续服务一份过期的路由（选择器里出现重复模型），升级时一并删掉即可。

### 配置里的 `route` 键去哪了？

它改名成了 `routePrefix`。旧键不报错，但会被 schema 忽略——前缀于是静默回到缺省的 `aperture`。

当初把前缀写成了别的名字（`route: my-gateway`）的话，升级后要把它抄到 `routePrefix` 上；只写过缺省值的话，把旧键删掉即可。

### 保存了但没生效？

DSH 的补丁层是叠加的：profile 的补丁文档之上还有 `$DSH_HOME/cordis.patch.yml` 这类更高优先级的层。

如果 `aperture` 这一行在那里也被写过，配置页上的保存会落在 profile 的补丁文档里、却被上面那层盖住（这一笔也可能被设置接缝直接拒收，配置页会说没被收下）。把那一行从高优先级的层里删掉，或者直接改那一处。

### 从 0.2 升上来，我的 `settings.yaml` 去哪了？

0.1.7 起设置不再有独立文件，而是落在 profile 的补丁文档里。

首次启动时 `$DSH_HOME/settings.yaml` 会被改名成 `settings.yaml.imported`，各段按设置命名空间搬进补丁文档——`aperture:` 段原样搬过去，仍能过 schema 的键与值都不变，所以地址与逐模型覆盖都还在。

此后被读的只有补丁文档，`settings.yaml.imported` 只是留档，改它没有用；搬不过去的段（值已不合法）也只留在那份留档里，并在日志里说一声。

### 本部署没有「插件」页 / 没有界面？

两处界面都只在 Web 界面里有（插件页那一份靠 Typert Remote 端点工作）。headless profile 里插件照常发现、照常注册路由，只是没有可点按的页面。

模型在官方「模型」页里也会出现相应的行（只有真的有模型的那几种协议才占一行）：那一行自己的编辑器对本插件是只读的（设置段是 `aperture`，不是模型页的通用表单），但本插件在那一行里挂了自己的一块编辑器，所以改模型还是那一页上的事（没有路由可服务的模型不在那一页出现，界面在时由插件页那句话交代）；没有界面时改配置。

### 需要真密钥而不是占位凭据？

Aperture 靠网络身份（Tailscale）认证，本不需要密钥；插件默认在每条请求上带 `authorization: Bearer dsh-aperture`（Anthropic 路由是 `x-api-key: dsh-aperture`），只是让 pi-ai 愿意把请求发出去，**不是密钥**。

真要密钥时把 `apiKeyEnv` 指向凭据 seam 里的记录，占位凭据就不再带。

### 改了 `routePrefix` 之后旧路由还在？

插件只认自己当前请求的三个键（`<前缀>-openai-chat-completions`、`<前缀>-openai-responses`、`<前缀>-anthropic-messages`），进程退出后旧键就没有服务者了；它不再出现在选择器里，也不需要清理，除非有别的适配器顶上那个键。

## 它做了什么

```
GET {baseUrl}/v1/models
        │
        ├─ 每个模型：supported_endpoints ──► 分流
        │     /v1/chat/completions        ──► routePrefix + -openai-chat-completions  （openai-completions）
        │     /v1/responses               ──► routePrefix + -openai-responses        （openai-responses）
        │     /v1/messages                ──► routePrefix + -anthropic-messages      （anthropic-messages）
        │     只有原生 generateContent     ──► 不发布（配置页那句话里报出来）
        ├─ 容量：Aperture 字段 ─► models.dev ─► 默认值
        ├─ 推理：Aperture 字段 ─► models.dev ─► 关闭
        └─ 注册成三条 provider 路由（<routePrefix> + 协议名的小写写法）
```

三条路由各自只承载一种协议，模型 id 就是网关的 id；本插件不写任何配置，发现结果只活在这一次注册里（重启后由第一轮发现重新决定）。路由键被别的适配器占着时本插件不硬闯：它跳过注册、在报告里点名那个键，并在适配器集合发生变化时自己重试。每条决策为什么是这样、放弃了哪些替代方案，见 [.agents/notes/implemented/](https://github.com/he0119/dsh-aperture/tree/main/.agents/notes/implemented)（中文）；当前机制与已知边界见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)。

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
