# dsh-aperture

把 [Aperture](https://tailscale.com/kb/1542/aperture) 网关上的模型自动发现出来，写进 DeepSeek Harness 的 `llm-pi-ai` 设置，让它们直接出现在模型选择器里。装好后你只需要填一个 Aperture 地址，其余交给插件。

## 安装

前提：Node ≥ 24，以及一个你能访问的 Aperture 实例。

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

本地改代码时，直接装仓库目录（先 `npm run build`）：

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

模型会出现在选择器里，路由名 `Aperture`。**插件 → dsh-aperture** 这个包的配置页就是这一页——上面是实例地址与同步开关，下面按行列出发现的模型。

```
实例地址   已覆盖 恢复默认
[https://ai.example.ts.net                            ]
填 Aperture 的地址；留空即休眠，不再发现模型。

自动同步                              已覆盖 恢复默认   ●━
每轮发现之后，把模型与参数写进 dsh 的 llm-pi-ai 路由。   [保存]

已保存：已重新发现并发布。

模型 18 个                                    ⟳ 立刻刷新
一行一个模型；展开改这一行的覆盖，「保存」只写这一行。顺序来自发现顺序，没有路由可服务的排在最后。

● deepseek-v4-flash
  路由 aperture · 协议 openai-completions · 上下文 1,048,576 · 输出 384,000 · 模态 文本+图像 · 推理 开 · 已覆盖 1 项
● gemini-2.5-flash
  路由 aperture · 协议 openai-completions · 上下文 128,000 · 模态 文本 · 推理 关
● qwen3-vl-32b  未服务
  上下文 262,144 · 模态 文本+图像 · 推理 开

  （点开一行，就是这一行的覆盖编辑器：名称与协议一组、容量一组，模态与推理并排，下面是「保存 / 清空覆盖 / 取消」）
```

**地址与同步开关**是同一份官方设置表单里的两个字段：写着「已覆盖」时，右边那颗「恢复默认」把它从设置文件里删掉（与官方「插件配置」页同一对词、同一个位置），按「保存」只发真的改动过的那一项。逐模型的覆盖编辑器见[使用](#使用)。分组靠标题与间距分开，模型那一行则是一张卡（发丝描边加大圆角，颜色只用本页真的定义过的主题 token），能点开的只有模型行。

## 使用

界面在 **插件 → dsh-aperture**：在插件列表里点开本插件，配置页挂在包上，所以没有单独的「配置」按钮。页头的名字、图标与那句描述来自本包的 `locale/*.json` 与 `package.json` 的 `icon`，页面本身由插件页画出。地址、开关与逐模型参数在按下「保存」之前都只是草稿；模型那部分**按行来**，收起一行不算放弃，行上的「有未保存的改动」标签会一直挂着。

| 位置 | 作用 |
| --- | --- |
| 配置页 · 实例地址 | 改 `baseUrl`（写入设置接缝；写着「已覆盖」时旁边那颗「恢复默认」把它放回缺省值） |
| 配置页 · 同步开关 | 改 `sync`：关掉就只探测、不写 `llm-pi-ai`——那一轮刷新会顺手把本插件已经发布的路由撤下来（只撤它拥有的那两个键，配置段里其他 provider 原样留着）；同样带「已覆盖 / 恢复默认」这一对 |
| 配置页 · 保存 | 表单下方，把地址与开关的草稿写进设置文档；有版本设栅，表单已经与设置文档脱节时会拒绝写入，而不是覆盖别处的改动；写完等这一轮重新发现落地才返回，界面随即显示新配置 |
| 配置页 · 模型 | 一行一个模型，一行一张卡：行首一颗状态点（绿=这一轮写进了路由，灰=这一轮同步过而它没写进去，黄=没有路由能服务它，鼠标停在上面或读屏都能听到这句话），第一行是名字与「未服务 / 已覆盖 N 项 / 有未保存的改动」几枚标签，第二行是带标签的事实（路由、协议、容量、模态、推理、别名），长名字省略、事实随宽度换行；点开就是这一行的覆盖编辑器——显示名、别名、协议三个输入框一组，「容量」一组（上下文容量、最大输出），模态两个勾选框与推理一个三段开关（跟随发现 / 开 / 关）并排；字段下面只留一句来源（「来源：Aperture」），「留空即用发现到的名字」这类怎么做的话在标签旁边那颗「i」里，点开才占位置；右上角「立刻刷新」立刻重新发现并发布，清单与每一行的状态跟着变新 |
| 配置页 · 保存 / 清空覆盖 / 取消 | 只写这一行，或者只清掉后台报告里确实被覆盖过的那几项，或者把这一行的草稿整个丢掉；「保存」同样等一轮重新发现落地，所以按完看到的就是新值 |

就地编辑写的都是配置：容量与模态等落在 `aperture.models` 的对应条目上，清单别名落在 `aperture.modelAliases[id]`，写入按字段合并——界面没提到的字段原样留着（比如 `reasoningEfforts`），留空则表示这一项不覆盖、回落到发现值与清单。容量认 `1M`、`100K` 这种写法（十进制后缀，跟官方「模型」页同一套词汇：`1M` 是 1000000，不是 1048576），存下去的仍是普通 token 数，输入框回写成能原样读回来的最短那个（`384000` → `384K`，而 `1048576` 不是整千，照原样写）。协议那一项是「未服务」模型唯一的出路：填上它就能让只在原生端点上应答的模型在对应路由上发布。

## 配置

所有键都写在 profile 补丁文档里那一行的 `config:` 下（用户层），不写的键一律回落下面这些缺省值。`baseUrl`、`sync` 与 `models`、`modelAliases` 里的逐模型参数也能在配置页上就地编辑；其余键只有配置文件这一条路。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `''` | Aperture 实例地址。末尾 `/v1` 会被容忍并去掉；空值表示休眠（不探测、不写入） |
| `route` | `aperture` | OpenAI 兼容模型的路由名；Anthropic 那条是它加 `-anthropic`，两个选择器名称也由它推出来（`aperture` → `Aperture` / `Aperture (Anthropic)`） |
| `apiKeyEnv` | `''` | 凭据 seam 里的引用名；非空时不再写占位头 |
| `headers` | `{}` | 每条请求额外带的头，**优先于**占位头 |
| `enabledModelIds` | `[]` | 非空时只保留这些 id（`models` 里显式列出的不受限） |
| `modelAliases` | `{}` | 网关 id → models.dev id |
| `models` | `[]` | 逐模型覆盖或补充：`id`、`name`、`api`、`contextWindow`、`maxTokens`、`input`、`thinking`、`reasoningEfforts` |
| `modelMetadataUrl` | `https://models.dev/models.json` | 目录地址；设成 `''` 关闭补全 |
| `images` | `ignore` | `metadata` = 采用 models.dev 的输入模态（图片） |
| `reasoning` | `auto` | `off` = 所有模型都当不会推理 |
| `sync` | `true` | `false` = 只探测不写设置（配置页仍可查看） |
| `refreshIntervalMinutes` | `0` | 定时刷新间隔；`0` = 只在启动和配置变化时刷新 |

容量与推理档位缺失时，按 Aperture 字段 → [models.dev](https://models.dev) → 保守默认值补全（兜底容量 128000、单次请求超时 20s 是代码里的常量，不是配置项）；`maxTokens` 没人声明时**故意不写**（在 `llm-pi-ai` 里它同时是每次请求的 `max_tokens` 上限，凭空编一个值会把请求截断）。

## 常见问题

**从 git 装的时候，第一次 `add` 失败、说构建脚本被忽略？** 按[安装](#1-装上插件)里 git 那段的 `allowBuilds` 写一行，然后重跑；或者直接用 npm 安装，不需要任何授权。

**装的时候警告 `Issues with peer dependencies found`？** 预期内：本包依赖的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-settings` 都由 DSH 自带并自行解析，不进 profile 的 `node_modules`，pnpm 看不到它们不影响运行。

**`Failed to resolve dependency: 文件名、目录名或卷标语法不正确。 (os error 123)`？** git 地址用了 `git@github.com:he0119/dsh-aperture.git` 这种 scp 风格——在 Windows 上冒号会被当作盘符，于是被当成**本地路径**。改用 pnpm 认的写法：`github:he0119/dsh-aperture`、`git+https://…` 或 `git+ssh://…`。

**本机 git 的 HTTPS 不可用（报 schannel / `SEC_E_NO_CREDENTIALS`）？**

```sh
git config --global url."git@github.com:".insteadOf "https://github.com/"
```

**有些模型没出现在选择器里？** 看配置页「模型」那一段里带「未服务」标签的行。只提供 Gemini 原生 `generateContent` 端点的模型接不进来——`llm-pi-ai` 只讲 OpenAI 兼容和 Anthropic Messages 两种协议。走错端点时 Aperture 会明确告诉你该用哪个：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

**想给某个模型更多推理档位？** 默认只给保守的两档（DeepSeek 系 `off/high/max`，其它会推理的模型 `off/high`），自己加：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: deepseek-v4-pro
        reasoningEfforts: { off: disabled, minimal: minimal, low: low, medium: medium, high: high, max: max }
```

**网关没列出的模型也想接？** 用 `models` 显式补一条即可（比如配置页里「未服务」的那几个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: gemini-2.5-pro
        api: openai-completions
```

**模型的容量/推理标记没补上？** 网关会改名，models.dev 上可能对不上（实测 `deepseek-flash`、`k3` 那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`）。显式映射：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    modelAliases:
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

**配置页上说 `设置：未写入（已处于同步状态）`？** 正常状态，表示设置里已经是最新内容。

**保存了但没生效？** DSH 的补丁层是叠加的：profile 的补丁文档之上还有 `$DSH_HOME/cordis.patch.yml` 这类更高优先级的层。如果 `aperture` 这一行在那里也被写过，配置页上的保存会落在 profile 的补丁文档里、却被上面那层盖住（这一笔也可能被设置接缝直接拒收，配置页会说没被收下）。把那一行从高优先级的层里删掉，或者直接改那一处。

**从 0.2 升上来，我的 `settings.yaml` 去哪了？** 0.1.7 起设置不再有独立文件，而是落在 profile 的补丁文档里。首次启动时 `$DSH_HOME/settings.yaml` 会被改名成 `settings.yaml.imported`，各段按设置命名空间搬进补丁文档——`aperture:` 段原样搬过去，仍能过 schema 的键与值都不变，所以地址与逐模型覆盖都还在。此后被读的只有补丁文档，`settings.yaml.imported` 只是留档，改它没有用；搬不过去的段（值已不合法）也只留在那份留档里，并在日志里说一声。

**本部署没有「插件」页 / 没有界面？** 配置页只在 Web 界面里有（它靠 Typert Remote 端点工作）。headless profile 里插件照常发现、照常写入，只是没有可点按的页面。若这个部署连可管理的 profile 都没有，`settings` 服务不存在，插件按硬依赖停在 `PENDING`——它唯一的职责就是写设置，没有设置可写时宁可不动。

**需要真密钥而不是占位头？** Aperture 靠网络身份（Tailscale）认证，本不需要密钥；插件默认写入 `authorization: Bearer dsh-aperture` / `x-api-key: dsh-aperture`，只是让适配器愿意发请求，**不是密钥**。真要密钥时把 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

**改了 `route` 之后旧路由还在？** 插件只认自己当前拥有的两个键（`route` 与 `route` + `-anthropic`），不知道历史上用过哪些名字，所以旧键会留在 `llm-pi-ai.providers` 里。它不报错、只是不再刷新；要清理就手动删掉那一行。

## 它做了什么

```
GET {baseUrl}/v1/models
        │
        ├─ 每个模型：supported_endpoints ──► 分流
        │     /v1/chat/completions        ──► route                     （openai-completions）
        │     /v1/messages                ──► route + -anthropic        （anthropic-messages）
        │     只有原生 generateContent     ──► 不发布（列进「未服务」）
        ├─ 容量：Aperture 字段 ─► models.dev ─► 默认值
        ├─ 推理：Aperture 字段 ─► models.dev ─► 关闭
        └─ 生成 llm-pi-ai 的 providers.<route>，按 revision 写进 profile 的补丁文档
```

写入只碰 `llm-pi-ai.providers` 下属于本插件的两个键：内容没变就不写；用路径操作写，你手写的其它 provider 原样保留；探测失败绝不删空已有目录；路由没模型了就删掉。实现细节（两条路由的取舍、容量与推理的来源优先级、生命周期与依赖、写入行为）见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)。

## 开发

```sh
npm install
npm run build      # tsc -> lib/（宿主半边）+ tsdown -> lib/client.js（浏览器半边）
npm test           # 单元测试 + 端到端（离线运行；需要已安装的 devDependencies）
```

改代码、跑测试与开发实例见 [docs/development.md](https://github.com/he0119/dsh-aperture/blob/main/docs/development.md)，发布流程与产物构成见 [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md)。

## 致谢

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)：本插件的参考实现，Aperture 模型发现的做法来自这个 VS Code 扩展。
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup)：界面接线的参考实现，Remote 端点的形状来自这个插件；配置页本身的挂载方式在 0.1.7 之后改由插件页的槽位契约给出。
- [Aperture](https://tailscale.com/kb/1542/aperture)（Tailscale）：提供被发现的网关。
- [models.dev](https://models.dev)：为 Aperture 未声明的容量与能力做补全。
- `@deepseek-ai/dsh-llm-pi-ai`：本插件只做发现，协议对接交给它。

## License

MIT
