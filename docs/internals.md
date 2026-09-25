# dsh-aperture 实现细节

安装与配置请看 [README](../README.md)；这里放的是设计取舍与内部行为，给需要改这个插件、或者想弄清「为什么是现在这样」的人看。

## 只做发现，不做转换

参考实现 [he0119/vscode-aperture-for-copilot](https://github.com/he0119/vscode-aperture-for-copilot) 需要自己实现一套 provider；而 DSH 里已经有 `@deepseek-ai/dsh-llm-pi-ai`，它会讲 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。所以本插件**不做任何 API 格式转换**：它把探测结果翻译成 `llm-pi-ai` 的 provider profiles，剩下的交给现成的适配器。

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

（设置命名空间就是 profile 里那一行的 `id`——`llm-pi-ai` 那一行由官方基础 profile 声明，本插件这一行是 `aperture`。`dsh-llm-pi-ai` 自己也是这么取命名空间的：`ctx.fiber.entry?.options.id ?? 'llm-pi-ai'`。）

## 为什么最多有三条路由

Aperture 是按**端点**网关的：同一个模型不是所有协议都收。实测（`https://ai.long-antares.ts.net/`）：

| 模型 | `supported_endpoints` | 结果 |
| --- | --- | --- |
| 11 个（DeepSeek / MiMo / Grok / Qwen / LongCat …） | `/v1/chat/completions` | 走 `aperture` |
| Responses 模型 | `/v1/responses` | 走 `aperture-responses` |
| `MiniMax-M3` | `/v1/messages` | 走 `aperture-anthropic` |
| 4 个 Gemini | `/v1beta/models/{model}:generateContent` | 不发布 |

走错端点的失败是明确的（Aperture 直接告诉你该用哪个）：

```
404 model "gemini-2.5-flash" is available via gemini_generate_content, not openai_chat
404 model "MiniMax-M3" is available via anthropic_messages, not openai_chat
```

`llm-pi-ai` 不讲 Gemini 原生协议，所以 Gemini 那 4 个**无法**接入——插件会把它们列出来，而不是发布一堆必然 404 的模型。

## 关于「占位凭据」

`llm-pi-ai`（更准确地说，它背后的 pi-ai）在没有任何密钥时会直接抛 `No API key for provider`。Aperture 靠网络身份认证，本不需要密钥，所以插件默认写入一个占位请求头：

- `aperture` 路由 → `authorization: Bearer dsh-aperture`
- `aperture-anthropic` 路由 → `x-api-key: dsh-aperture`

**这不是密钥**，只是让适配器愿意发请求。实测 Aperture 对垃圾 Bearer 照常返回 200。如果你确实需要真密钥，用 `apiKeyEnv` 指向凭据 seam 里的记录，占位头就不会写入。

## 容量与能力的来源优先级

| 事实 | 优先级 |
| --- | --- |
| `contextWindow` | Aperture `context_window_tokens` / `max_input_tokens` / `limit.context` → models.dev → 代码里的兜底常量 128000 |
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

- `settings` 是**硬依赖**（`inject = ['settings']`）：本插件的职责就是往设置里写，没有它发布对象都不存在，所以宁可让框架把插件挂在 `PENDING`，provider 被替换时自动卸载、恢复后重新加载，而不是留着一个无处发布的实例。（`settings` 本身要求 `configEditor` 与 `profileContext`，因此这一层依赖等于说「这个部署得有一个可管理的 profile」。）
- `typert` **不声明**，也只用于界面：配置页需要的三个端点（报告、立刻刷新、按行编辑）经 Typert Remote 暴露，而 Typert 注册表只有 Web 这类装配了网关的 profile 才有。headless profile 里这一整块被跳过，发现照常运行，只是没有可点按的界面。
- 定时刷新用 `ctx.effect` 注册，卸载自动清理。
- **第一次发现不靠注册动作触发**：`aperture:` 这一段由 profile 的补丁层给出（本包组合层 + 用户层），插件挂载时读到的已经是叠加后的结果，不必为了对齐两份配置再刷一遍。配置变化经 Loader 的 `loader/volatile-update` 事件通知（`index.ts` 里那一个 `ctx.on`），据此重算定时刷新间隔并唤起一轮刷新。
- 配置是**活引用**（`Volatile`）而不是快照：改 profile 补丁文档里的 `aperture:` 段，下一次刷新立刻用新值，不必重启、也不必重载插件。

## 为什么整段配置都是 volatile 的

`schema.volatile()` 标在整段 `Config` 上，而不是逐个字段。0.1.7 的设置面只把 **volatile** 字段当成可以就地生效的配置：`volatileForm()` 遇到整体 volatile 的 schema 会把整段原样交出去（`isVolatilePath()` 于是对每条路径都为真），`projectForm()` 也会投影每个声明的字段，因此「改配置 → Loader 发 `loader/volatile-update` → 不重挂插件」这条路对每个键都成立，而设置面看到的仍是一份有 schema、有默认值的完整表单。

逐个字段标也做得到，但那等于把「哪些键改完需要重挂插件」写进 schema，而本插件每个键都只被下一轮刷新读取——重挂只会白掉一次发现。整段 volatile 的代价与收益都在 Loader 那边：`equalExceptVolatile()` 判定为纯 volatile 变化时，新配置直接生效、不重载；提交失败只记一条 `logger.warn`，旧值继续用。

volatile 只改**配置怎么被持有**，不改校验：非法值仍然在 `Config(raw)` 就抛（`ValidationError`，带 `$.models[0].id missing required value` 这种路径），缺省值仍然会补齐，`accepts()` 那类用例一个都不用动；只有**读值**要改成 `configValue(ref)`（内部一句 `ref.get()`）。

## 写入行为

插件只碰 `llm-pi-ai.providers` 下的三个键（`route` / `route` + `-responses` / `route` + `-anthropic`），并且：

- **内容相同就不写**——每次刷新都对比解析后的段，避免无意义的重写和文件监听回环；
- **用路径操作写**——你的其它 provider 一个字段都不会动；
- **探测失败就不写**——网关临时不可达时保留已经生效的目录，而不是清空；
- **带 revision 写**——与其它写入者（比如模型页）冲突时重读一次再写；
- **路由没模型了就删掉**——避免留下指向旧目录的空路由；
- **关掉同步就撤下**——`sync: false` 表示「本插件不该在这里留东西」，因此那一轮刷新发出的是一份空方案，`planSync` 会把三个拥有键 unset 掉（配置段里别的 provider 不动）。留着一份不再由配置决定的清单，界面看不出还有谁在服务，用户只能自己去翻 `llm-pi-ai` 段。撤下与「发布 N 条路由」走的是同一条路（空方案），没有第二条清理路径。
- **写入必须从 HMR 事务之外发起**——设置写入整次都在事务里（`config-editor.edit()` 把 `run()` 包在 `hmr.runExclusive()` 里），而 `loader/volatile-update` 正是在那个事务里**同步**发出来的：事务的 AsyncLocalStorage 印记会跟着从事件处理器里起的 promise 链一路走，事件那一轮早跑完了也不掉。于是直接在事件里刷新，那一轮对本配置段的写入就会被判成事务嵌套而拒绝（`HMR transactions cannot be nested`），配置页上显示成「没写（…）」——而发现本身看起来是成功的（模型列表、路由、耗时都在），只有宿主日志里那句 `发布发现的清单失败` 说的是实话。表现最典型的一步是**填地址那次保存**：地址空着时插件是休眠的（启动那一轮不发请求也不写），第一次真正要写 `llm-pi-ai` 的时刻恰好就是这次配置写入打开的事务里，于是两条路由一条都发布不出去。
  本插件因此把**每一轮刷新**都交给 `src/relay.ts` 那条通道起跑：它在**模块作用域**被拉起（模块求值不在任何事务里），事务里只负责把它叫醒；作业的续体注册在通道自己的上下文里，于是整轮都在事务之外，而写入照旧排在 HMR 队列后面（换的是上下文，不是串行）。通道按模块持有而不是按插件实例：源码热重载会让插件在事务里重建，实例里拉起的通道会跟着带上印记，而本模块通常留在模块缓存里。定时器、事件、插件加载三条来路都经它——它们是同一个问题的三种现场。

配置页上说 `设置：未写入（已处于同步状态）` 是正常状态。

插件自己的配置（`aperture` 段）则写在 profile 的补丁文档里，也就是「插件」页里这一行点「配置」之后编辑的那个文件。本包自带的 `cordis.patch.yml`（组合层）**故意不写 `config`**：缺省值只有 schema 一处；而补丁层是**整行替换**，`config-editor` 写下去的是整份 `next`、不会把与继承层相同的键逐个剔掉——组合层只要把缺省值摆出来，用户第一次在界面上保存就会把它们全量抄进自己的文件，「已覆盖」的判据（键在不在用户层里）于是凭空为真，将来改动某个缺省值也会被那份文件钉死。

## 界面：一条契约、两半实现

配置页挂在**插件页**里本插件那个**包**上：包级配置槽位 `plugins.bundle.config`，键就是包名 `dsh-aperture`，插件页把该槽位上注册的组件放进「这个包的配置」那一节。页头（面包屑、图标、名字、`aperture` 与 `dsh-aperture` 两行代码、那句描述）由插件页自己画，只有正文是我们的；名字、图标与描述也不是我画的，而是插件页从包元数据里读的——`locale/*.json` 的 `meta.title` / `meta.description`（文件名就是语言 id，`readPluginMeta` 读整个目录）与 `package.json` 的 `icon`（清单目录内的 SVG，≤256 KiB，读成 `data:` URL）。所以注册只给三件事：

```js
scope.slots.inject('plugins.bundle.config', () => scope.slots.register(
  {
    name: 'plugins.bundle.config',
    key: 'dsh-aperture',
    locale: NS,
    inject: () => ({ hooks: { apertureCard: card }, panel, edit, resetField, discard, save, failed }),
  },
  AperturePanel,
))
```

**行级槽位（`plugins.row.config`）不用。** 插件页里一行有「配置」按钮，是因为那一行有它自己的设置段；本插件的设置段与那一行是同一份，两个槽位只会让同一份界面出现在两个入口。包级页面是唯一入口（官方唯一一个包级配置页是 `dsh-experimental-client-ui-voice-input`，写法相同），也只有 `'page'` 一种用法：插件页只在这一处渲染它，没有行级页那种 `'summary'` 简写，也不像行级页与条目级页那样收到页主递来的 `form`。

浏览器半边只注入 `slots` / `locale` / `remote` / `configForms` 四个服务。`baseUrl` 与 `sync` 这两项**设置**不自己往返：页主不递 `form`，因此按设置命名空间自己取——`ctx.configForms.get('aperture')`，服务按命名空间缓存控制器，拿到的与插件页自己那份是同一个。它给出的快照就是官方设置表单要的那个作用域（`status` / `value` / `base` / `user` / `revision` / `writable`），于是草稿、脏标记、`revision` 围栏写入、冲突拒绝、只读与「命名空间没在服务」的说明全交给设置接缝（`SettingsFormModel`），本插件不复制一套；写完仍然等一轮刷新落地（见下）。「已覆盖」看的是字段在不在用户层里（`overrideKeys`，与官方同一条判据），而不是值等不等于组合层，这两件事不是一回事。`configForms` 缺席时（注入表保证不会，但这一页不该因此整页消失）表单接到一个 `unavailable` 替身上，官方表单自己画那句「读不到」，报告照旧显示：报告才是这一页每次都有的东西。

Remote 端点的形状来自参考实现（[`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup)）。除此之外：

- **发现结果与逐模型编辑走 Remote，设置不走。** 报告、立刻刷新与逐模型编辑挂在 `aperturePanel` 命名空间上（`src/remote.ts` 的宿主服务 + `src/panel.ts` 的三个端点）。发现结果不是配置：把它塞进设置文档会让「用户写了什么」与「插件发现了什么」混成同一份账，而后者每轮刷新都会被重写。逐模型编辑要宿主来做，是因为它得先读用户层、按字段合并、把非法值挡在写入之前——这些判断属于插件而不是界面。地址与同步开关没有这层需要，它们就是设置文档里的两个键，因此读 `configForms.get('aperture')` 那份作用域，不借道 Remote。宿主侧仍然用 `ctx.settings.configure({ auto: false }, ctx.fiber)` 声明「这一行自己出页面」——这一句必须在 `ctx.effect` 里注册（`configure` 重复注册会抛），于是插件页不再给它多画一份通用表单。
- **报告是数据，不是句子。** `src/report.ts` 只组装结构（哪个模型属于哪条路由、每条事实来自哪里、用户写了哪些覆盖），措辞与排版都在浏览器半边按语言组织——配置页是双语的，把中文句子拼在宿主半边等于让英文界面显示中文。
- **逐模型编辑按字段合并，一次只写一个模型。** `edit` 收 `(id, patch)`：界面上一行一个「保存」，写下去的就只有那一行，版本校验也只管这一次写入。补丁是**稀疏**的：界面只发它改动过的字段，没提到的原样留在设置文档里（`reasoningEfforts` 界面根本不编辑，因此不会被顺手抹掉）；空串与 `null` 表示「这一项不覆盖」，`patch` 传 `null`（而不是缺省）才是「整条撤销」——缺省是调用方写错了，宿主会拒绝，因为「什么都没改」与「撤掉一切」差得太远。容量、模态、推理与协议落在 `models` 的对应条目上，清单别名落在 `modelAliases[id]`；写入时按位置替换数组元素，改一个字段不会让这条覆盖挪到数组末尾。撤销别名之前先看**用户层**有没有这个键：界面显示的是生效别名，它可能来自组合层或清单，删一个不存在的键要么白写、要么被设置服务当成坏路径拒绝。非法值在写入前就被挡下来——写进设置文档的坏值会让下一轮刷新的 `resolveConfig` 直接抛异常，那时用户已经在别处改坏了配置。
- **空值不算声明。** 运行时 schema 给 `models[].input` 的缺省值是**空数组**，`reasoningEfforts` 也可能被写成 `{}`；两者都不是「这个模型没有任何模态 / 没有任何推理档位」的意思（想声明纯文本的是 `images: ignore`），却都会一路传到发布出去的 provider 里。`input: []` 抹掉发现到的模态，还谎称来源是配置；`{}` 更狠：`llm-pi-ai` 适配器以「reasoningEfforts 是空的」为由拒绝**整段**写入，于是三条路由一条都发布不出去、每张路由卡都亮红点，而原因只写在「最近一次刷新」的设置那一行里。两处都按「没写」处理（`registry.ts` 的 `declaredInput`、`profile.ts` 的 `declared`），并且用例**先过一遍 schema** 再断言——单元测试里手写的选项对象没有这个缺省值，正是这一点让 `input: []` 躲了很久。第三处是唯一会被用户看见的：报告曾经拿**解析后的配置**算「用户写过哪些覆盖」，于是 `input: []` 让一行什么都没写过的模型挂上「已覆盖」，而按「恢复默认」发下去的是 `input: null`——用户层里根本没有这个键，写下去是空操作，那颗标签于是永远撤不掉。现在报告只收用户层原样的条目（`buildReport` 的 `declared`）并收成 `overrideKeys`：**键在不在用户层里**，与官方同一条判据；界面不编辑的键（`reasoningEfforts`）也在名单里，因此「恢复默认」知道自己该整条撤。写回时同理（`panel.ts` 的 `prune`）：生效值里的空值不会被搬进用户层，否则一次「保存」就等于替用户写下他从未写过的覆盖。
- **写完等一轮刷新落地才回答。** 配置页拿到回答就会重读报告，而报告里的路由与模型事实来自**最近一次刷新**（只有「已覆盖」与别名来自实时配置）。因此两条写路径在写入之后都 `await runtime.refresh('配置变更')`——Remote 的 `edit` 在宿主侧做，地址与同步在浏览器半边等 `form.save()` 回来之后做；不等它，界面重读到的还是旧配置算出来的那一份，也就是「保存了却没变」。这里不必担心多跑一轮：设置变更本身就会唤起同一轮刷新（Loader 的 `loader/volatile-update`），而 `refresh` 的承诺是「返回的那一轮读的是**此刻**的配置」——正在跑的那一轮读的就是此刻这份配置时调用方并进它，读的是更早的配置时才排到它后面（排队者共享排上的那一轮）。配置的身份可以直接比：设置服务每次提交都换一份深冻结的解析结果，没变就还是同一个对象（`memoizedConfig` 按源缓存，那个对象身份**就是**配置版本）。
- **只做按行编辑，没有批量。** 端点就是 `(id, patch)`，一次一个模型、一次版本校验。「恢复默认」也是这一行的补丁，只是全是 `null`。把多个模型打包成一个批次在这里没有对应场景——界面上不存在「一次改好几个再一起提交」这种动作——却会多出「一半写下去怎么办」这种必须解释的失败态。

### 界面用官方原语，颜色只引用「这一页真的定义过」的 token

界面里没有自己的设计语言，也没有手抄的字面量：控件全是官方原语包（`@deepseek-ai/dsh-client-ui-primitives` 的 `SettingsForm` / `SettingsValueField` / `Button` / `Switch` / `Checkbox` / `SegmentedControl` / `Tag` / `StateDot`），本仓库只补排版（分组间距、字段栅格、事实的排法）与模型行那张卡：`border-l4` 一档发丝描边加 `--dsw-radius-xl`，编辑器内嵌面用 `bg-layer-3` 加一圈 `border-l2`。原先那份「对着官方「模型」页逐条抄字面量」的自画 CSS 删掉了：抄来的字面量会随官方改动过期，而原语包不会——在 `dsh.client.inject` 里声明依赖，客户端模块系统就把它的工厂注册进来供 `require`。

**别引用只在别的页面定义过的 token。** 卡片最初写的是官方「模型」页那张卡的配方（`--dsw-alias-settings-card-fill` / `--dsw-alias-settings-card-stroke`），在插件页上却连边都看不见：那两个名字只活在官方「模型」页自己那份组件 CSS 里，这一页根本没有，于是 `var()` 落到回落值——白 16% 的描边画在白底上，亮色主题下等于没有（暗色主题反而正常，这就是它一直没被发现的原因）。能放心用的只有两类：Theme 检查面列出的那十几个名字，以及官方原语自己用的那几个（`bg-layer-3`、`border-l4`、`interactive-bg-hover`）。另外亮色主题下 `bg-layer-*` 全是白色——官方那些层靠阴影分开——所以卡片只能靠描边立住，底色只是给暗色主题加一点抬起感。

**组靠标题与间距，行才配一张卡。** 页面上从上到下两块：设置表单（官方 `SettingsForm`，它自带保存按钮、只读与「读不到」的说明）与模型清单。分组之间 20px、组内 12px，分组标题就是一行小字。摘要不值得一个卡头，而一行模型值得：它是一个能展开、能改、能单独写回去的对象，卡片的边框把「这一行的边界」画出来，行与行之间也就有了 8px 的呼吸。

**设置表单那一套管草稿与写入。** `SettingsFormModel(scope, specs)` 收的是「字段怎么在存下来的值与输入框里的文本之间换算」：`settingsTextField('baseUrl')` 加一个布尔字段的规格（`'true'` / `'false'` 两个词，空串表示这一项不写）。草稿、脏标记、非法值、只读与 `revision` 围栏都在它自己手里，页面只读 `form.bind(...)` 的投影（`shell()` 加那两个字段），动作是注入面里的 `edit` / `resetField` / `discard` / `save`。因此「已覆盖 / 恢复默认」跟着字段走，用的就是官方那对词与那个位置；同步开关也是同一份表单里的一个字段，不另写一套写路径。

**模型行的卡头是自己画的按钮，不用 `DisclosureRow`。** 官方那个是根 24px 高、`overflow: hidden` 的横条，标题又是 `flex: none` 不许收缩，于是名字一长就把右边的事实与标签挤出可视区；它也只收一个 `icon` 与一行 `title`，塞不下「名字与标签一行、事实另一行」这种两行身份。现在行首是一颗盖满整行的 `button`（自己带 `aria-expanded`），里面三段：状态点、身份、箭头。身份第一行是名字（过长省略，`title` 里留着全名）加「未服务 / 已覆盖 N 项 / 有未保存的改动」几枚标签，第二行是事实。事实写成**带标签的**短语（`路由 aperture`，不是裸的 `aperture`）并用 `·` 分隔、随宽度换行：原先那串用 `·` 连起来的十一项，用户得自己数到第几项才知道哪个是协议。展开/收起仍是本地 state、按行记；收起**不丢草稿**——收起来不等于放弃，那颗「有未保存的改动」会一直挂着，要放弃得按「取消」。状态点仍是官方 `StateDot`，但它现在说三件事：绿是这一轮写进了路由、灰是这一轮同步过而它没写进去、黄是根本没有路由能服务它；同步那一轮没跑（关着）时不装作「没写进去」，而是说「这一轮没有同步，写没写进去看不出来」——报告里根本没有这一项。官方 `StateDot` 自己是 `aria-hidden`，说给谁听得由外层 `role="img"` 的 `aria-label` 给。

**页面持有状态，行与编辑器只按 props 画。** 草稿与展开是两张按模型 id 记的表，长在 `AperturePanel` 上，动作也在那里按这一行绑好（`onToggle` / `onStage` / `onSave` / `onCancel` / `onClear`）再递下去；`ModelRow` 与 `ModelEditor` 自己不持有 state。这不是「为了拆而拆」：这几件状态本来就不属于某一行——收起一行不丢草稿、写完一行页面顺手把它收起来、两行各改各的，说的都是「同一份状态喂给多行」。草稿到补丁的换算（改了哪几项、该发什么出去、容量读不读得出来）在 `draft.ts` 里，因此行首那颗「有未保存的改动」与编辑器底部那句「有 N 项改动还没写下去」问的是同一个函数，两处说法不会打架。

**编辑器里的字段也是官方那两个字段组件。** 文本字段用 `SettingsValueField`，按「名称与协议」（名字、别名、协议）与「容量」（上下文容量、最大输出）分两组，每组内部是 `auto-fit minmax(210px, 1fr)` 的栅格；模态是两个 `Checkbox`、推理是一个 `SegmentedControl`（跟随发现 / 开 / 关，「跟随发现」就是这一项不写），这两块并排——它们都是「一个开关加一句话」，横着放比竖着叠省一半高度。不摆成一个大栅格是因为官方 `.field + .field` 会给相邻字段画一条半宽的分隔线（specificity 0,2,0），`auto-fit` 一换行线就对不齐了；每个字段外面套一层 `.dap-fieldCell` 就绕开了，不必动 `!important`。一行的动作是「保存 / 清空覆盖 / 取消」（都是 `sm`）：官方「改完点卡片底部的应用」在只有一个编辑对象时很自然，而一份草稿对应多行时「按了保存到底写了哪几行」没有答案，因此一行一个保存按钮（它就在这一行里面，不必再自称「这一行」），版本校验也只管这一次写入。动作左边还有一句「和已保存的值相同 / 有 N 项改动还没写下去」：按下去之前先知道这一按会不会真的写。

**来源跟着字段走，长解释收进「i」。** `provenance` 是「这一项事实从哪儿来」的诊断信息。字段下面只留一句来源（`SettingsValueField` 的 `hint`：`来源：Aperture`）；「留空即用发现到的名字」这类怎么做的话收进官方的 `help`，也就是标签旁边那颗「i」——点开才占位置（`fieldHelp` 给 `aria-label`：`显示名称的说明`）。勾选框与分段开关那两行官方组件没有 `hint`，来源就挨着控件写一句。理由：一个字段下面挂两句（怎么做 + 从哪来），五个字段就是十行灰字，正文被诊断信息盖住。协议没有单独一项来源：写过就是配置，没写过就是从通告的端点推导出来的。

**「发现报告」那一块删掉了，但它那两句诊断留下了。** 原先它自己占一段：路由一列（`provider`、协议、模型数、「已写入 / 未写入」）加一张 `dl` 事实表（触发、时间、耗时、结果、清单、端点、写入）。删的理由是它讲的账在别处都讲过了：写没写进去，每一行开头那颗状态点就在说；模型属于哪条路由，「路由 x」那项事实就在说；刷新整个失败，`run()` 已经把宿主那句话贴到提示语上了。真正只有它说过的剩下两句——**清单读不到**（`catalog.available === false`，这时模型列表会是空的，不说原因等于没说）与**这一轮该写的没写进去**（`sync.applied === false`）——它们现在挂在模型那一段的提示语下面，正常的一轮（同步关着、或者写成功了）一个字都不说（`roundProblem`）。没有实例地址时的空状态也换成了那句「还没有实例地址：填上并保存之后才会去发现模型」：地址空着发现根本不会跑，「还没发现到模型」在那儿等于没说。宿主半边的报告一个字段没动——它是数据，界面只是不再整块摊开它。

**模型行上的「清空覆盖」写的是这一行的补丁，不是整条删除。** 报告里的 `overrideKeys` 写着这一行**确实**在用户层里写过哪几项，按钮就把认得的那几项逐个 `null` 发出去（别名那一项用空串），而不是丢掉 `aperture.models` 里整条条目——后者会把界面根本不编辑的键（例如 `reasoningEfforts`）一起扔掉。反过来，只要有**一个**界面不认识的键在名单里，就只能整条撤：只清认得的那几项，这一行在报告里仍然是「已覆盖」，那颗标签会按不下去——用户报上来的正是这个现象。别名单独落在 `modelAliases` 里，因此撤的时候写空串而不是 `null`。

**容量读写同一套 K/M 词汇（与官方「模型」页共用一套写法）。** 输入框认 `1M`、`100K`，后缀是**十进制**的（`1M` = 1000000，不是 1048576），存下去的仍是普通 token 数；回写成能原样读回来的**最短**形式（`384000` → `384K`，而 `1048576` 不是整千，照原样写出来）；提交时按**解析后的值**比较，因此 `100k` 与 `100K` 是同一个数、不算改动——否则值没变却会往用户层里写一笔，那一行就凭空多一颗「已覆盖」。两边就是官方那两个函数（`parseCapacity` / `formatCapacity`）：空串是「这一项不覆盖」，读不出来的在本地挡下——`1G`、`1.5`、`0` 都不发端点，因为面板那一层只收不小于 1 的整数，让它过去只会换来一次没必要的往返。挡的是同一条判定（`capacityBad`）：输入框上标出「读不出来」，按保存则弹一句带字段名的提示，两处不会给出不同答案。容量在收起那一行的事实里仍写成 `1,048,576` 这种带千位分隔符的原文：那说的是**生效值**，不是你要填的那个数。

官方原语包只有运行时导出、没有随包发布的类型声明，因此这一页 `require` 的是构建产物里的名字；拼错一个名字只会在挂载时抛一句 `undefined is not a function`，所以那份名单与每个原语的 prop 语义由 `test/client.test.ts` 的替身模块钉住（替身只保证接缝语义，官方组件的观感不在本仓库的测试范围内）。

### 端点描述符是手写的，但线格式只有一层直通

生成描述符的 Typert 生成器并不随 DSH 发布，因此两半边都手写。宿主用 `src-json` 编解码器；浏览器半边只需要一个**直通**的 strict 编解码器——不是因为图省事，而是因为浏览器侧从不解析这些值：注册表（`@deepseek-ai/dsh-typert-registry`）只检查 `mode` 是 `strict`、`typeSymbol` 非空、`create` 是个函数；网关客户端只读参数上的 `mode` 与结果上可选的 `decode`/`encode`，**没有一处调用 `create()`**，逐字段手写一套 wire 校验因此永远不会执行。曾经那三百行文法还顺手埋了个雷：注册表要的是 `create` 工厂，`schema` 字段不被承认，于是 `$mount` 抛 `strict codec has no create() factory`、整份贡献被拒，界面安静地什么都不出现。现在只剩一个 `{ parse: (value) => value }`，`test/client.test.ts` 把键集（`create` / `mode` / `typeSymbol`）与工厂一起钉住。

参数名与顺序就是宿主方法的形参表：调用点按位置传参，网关按 `wire` 映射，并且自动省掉 `undefined` 实参（`if (value !== void 0) args[parameter.wire] = value`），所以「没提到的参数」天然就是「不碰」。`test/client.test.ts` 会加载真实的浏览器半边，断言它的端点集合、id 与参数名跟宿主那半边完全一致。

端点名另有一条不显眼的约束：api-gateway 在客户端给每个命名空间建一个 `RemoteNamespaceService`，端点会成为它的属性，因此与它自己的成员（`ctx` / `empty` / `invokeRemote` / `methods` / `name` / `namespace` / `has` / `install` / `installDirect` / `installScoped` / `assertMethodAvailable` / `remove`）重名时，`validateContribution` 会拒绝**整份**贡献——浏览器里只留一行 `console.error`，界面安静地什么都不出现；新端点起名时先对一遍这份名单，`test/client.test.ts` 把它抄成了护栏。

### 浏览器半边也要构建

源码在 `src/client/`：`index.ts` 是唯一的装配点（`apply` / `mountRemote` / 注册），页面在
`AperturePanel.tsx`（一行模型与展开后的编辑器在 `ModelRow.tsx` / `ModelEditor.tsx`，草稿与补丁的
换算在 `draft.ts`），字典在 `locales.ts`，描述符在 `remote.ts`，容量写法在 `format.ts`，样式在
`styles.ts` + `styles.css`；`npm run build:client`（`tsdown`）把它们打成 `lib/client.js`，
`exports["./client"]` 指向产物。DSH 的客户端模块系统只要求一个**经典脚本**：用
`window.__ModuleLoader__.load({ id, factory })` 把自己上报，交给工厂一个同步的 `require`（解析平台模块表里的
模块）。它不要求这份脚本经过打包器，也不检查它是否被压缩过——所以「手写一份 CJS 工厂体」在契约上完全成立
（本插件 0.3.x 就是这么做的），代价全在源码侧：官方原语与 `ctx` 上那四个服务的形状只能靠记忆（官方改一个
prop 名字，编译期不会有任何声音）；`lib/` 不入库而那份手写产物入库，同一个仓库里两半的命运不同；当时那
1566 行 `createElement` 没有 JSX，也没有 sourcemap。

因此现在与官方插件同一条路：源码留在 `src/client/`，产物落 `lib/client.js`（+ `.map`），包法照抄官方
`packages/client/tsdown.client.ts` 的三行——那套 preset 只随 monorepo 发布、外部插件 import 不到，所以
`tsdown.config.ts` 里自己写了一份最小的：

```ts
banner: `window.__ModuleLoader__.load({ id: "dsh-aperture", factory: (require) => {`,
intro: 'var module = { exports: {} }; var exports = module.exports;',
footer: 'return module.exports; } });',
```

源码那半边的形状：`index.ts` 只做装配（`apply` / `mountRemote` / 注册），页面 `AperturePanel.tsx` 是 TSX
（`jsx: react-jsx`，automatic runtime，`react/jsx-runtime` 本来就在平台基线里），一行模型在
`ModelRow.tsx`、展开后的编辑器在 `ModelEditor.tsx`，都是普通的 JSX 树，`createElement` 那套样板没有了；
`draft.ts` 是草稿与补丁的换算，`locales.ts` 是两份字典与命名空间声明，
`remote.ts` 是描述符，`format.ts` 是容量写法，样式表是真正的 `src/client/styles.css`，由
`tsdown.config.ts` 里的 `cssInline()` 编译成文本内联进产物——对应官方 `dsh-css-text-inline` 那一步。
**CSS 仍然内联**：客户端模块系统只服务 `<包名>/client.js` 这一个经典脚本，没有旁挂 `.css` 的路由，也没有
加载 `<link>` 的机制；本插件只有一份手写、没有类名变换的样式，因此那个加载器只做「读文件 → 导出文本」，
不像官方那样还要过 lightningcss 与 CSS Modules（类名映射）。

`tsdown` 只打包不做类型检查，类型交给独立的 `tsconfig.client.json`（`lib: es2023 + dom`、`jsx: react-jsx`、
`strict`），`npm run typecheck` 会跑它。官方客户端包按**真实版本**装在 devDependencies 里，但只为类型与打包：
它们运行时由宿主模块表提供，本包不解析它们（`test/client.test.ts` 里那个「不许 require 基线之外的模块」的
替身就是这道保证）。报告与模型的形状不在浏览器半边另立一套，直接 `import type` 宿主的 `src/report.ts`——那是
两半边共享的线格式，「宿主组装数据、界面按语言组织措辞」这条分工也照旧。

以下运行期契约不变：

- 运行时只 `require('react')`（平台基线模块）与 `require('@deepseek-ai/dsh-client-ui-primitives')`（控件与设置表单那一套），槽位、字典与 Remote 都从 `ctx` 上取服务，因此 `dsh.client.external` 是空的（`tsdown.config.ts` 里那份 `EXTERNALS` 就是这两个加上 `react/jsx-runtime`）；`dsh.client.inject` 是给宿主客户端模块系统的声明——它按这份清单把那些包的工厂注册成可 `require` 的模块，清单与 `src/client/index.ts` 顶部那几条只为取服务声明的 `import type {} from '…/client'` 一一对应，来源是各包**发布出来的类型声明**而不是猜的（`ctx.slots` 在 `dsh-client-ui-renderer/client`、`ctx.locale` 在 `dsh-client-locale/client`、`ctx.configForms` 在 `dsh-client-ui-settings/client`、`ctx.remote` 在 `dsh-api-remotes/client`；`dsh-client-ui-plugin-manager` 是声明 `plugins.bundle.config` 那个槽位的插件页，`dsh-client-ui-primitives` 提供控件）。宿主只校验它是字符串数组，因此这份清单与插件页自己声明的槽位保持一致，不另立一套；多写一个客户端模块图里没有的 id 不会报错、也不会连出边（`arriveGraphRow` 找不到就跳过），所以它仍然只是**声明**——`apply` 真正等的是服务，不是清单；
- 配置页注册必须走 `ctx.slots.inject('plugins.bundle.config', …)`：这个槽位由**插件页**自己声明，而那个声明完全可能晚于本插件的 `apply`，直接 `register` 会撞上「槽位尚未声明」；
- 字典用 `ctx.locale.register(NS, { zh, en })` 注册，两种语言必须一次交齐；注册配置页时声明 `locale: NS`，槽位渲染器才会把绑定好的 `t` 交给组件；
- 样式在 `apply` 的 effect 里注入一个 `<style data-plugin-css="dsh-aperture/styles.css">`（同时写上 `data-plugin="dsh-aperture"` 归属；`data-plugin-css` 取官方那套「包名/文件名」的写法），页面根节点带 `data-dsh-aperture`，选择器全收在那个属性之下；颜色一律引用 dsh web 的主题 token，卸载时由 effect 的 disposer 移除。这一份只剩排版：控件自己带底色与文字色（官方原语），本插件不再自画按钮，也就不必再配那对颜色；
- **effect 的依赖里不放注入面**：`inject` 面由渲染器每轮渲染重新组装，依赖它的身份会让 effect 每轮重跑、再触发渲染，于是界面一直转圈。刷新信号用自增计数器，`test/client.test.ts` 除了钉住渲染轮数，还直接检查每个 effect 的依赖里没有对象。

宿主半边相反：`src/*.ts` 必须先 `npm run build:host` 编成 `lib/`，宿主加载的是那份产物。两半都要构建，但生效方式不同：客户端产物重建之后刷新页面即可，宿主那半边必须重启——因此「改了没反应」既可能是不该刷新而该重启，也可能是反过来；两半正好分在两边（分组排版、每行的草稿与折叠、容量的 K/M 写法在浏览器半边；报告的覆盖口径、写完等刷新的时序在宿主半边）。`lib/` 里那份的 mtime 比源文件旧就说明还没构建，构建与开发实例见 [development.md](development.md)。

## 验证：哪一层证明什么

三份测试各证一件不同的事，因此谁也顶替不了谁：

- `test/live.test.ts`（**端到端**）是唯一能证明「写进去的配置**合法**而不是看起来合理」的一份。它真的 `boot()` 一个 profile 目录（`cordis.patch.yml` 里带上本插件那一行），交给 Cordis Loader 挂起来，再让真的 `llm-pi-ai` 去读那份产物、把模型解出来。写入经 `dsh-config-editor` + `dsh-settings` 落盘，因此断言的是**落地之后**的文档，而不是内存里拼出来的对象。
- 它自己搭的那套里只有一个替身：`hmr`（`hmrSeam`）。真实的 HMR 要 `--expose-internals` 与 `timer` 服务才挂得起来，而它恰好决定了写入落不落得下来（见「写入行为」里那条「写入必须从 HMR 事务之外发起」）——少了这个替身，事件里发起的那一轮刷新被事务嵌套拒绝的样子，与「写成功了只是没变化」在断言上分不开。替身只留 `runExclusive()` 的两条语义：事务里再来一次就拒绝、否则排在上一件工作后面。
- 它连的网关是仓库里的 `test/fake-gateway.ts`：内核挑一个空闲端口，`/v1/models` 回一份与断言一一对应的固定载荷。因此这一份不依赖 Tailscale 网络，CI 里也跑得动；`DSH_APERTURE_LIVE_URL` 给定时改连真实实例（那份载荷与用例是一份契约，改一处就要改另一处）。
- 各 `src/*.ts` 的单元测试钉的是端到端**测不到**的那些：请求头与 URL 归一化、解析失败时的具体原因、`planSync` 的逐条 op、单飞语义、写入被拒的分支。端到端只会告诉你「文档里没有 `llm-pi-ai` 那一行」，不会告诉你「`accept` 头丢了」。因此两边都留：端到端负责「真的能用」，单元测试负责「坏在哪」。
- 浏览器半边（`test/client.test.ts`）测的是**打包产物** `lib/client.js`（`npm test` 的 pretest 会先重打一次），因为 `window.__ModuleLoader__.load` 那层包法正是要钉住的契约之一；官方原语虽然有真实类型，但运行时仍然喂替身模块。它走 `test/support/mini-react`（实现了 `createElement` 与 automatic runtime 的 `jsx` / `jsxs` / `Fragment`），钉住的是**接缝**（注册到哪个槽位、注入面上的名字与形状、effect 依赖里不许有对象、提交轮数不许自激、卸载时收不收回订阅与样式）与页面行为（改哪一项写哪一项、失败时界面说不说实话）。它证明不了「官方组件长什么样」，那不在本仓库的测试范围内；替身只保证被测代码依赖的那套语义与官方一致（`SettingsFormModel` 的草稿、`revision` 围栏与 `stored` 口径）。

## 已知边界

- **不转换 API 格式**，这是设计目标而不是缺陷。只支持 `llm-pi-ai` 能服务的 Chat Completions、OpenAI Responses 与 Anthropic Messages；Gemini 原生端点接不了。
- `supported_endpoints` 是唯一的协议依据。网关如果不报，就按 OpenAI 兼容处理。
- models.dev 是尽力而为的补全：拉不到就是拉不到，发现本身照常成功。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）——`llm-pi-ai` 已经认领了那件事，重复注册会抛错。
- **改了 `route` 的路由名之后，旧键会留在 `llm-pi-ai.providers` 里**（插件只认自己当前拥有的三个键，无法知道历史上用过哪些名字）。它不会报错，只是不再刷新；要清理就手动删掉那一行。
- **配置页只存在于 Web 界面**（插件页 + Typert 注册表）；没有它的部署里发现照常，只是没有可点按的界面。从非本机来源打开的页面拿不到宿主设置，配置页会把失败原因摆在页面上（而不是假装可编辑）；设置文档本身不接受写入时（表单快照的 `state.writable === false`），表单会置灰并说明原因；连快照都拿不到时（`state.status === 'unavailable'`）设置那一段只剩官方表单的一句说明，报告照常显示。
- **更高优先级的补丁层能盖住写入**：profile 的补丁文档之上还有 `$DSH_HOME/cordis.patch.yml` 这类层。同一行在那里也被写过时，配置页的保存写进 profile 的补丁文档、却不生效——写入本身可能被设置接缝拒收（配置页会说这一笔没被收下），也可能落盘了却仍是那一层说了算；两种都得去那一层改。
- **peer 范围收得很紧**（`^0.1.7-rc.1`）：0.1.7 之前的宿主会被 peer 预检挡下——这一版起 `installSection` / `SettingsProvider` 这套接缝已经不存在，本插件的界面代码在旧宿主上无法工作。因此从 `0.2.0` 升上来是一次有意的破坏性升级。
- **想让已发布的路由消失就关掉同步开关**：那一轮刷新会把本插件的三个键从 `llm-pi-ai.providers` 撤下来（同段里别的 provider 不动）。
- **动作端点的一句结论仍是中文**：`PanelAction.summary` 由宿主半边写好（「已写入 2 条路由…」），因此英文界面里那一行也是中文。报告已经不走这条路（它是结构化数据），但这个动作用的还是「宿主说一句话」的形态；要让它跟着语言走，得把 `summary` 换成「码 + 实参」再由界面渲染。地址与同步的写入不再是端点，它们的话由界面自己按语言组织。
