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
- `typert` **不声明**，也只用于界面：Aperture 标签页需要的五个端点（报告、配置读写、立刻刷新、撤下路由）经 Typert Remote 暴露，而 Typert 注册表只有 Web 这类装配了网关的 profile 才有。headless profile 里这一整块被跳过，发现照常运行，只是没有可点按的界面。
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

标签页上说 `设置：未写入（已处于同步状态）` 是正常状态。

## 界面：一条契约、两半实现

界面是 **设置 → 插件 → Aperture** 上的一个标签页。接线方式对齐生态里可用的参考实现
（[`@xiaoyuyu6420/dsh-backup`](https://github.com/xiaoyuyu6420/dsh-backup)）：**仓库之外**的插件要往设置里挂东西，这是被证明能跑通的那
一种。它把三类东西分得很清：

- **界面不碰宿主设置。** 浏览器半边只注入 `slots` / `locale` / `remote` 三个服务；`baseUrl`
  与 `sync` 的读取、写入和报告一样经自己的 `aperturePanel` 命名空间往返，宿主半边再用
  `ctx.settings` 带着版本号写进 `aperture` 段。于是标签页不必知道设置文档长什么样，也不必
  参与它的并发控制；「已覆盖」看的是字段在不在用户层里（`describe()` 返回的 `user`），而不是
  值等不等于组合层——这两件事不是一回事。
- **发现结果也走 Remote。** 报告、立刻刷新、撤下路由、配置读写与逐模型编辑一样，都挂在
  `aperturePanel` 命名空间上（`src/remote.ts` 的宿主服务 + `src/panel.ts` 的六个端点）。发现
  结果不是配置：把它塞进设置文档会让「用户写了什么」与「插件发现了什么」混成同一份账，而后者
  每轮刷新都会被重写。
- **报告是数据，不是句子。** `src/report.ts` 只组装结构（哪个模型属于哪条路由、每条事实来自
  哪里、用户写了哪些覆盖），措辞与排版都在浏览器半边按语言组织——标签页是双语的，把中文句子
  拼在宿主半边等于让英文界面显示中文。
- **逐模型编辑按字段合并，一次只写一个模型。** `edit` 收 `(id, patch)`：界面上一行一个「保存」，
  写下去的就只有那一行，版本校验也只管这一次写入。补丁是**稀疏**的：界面只发它改动过的字段，
  没提到的字段原样留在设置文档里（`reasoningEfforts` 界面根本不编辑，因此不会被顺手抹掉），
  空串与 `null` 表示「这一项不覆盖」，`patch` 传 `null`（而不是缺省）才是「整条撤销」——
  缺省是调用方写错了，宿主会拒绝，因为「什么都没改」与「撤掉一切」差得太远。容量、模态、推理与
  协议落在 `models` 的对应条目上，清单别名落在 `modelAliases[id]`；写入时按位置替换数组元素，
  改一个字段不会让这条覆盖挪到数组末尾。撤销别名之前先看**用户层**有没有这个键：界面显示的是
  生效别名，它可能来自组合层或清单，删一个不存在的键要么白写、要么被设置服务当成坏路径拒绝。
  非法值在写入前就被挡下来——写进设置文档的坏值会让下一轮刷新的 `resolveConfig` 直接抛异常，
  那时用户已经在别处改坏了配置。
- **空值不算声明。** 运行时 schema 给 `models[].input` 的缺省值是**空数组**，而 `reasoningEfforts`
  也可能被写成 `{}`；两者都不是「这个模型没有任何模态 / 没有任何推理档位」的意思（想声明纯文本
  的是 `images: ignore`），却都会一路传到发布出去的 provider 里。`input: []` 抹掉发现到的模态，
  还谎称来源是配置；`{}` 更狠：`llm-pi-ai` 适配器以「reasoningEfforts 是空的」为由拒绝**整段**
  写入，于是三条路由一条都发布不出去、每张路由卡都亮红点，而原因只写在「最近一次刷新」的设置
  那一行里。两处都按「没写」处理（`registry.ts` 的 `declaredInput`、`profile.ts` 的 `declared`），
  并且用例**先过一遍 schema** 再断言——单元测试里手写的选项对象没有这个缺省值，正是这一点让
  `input: []` 躲了很久。
- **只做按行编辑，没有批量。** 端点就是 `(id, patch)`，一次一个模型、一次版本校验。「撤销
  覆盖」也是这一行的补丁，只是全是 `null`。把多个模型打包成一个批次在这里没有对应场景——
  界面上不存在「一次改好几个再一起提交」这种动作——却会多出「一半写下去怎么办」这种必须
  解释的失败态。

### 形状照抄官方设置页的模型卡片

界面里没有自己的设计语言：尺寸、形状与配色都对着官方「设置 → 模型」那张卡片的构建产物
（`@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` 里 `ModelsSection.module.css` 的字面
量）抄。

**卡片是官方 `rowCard`**：`.5px` 的 `border-l4`、16px 圆角、`12px 14px` 内边距、底下不铺色。段卡
（实例、刷新）与**路由卡**在页面上是同一层，共用同一条规则（`.dap-section, .dap-route`）；模型行
是路由编辑区**里面**的一层，用官方 `modelEntry` 的细框（10px 圆角、`10px 12px` 内边距）——两层的
几何差着一号，一眼看得出谁在谁里面。卡头是官方 `rowHead`：左边身份（14px/500 的名字、11px 的
`rowTag`、8px 的状态点，间距 10px / 6px），右边 `rowActions` 用 `margin-left: auto` 顶到底（行内
动作 28px / 14px 圆角 / 12px 字）。卡片里那块浅色面是官方的 `editor`：`bg-module-platform` 底、
12px 圆角、`14px 16px` 内边距、14px 的行距，字段排成 `repeat(auto-fit, minmax(160px, 1fr))` 的栅格
（占满整行的格子横跨栅格，官方给密钥的也是整行），字段标签是官方 `fieldLabel` 的 12px/500
`label-secondary`（模型那些格子沿用 `modelFieldLabel` 的 12px `label-tertiary`），编辑区底部的
「取消 / 保存」右对齐、主按钮在右。输入框 32px 高、8px 圆角、`.5px` 的 `border-l4`、`bg-layer-1`
底、聚焦只换边框色；正文按钮 36px 胶囊；披露箭头是自画的内联 SVG。

**段与卡都是官方那页的骨架，模型段是两级。** 模型段不套外卡：页面级标题（16px/500）右边跟一枚
计数标签与那句「已覆盖几个，其余沿用发现值与清单」，下面直接排**路由卡**。一张路由卡就是官方那张
provider 卡——卡头写 `provider · 协议` 加模型数，展开后那块浅色面里先是「→ 地址」一行（对应官方
编辑区头上的名字与 provider id），再是**模型清单**（官方 `modelCatalog`）。模型行自己还能再展开
一次：参数面落在**这一行里面**，不另铺一层灰，只切一条 l2 细线（官方 `modelAdvanced` 就是这么处理
的）——同一块浅色面上再套一块同色的面，边界根本看不见。三张卡各有各的担子——实例（地址与同步
开关）、最近一次刷新（刷新与撤下路由是它卡头上的动作，报告与它同处一卡）、路由与模型——「刷新」
不再另起一张只有按钮的卡。

**两张段卡的卡头自己就是折叠开关。** 箭头 + 身份那一段整体是一个按钮（官方分组头 `groupToggle`
就是这个形状：按钮里放箭头与标题，右边的控件留在按钮外面），默认展开，点了把卡体整个从 DOM 里拿
掉——不是藏起来：`[hidden]` 会被 `.dap-editor` 自己的 `display: flex` 顶掉，而藏着的输入框在折叠
状态下还会被 Tab 走进去。动作必须留在按钮**外面**（按钮里不能再嵌按钮），于是折着也能按；按完的
反馈（那行提示）同样留在卡体外面，否则「折着按了立即刷新」就是一个没有回音的按钮。折叠状态是本地
state、按卡记（官方也是 `?? true`），因此每一轮刷新重渲染都不会把它弹回来。

**状态点是官方那个「凭据配好了没有」的记号。** 8px 的圆、`state-success-primary` /
`state-error-primary` 上色，语义换成「地址填了没有」（实例卡）、「最近一次刷新成不成功」（刷新
卡）、「这一轮有没有把它写进 `llm-pi-ai`」（路由卡）与「有没有路由可用」（「未服务」那张卡）；
还没刷新过、或者报告里根本没有同步结果时，就没有状态可说，索性不画。颜色不是唯一的说法：
`title` 与 `aria-label` 里写着同一句话，而「没写进去」那句会把 `refresh.sync.reason` 一起带上
（`这一轮没有写入 llm-pi-ai：…`）——只写「没写进去」的红点等于让人去别处找原因，而这一轮为什么
没写成正是它唯一想说的话。模型行**不**自己带点：它在哪张卡里就说明了它有没有被服务，嵌套已经把
这件事讲清楚了，不必每行重复一遍。

**两级折叠，编辑按行提交。** 官方那张卡片一屏都是可以改的字段，因为它的职责就是编辑模型清单；
这张标签页的主要职责是**报告**，一屏输入框会把「这一轮刷新发现了什么」淹掉。因此这里第一层收起
时只有路由卡头（身份、模型数与状态点），第二层收起时只有一行事实（id、名字、容量与标签），点
「编辑」才展开**它自己里面**那一层，面板里是这一行自己的「保存 / 取消」——展开几行互不牵连，也
不存在跨行的提交。官方的「改完点卡片底部的应用」在只有一个编辑对象时很自然，而在这里，一份草稿
对应多行时「按了保存到底写了哪几行」就没有答案。

**「撤销覆盖」写的是这一行的补丁，不是整条删除。** 报告里写着这一行**确实**被覆盖过哪几项
（`override`），按钮就把那几项逐个 `null` 发出去，而不是丢掉 `aperture.models` 里整条条目——
后者会把界面根本不编辑的键（例如 `reasoningEfforts`）一起扔掉。报告里出现界面不认识的覆盖键时
（宿主以后加了字段），那才退回整条撤销：`patch: null`，因为那时只有整条删掉才能让这一行真的
回落到发现值。

**来源跟着字段走。** `provenance` 是「这一项事实从哪儿来」的诊断信息，它渲染成**每个字段自己的
注脚**（`生效 1,048,576 · 来自 aperture`），收起时完全不出现。四项来源串成一句话挂在行尾时，
用户得把每一项对回它说的是哪个字段，而一张十一行模型的清单每行再挂一串，正文就被诊断信息盖住
了。协议是从通告的端点上推导出来的，没有来源可报，那一格只说生效值。

有一处**故意不照抄**（也只此一处）：官方禁用态按钮用 `opacity: .4`，对主按钮来说那会把底色与
文字一起压向页面底色，浅色主题下对比度掉到大约 1.4:1（就是「看不清字」那种效果）。主按钮因此
改用主题自己的 `button-primary-dimmed` 填充 + `label-secondary` 文字，禁用但读得清；次要按钮、
危险按钮与行内动作按钮照旧整颗 `opacity: .4`，与官方一致。`test/client.test.ts` 把这两条都钉住了。

还可以更进一步直接用官方那套组件（shell 的模块表里就有
`@deepseek-ai/dsh-client-ui-primitives`：`Button` / `Input` / `Switch` / `Pill` / 一堆图标），
但它们对外只有运行时导出、没有可查的类型声明，而这份 CSS 是能逐条对照的字面量；等这两者的
取舍反过来时再换。

### 端点描述符是手写的

生成描述符的 Typert 生成器并不随 DSH 发布，因此两半边都手写，契约本身很小：宿主用 `src-json`
编解码器，浏览器带 `strict` 校验，两端共享同一组端点名（`dsh-aperture#aperturePanel/<方法>`）。
浏览器那半边的 `codec()` 是一行小文法：`'string'` / `'number'` / `'boolean'`，`?` 可省略、
`|null` 允许 `null`、`[]` 是数组，直接给另一个 `codec` 就是嵌套对象（`opt()` 包一层表示可
省略，`list()` 包一层表示对象数组，`nullable()` 包一层表示「是它，或者 `null`」），参数与结果
用同一套说明。报告是嵌套结构，手写这套比引入 schema 库更小，而且报错会带完整路径
（`…status.models[0].contextWindow：期望 number`）。`test/client.test.ts` 会加载真实的浏览器
半边，断言它的端点集合、id 与宿主那半边完全一致，并用故意漂移的载荷钉住这份契约。

端点名另有一条不显眼的约束：api-gateway 在客户端给每个命名空间建一个
`RemoteNamespaceService`，端点会成为它的属性，因此与它自己的成员（`ctx` / `empty` /
`invokeRemote` / `methods` / `name` / `namespace` / `has` / `install` / `installDirect` /
`installScoped` / `assertMethodAvailable` / `remove`）重名时，`validateContribution` 会拒绝
**整份**贡献——浏览器里只留一行 `console.error`，界面安静地什么都不出现。「撤下路由」因此叫
`withdraw` 而不是 `remove`；`test/client.test.ts` 把这份保留名单抄成了护栏。

### 浏览器半边没有构建步骤

`client/aperture.js` 是**源码即产物**。DSH 的客户端模块系统只要求一个经典脚本，用
`window.__ModuleLoader__.load({ id, factory })` 把自己上报；它不要求这份脚本经过打包器，也不
检查它是否被压缩过。因此浏览器半边直接写成 CJS 工厂体：

- 用 `createElement` 而不是 JSX，于是不需要打包器，也不需要把编译产物提交进版本库；
- 运行时只 `require('react')`（平台基线模块），槽位、字典与 Remote 都从 `ctx` 上取服务，
  因此 `dsh.client.external` 是空的；`dsh.client.inject` 是给宿主客户端模块系统的声明
  （`dsh-client-locale` 提供字典、`dsh-client-ui-settings` 声明标签页槽位），宿主只校验它是
  字符串数组，因此这份清单与参考实现保持一致，不另立一套；
- 标签页注册必须走 `ctx.slots.inject('settings.plugins.tab', …)`：这个槽位由设置区自己声明，
  而那个声明完全可能晚于本插件的 `apply`，直接 `register` 会撞上「槽位尚未声明」；
- 字典用 `ctx.locale.register(NS, { zh, en })` 注册，两种语言必须一次交齐；注册标签页时声明
  `locale: NS`，槽位渲染器才会把绑定好的 `t` 交给组件；
- 样式在 `apply` 的 effect 里注入 `<style data-dsh-aperture>`，选择器收在这个属性之下、颜色
  只引用 dsh web 的主题 token，卸载时由 effect 的 disposer 移除。**填了底色的元素必须自己
  给出配对的文字色**：`--dsw-alias-brand-primary` 在浅色主题里近黑、深色主题里近白，而继承
  来的正文色恰好与它同色，只写 `background` 就成了深底深字；主按钮因此用
  `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` 这一对，禁用态
  用主题自己的 `--dsw-alias-button-primary-dimmed` 填充而不是把整颗按钮调透明；
- **effect 的依赖里不放注入面**：`inject` 面由渲染器每轮渲染重新组装，依赖它的身份会让 effect
  每轮重跑、再触发渲染，于是界面一直转圈。刷新信号用自增计数器，`test/client.test.ts` 除了
  钉住渲染次数，还直接检查每个 effect 的依赖里没有对象。


## 已知边界

- **不转换 API 格式**，这是设计目标而不是缺陷。也因此只支持 `llm-pi-ai` 讲得了的两种协议；Gemini 原生端点接不了。
- `supported_endpoints` 是唯一的协议依据。网关如果不报，就按 OpenAI 兼容处理。
- models.dev 是尽力而为的补全：拉不到就是拉不到，发现本身照常成功。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）——`llm-pi-ai` 已经认领了那件事，重复注册会抛错。
- **改了 `route` / `anthropicRoute` 的路由名之后，旧键会留在 `llm-pi-ai.providers` 里**（插件只认自己当前拥有的两个键，无法知道历史上用过哪些名字）。它不会报错，只是不再刷新；要清理就手动删掉那一行。
- **标签页只存在于 Web 界面**，而且需要 Typert 注册表；没有它的部署里发现照常，只是没有可点按的界面。从非本机来源打开的页面拿不到宿主设置，标签页会把失败原因摆在页面上（而不是假装可编辑）；设置文档本身不接受写入时，表单会置灰并说明原因。
- **「撤掉已发布的路由」只撤这一次**：下一次刷新会按当前配置重新发布。想让撤下长期生效，先把同步开关关掉（等价于 `sync: false`）。
- **动作端点的一句结论仍是中文**：`PanelAction.summary` 由宿主半边写好（「已保存…」「撤下 2 条路由…」），因此英文界面里那一行也是中文。报告已经不走这条路（它是结构化数据），但这几个动作用的还是「宿主说一句话」的形态；要让它跟着语言走，得把 `summary` 换成「码 + 实参」再由界面渲染。
