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
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    baseUrl: https://ai.example.ts.net
```

这一层（profile 的补丁文档，即用户层）是本插件的设置命名空间 `aperture`。本包自带的 `cordis.patch.yml`（组合层）只声明这一行、不写 `config`：每个键的缺省值都在 schema 里，所以只写想改的键就够了，其余回落缺省值。注意补丁层是**整行替换**而不是深合并——这一行的 `config` 会整个取代组合层那一行的，正因为组合层没有 `config`，你写几项就只有几项。

也可以直接在界面里填：**插件**页里找到 `dsh-aperture` 那一行，点「配置」——配置页上的「实例地址」写的就是同一个 `aperture.baseUrl`，保存后落在同一个文件里。

### 3. 重启 DSH

bundle 变化不会热加载。重启前可以先只看组合结果：

```sh
npx @deepseek-ai/dsh --profile web --dump-config   # 应出现 "# == dsh-aperture" 层
```

### 4. 确认

模型会出现在选择器里，路由名 `Aperture`。最近一次刷新做了什么，看 **插件 → dsh-aperture → 配置**：状态段把每一行摆成一项事实，下面按路由列出模型。

```
▾ Aperture  ●                                  [立即刷新]
  Aperture  aperture.baseUrl
  实例地址  已覆盖 恢复默认
  [https://ai.example.ts.net             ]
  ☑ 同步到 llm-pi-ai   写入 provider 字典
                                                 [取消] [保存]
  ────────────────────────────────────────────────────────────
  最近一次刷新
  触发  配置变更        时间  2026-09-23 12:32:36
  耗时  286ms           结果  成功
  清单  422 个条目      端点  https://ai.example.ts.net/v1/models 列出了 16 行
  设置  向 llm-pi-ai 写入 2 个操作（aperture, aperture-anthropic）
  Aperture：https://ai.example.ts.net

模型与路由  15 个模型
已覆盖 1 个模型，其余沿用发现值与清单

aperture  openai-completions  11 个模型  ●                 [▾ 收起]
  → https://ai.example.ts.net/v1
  deepseek-v4-flash  DeepSeek V4 Flash  已覆盖            [▾ 收起]
    1,048,576 上下文窗口 · 384,000 输出 · 文本+图像 · 推理
    │ 显示名   [DeepSeek V4 Flash           ]   来自 models.dev
    │ 清单别名 [deepseek/deepseek-v4-flash]
    │ 上下文   [1048576]  生效 1,048,576 · 来自 aperture
    │ 最大输出 [384K]     生效 384,000 · 来自 aperture
    │ 输入模态 ☑文本 ☑图像   生效 文本+图像 · 来自 配置
    │ 推理     [跟随发现 ▾]  生效 开 · 来自 models.dev
    │ 协议     [跟随发现 ▾]  生效 openai-completions
    │ 显示名、容量与模态留空表示这一项不覆盖；容量认 1M、100K 这种写法……  [恢复默认] [取消] [保存]
  gemini-2.5-flash  Gemini 2.5 Flash                      [▸ 编辑]
    128,000 上下文窗口 · 文本 · 无推理

未服务  4 个模型  ●                                        [▸ 编辑]
```

**实例**是一张卡，卡体里两半：上面是地址与同步开关那块浅色编辑面，下面接着**最近一次刷新**那份只读诊断（同一块面上切一条线，不再另起一张卡——一份摘要不值得占一张卡的卡头）。卡头就是折叠开关——箭头加名字，形状照官方「插件列表」那页的分组头，默认展开，点了把两半一起收起来；卡头上的动作（`[立即刷新]`、`[撤掉已发布的路由]`）与按完的反馈都留在开关**外面**，折着也按得到、看得见。卡头那颗 `●` 说的是整张卡：地址能不能用，以及上一轮成不成功，哪种出问题都变红，悬停时点名是哪一种。哪一项是你自己写进设置文件的，就在那一项的标签旁边写着「已覆盖」，紧跟一颗「恢复默认」把它从设置文件里删掉——用的是官方「插件配置」那页同一对词与同一个位置（官方 `ValueField` 的 `badges`），因此「已覆盖」不会孤零零地挂在卡头上让人猜它说的是哪一项；模型行上那颗还会在悬停时点名覆盖了哪几项（界面不编辑的 `reasoningEfforts` 也在里面，因为那正是「恢复默认」要整条撤的原因）。**模型与路由**是页面级的一节：标题下面直接排卡片，跟官方「模型」页同一副骨架，不套外卡——一张卡一条路由，卡头写 `provider · 协议` 与模型数，展开后是「→ 地址」加这条路由承载的模型清单；模型行自己还能再展开一次，参数面就落在那一行里面（同一块浅色面上切一条线，不套第二层底色）。每张卡头右边的胶囊按钮就是这一张卡自己的动作；`●` 说的是它自己的状态：实例那张说地址与上一轮刷新、路由卡说这一轮有没有把它写进 `llm-pi-ai`（没写进去是红的）、「未服务」那张说有没有路由可用。

收起时第一层只有路由卡头，第二层只有一行事实（id、显示名与容量）；点「编辑」展开它自己里面那一层，每条来源就写在它描述的那个字段旁边（「生效 1,048,576 · 来自 aperture」）。一行一套「保存 / 取消」，按「保存」只写这一行，「取消」把这一行的改动整个丢掉。

## 使用

界面在 **插件 → dsh-aperture → 配置**（插件页里本插件那一行点「配置」）。页头的名字、图标与那一行描述来自本包的 `locale/*.json` 与 `package.json` 的 `icon`，页面本身由插件页画出；页面主体写着你当前的实例地址与最近一次刷新做了什么，下面按路由列出发现的模型，可以改地址、开关「同步到 llm-pi-ai」、按一下立刻重新发现、按一下把已经发布的路由从 `llm-pi-ai` 段撤下来，也可以就地为单个模型改参数。地址与开关在按下「保存」之前只是草稿；保存交给宿主半边写进设置接缝，因此有版本设栅——表单已经与设置文档脱节时会拒绝写入，而不是覆盖别处的改动。模型参数同理，而且**按行来**：展开的那一行改的是草稿，行上出现「待保存」，按「保存」才写，也只写这一行；「取消」把这一行的改动丢掉。

| 位置 | 作用 |
| --- | --- |
| 配置页 · 实例卡 | 实例地址、同步开关与最近一次刷新；卡头的圆点说地址能不能用、上一轮成不成功，悬停点名是哪一种 |
| 配置页 · 实例地址 | 改 `baseUrl`（写入设置接缝；写着「已覆盖」时旁边那颗「恢复默认」把它放回缺省值） |
| 配置页 · 同步开关 | 改 `sync`：关掉就只探测、不写 `llm-pi-ai`——那一轮刷新会顺手把本插件已经发布的路由撤下来；同样带「已覆盖 / 恢复默认」这一对 |
| 配置页 · 保存 | 编辑区右下角（左边是「取消」），把地址与开关的草稿写进设置文档；写完等这一轮重新发现落地才返回，界面随即显示新配置 |
| 配置页 · 最近一次刷新 | 卡体下半段那份只读诊断：最近一次刷新做了什么、被什么触发，以及清单、端点与设置写入的结果 |
| 配置页 · 立即刷新 | 实例卡头上的动作：立刻重新发现并发布，并把这一轮的报告摆出来 |
| 配置页 · 模型与路由 | 一节：一条路由一张可展开的卡（卡头写 `provider · 协议`、模型数与「这一轮有没有写进 `llm-pi-ai`」的圆点），展开后是地址与模型清单；没有路由可用的模型另起一张「未服务」卡 |
| 配置页 · 编辑 | 卡头上的胶囊按钮：在卡里展开下一层。路由卡展开模型清单，模型行展开它自己的参数面板——显示名、清单别名、容量、模态、推理、协议，每条事实来自哪里就写在对应字段旁边 |
| 配置页 · 保存 / 取消 | 只写这一行，或者把这一行的改动整个丢掉；「保存」同样等一轮重新发现落地，所以按完看到的就是新值 |
| 配置页 · 恢复默认 | 跟在被覆盖的那一项旁边：只清掉报告里写着确实被覆盖过的那几项，随即回落到发现值与清单 |

就地编辑写的都是配置：容量与模态等落在 `aperture.models` 的对应条目上，清单别名落在 `aperture.modelAliases[id]`，写入按字段合并——界面没提到的字段原样留着（比如 `reasoningEfforts`），留空则表示这一项不覆盖、回落到发现值与清单。容量认 `1M`、`100K` 这种写法（十进制后缀，跟官方「模型」页同一套词汇：`1M` 是 1000000，不是 1048576），存下去的仍是普通 token 数，输入框回写成能原样读回来的最短那个（`384000` → `384K`，而 `1048576` 不是整千，照原样写）。协议那一项是「未服务」模型唯一的出路：填上它就能让只在原生端点上应答的模型在对应路由上发布。

> 想让本插件发布的路由消失，就把同步开关关掉：那一轮刷新会把它们从 `llm-pi-ai` 段撤下来（撤的是本插件拥有的那两个键，配置段里其他 provider 原样留着）。

## 配置

所有键都写在 profile 补丁文档里那一行的 `config:` 下（用户层）。本包自带的 `cordis.patch.yml`（组合层）只负责把这行装进去、不写 `config`，所以不写的键一律回落下面这些缺省值。`baseUrl` 与 `sync` 也可以在配置页上改，`models` 与 `modelAliases` 里的逐模型参数同样可以在那里就地编辑；其余键只有配置文件这一条路。

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
看配置页上的「模型与路由」（「未服务」那一行）。只提供 Gemini 原生 `generateContent` 端点的模型接不进来——`llm-pi-ai` 只讲 OpenAI 兼容和 Anthropic Messages 两种协议。走错端点时 Aperture 会明确告诉你该用哪个：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

**想给某个模型更多推理档位？**
默认只给保守的两档（DeepSeek 系 `off/high/max`，其它会推理的模型 `off/high`），自己加：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
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
用 `models` 显式补一条即可（比如配置页里「未服务」的那几个 Gemini 模型，只要你知道它在 OpenAI 兼容端点上确实能用）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    models:
      - id: gemini-2.5-pro
        api: openai-completions
```

**模型的容量/推理标记没补上？**
网关会改名，models.dev 上可能对不上（实测 `deepseek-flash`、`k3` 那边叫 `deepseek/deepseek-v4-flash`、`moonshotai/kimi-k3`）。显式映射：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aperture
  config:
    modelAliases:
      deepseek-flash: deepseek/deepseek-v4-flash
      k3: moonshotai/kimi-k3
```

**配置页上说 `设置：未写入（已处于同步状态）`？**
正常状态，表示设置里已经是最新内容。

**保存了但没生效、界面上写着被更高优先级的配置覆盖？**
DSH 的补丁层是叠加的：profile 的补丁文档之上还有 `$DSH_HOME/cordis.patch.yml` 这类更高优先级的层。如果 `aperture` 这一行在那里也被写过，配置页上的保存会落在 profile 的补丁文档里、却被上面那层盖住。把那一行从高优先级的层里删掉，或者直接改那一处。

**从 0.2 升上来，我的 `settings.yaml` 去哪了？**
0.1.7 起设置不再有独立文件，而是落在 profile 的补丁文档里。首次启动时 `$DSH_HOME/settings.yaml` 会被改名成 `settings.yaml.imported`，各段按设置命名空间搬进补丁文档——`aperture:` 段原样搬过去，仍能过 schema 的键与值都不变，所以地址与逐模型覆盖都还在。此后被读的只有补丁文档，`settings.yaml.imported` 只是留档，改它没有用；搬不过去的段（值已不合法）也只留在那份留档里，并在日志里说一声。

**本部署没有「插件」页 / 没有界面？**
配置页只在 Web 界面里有（它靠 Typert Remote 端点工作）。headless profile 里插件照常发现、照常写入，只是没有可点按的页面。若这个部署连可管理的 profile 都没有，`settings` 服务不存在，插件按硬依赖停在 `PENDING`——它唯一的职责就是写设置，没有设置可写时宁可不动。

**需要真密钥而不是占位头？**
Aperture 靠网络身份（Tailscale）认证，本不需要密钥；插件默认写入 `authorization: Bearer dsh-aperture` / `x-api-key: dsh-aperture`，只是让适配器愿意发请求，**不是密钥**。真要密钥时把 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

**改了 `route` 之后旧路由还在？**
插件只认自己当前拥有的两个键（`route` 与 `route` + `-anthropic`），不知道历史上用过哪些名字，所以旧键会留在 `llm-pi-ai.providers` 里。它不报错、只是不再刷新；要清理就手动删掉那一行。

## 它做了什么

```
GET {baseUrl}/v1/models
        │
        ├─ 每个模型：supported_endpoints ──► 分流
        │     /v1/chat/completions        ──► route                     （openai-completions）
        │     /v1/messages                ──► route + -anthropic        （anthropic-messages）
        │     只有原生 generateContent     ──► 不发布（列进「未服务」）
        │
        ├─ 容量：Aperture 字段 ─► models.dev ─► 默认值
        ├─ 推理：Aperture 字段 ─► models.dev ─► 关闭
        │
        └─ 生成 llm-pi-ai 的 providers.<route>，按 revision 写进 profile 的补丁文档
```

写入只碰 `llm-pi-ai.providers` 下属于本插件的两个键：内容没变就不写；用路径操作写，你手写的其它 provider 原样保留；探测失败绝不删空已有目录；路由没模型了就删掉。

实现细节（两条路由的取舍、容量与推理的来源优先级、生命周期与依赖、写入行为）见 [docs/internals.md](https://github.com/he0119/dsh-aperture/blob/main/docs/internals.md)。

## 开发

```sh
npm install                # 若机器级 npm 缓存不可写：npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/
npm run typecheck          # 含 test/，并用 node --check 解析浏览器半边
npm test                   # 单元测试（172 个，离线运行；需要已安装的 devDependencies）

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live   # 端到端：真实 DSH 栈 + 真实网关
DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run inspect     # 手动走查：打印写入后的补丁文档与 LLM 解析结果（先 npm run build）
```

不在 Tailscale 网络里、没有真实实例时，上面两条可以对着一个假网关跑（载荷见文件头）：

```sh
node scripts/fake-aperture-gateway.mjs 54117
DSH_APERTURE_LIVE_URL=http://127.0.0.1:54117 npm run test:live
```

两半的构建方式不同，改代码时容易踩空：浏览器半边（`client/aperture.js`）是手写 CJS，DSH 按文件直接服务，改完刷新页面就见效；宿主半边（`src/*.ts`）跑的是编译产物 `lib/`，改完必须 `npm run build` **再重启宿主**，否则跑的还是上一次构建的代码。`lib/` 的 mtime 比 `src/` 旧就说明还没构建。

发布流程与产物构成见 [docs/releasing.md](https://github.com/he0119/dsh-aperture/blob/main/docs/releasing.md)。

## 致谢

- [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot)：本插件的参考实现，Aperture 模型发现的做法来自这个 VS Code 扩展。
- [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup)：界面接线的参考实现，Remote 端点的形状来自这个插件；配置页本身的挂载方式在 0.1.7 之后改由插件页的槽位契约给出。
- [Aperture](https://tailscale.com/kb/1542/aperture)（Tailscale）：提供被发现的网关。
- [models.dev](https://models.dev)：为 Aperture 未声明的容量与能力做补全。
- `@deepseek-ai/dsh-llm-pi-ai`：本插件只做发现，协议对接交给它。

## License

MIT
