# dsh-aperture 实现细节

安装与配置看 [README](../README.md)，本地开发看 [development.md](development.md)，
发布看 [releasing.md](releasing.md)。

这里放**当前机制**里没有一篇文章承载的那部分：界面的实现细节与已知边界。每条决策的
依据、被否决的备选方案与后果在 `.agents/notes/implemented/` 下，下面的地图按主题指
过去——同一条依据只在一处展开，本文不复述。

## 决策地图

**它接哪些模型、怎么接**

- [自带 provider 适配器](../.agents/notes/implemented/architecture/2026-10-03-own-provider-adapter.md)：
  经 `ctx.llm.registerAdapter` 注册三条路由，协议交给 `@earendil-works/pi-ai`。
- [按端点分路由](../.agents/notes/implemented/architecture/2026-09-23-endpoint-keyed-routes.md)：
  同一个模型不是所有协议都收；接不了的列出来但不发布。
- [占位凭据](../.agents/notes/implemented/architecture/2026-09-23-placeholder-credential-header.md)：
  适配器要求有密钥，Aperture 不需要，于是写一个占位请求头。
- [容量与能力的来源优先级](../.agents/notes/implemented/architecture/2026-09-23-capability-and-identity-provenance.md)：
  网关 → models.dev → 兜底；`maxTokens` 没人声明就**不写**。
- [推理等级默认只给两档](../.agents/notes/implemented/architecture/2026-09-23-conservative-reasoning-efforts.md)：
  多给一档就是多一种能被选中的 400。

**它怎么读配置、怎么注册**

- [settings 是硬依赖](../.agents/notes/implemented/architecture/2026-09-23-settings-hard-dependency.md)：
  `typert` 只用于界面，没有它的 profile 里发现照常跑。
- [整段配置都是 volatile 的](../.agents/notes/implemented/architecture/2026-09-24-whole-config-volatile.md)：
  改配置不重挂插件，读值一律走 `configValue(ref)`；设置接缝仍是硬依赖，它承载配置页与
  逐模型覆盖。
- [组合层不写 config](../.agents/notes/implemented/architecture/2026-09-24-composition-layer-leaves-config-unset.md)：
  缺省值只有 schema 一处。
- [不写任何配置](../.agents/notes/implemented/architecture/2026-10-03-no-configuration-writes.md)：
  发现结果只活在这一次注册里；路由键被占就跳过注册并点名那个键。
- [刷新必须从 HMR 事务之外起跑](../.agents/notes/implemented/bug-fix/2026-09-24-refresh-starts-outside-the-hmr-transaction.md)：
  经 `src/relay.ts` 那条模块作用域的通道。

**界面**

- [配置页挂在包级槽位](../.agents/notes/implemented/architecture/2026-09-24-package-scoped-config-slot.md)：
  `plugins.bundle.config`，页头由插件页画。
- [模型编辑器挂在官方「模型」页的两个扩展位上](../.agents/notes/implemented/architecture/2026-10-03-models-page-extension-seats.md)：
  设置留在插件页，模型跟着模型走。
- [发现走 Remote，设置走表单](../.agents/notes/implemented/architecture/2026-09-23-discovery-over-remote-settings-over-forms.md)：
  报告是数据不是句子；写完等一轮刷新落地才回答。
- [逐模型编辑是稀疏的字段补丁](../.agents/notes/implemented/architecture/2026-09-23-sparse-per-model-field-patches.md)：
  一次一个模型、一次版本校验。
- [界面用官方原语，颜色只引用本页定义过的 token](../.agents/notes/implemented/architecture/2026-09-23-official-primitives-and-page-scoped-tokens.md)。
- [空值不算声明](../.agents/notes/implemented/bug-fix/2026-09-24-empty-values-are-not-declarations.md)：
  `input: []` 与 `reasoningEfforts: {}` 都按「没写」处理。
- [清空覆盖写的是这一行的补丁](../.agents/notes/implemented/bug-fix/2026-09-24-clear-override-writes-the-line-patch.md)。

**构建与兼容**

- [两端统一由 tsdown 构建](../.agents/notes/implemented/architecture/2026-09-26-tsdown-builds-both-halves.md)：
  同一条经典脚本契约，`Host 端`与`Web Client 端`分别产出。
- [端点描述符手写，线格式只有一层直通](../.agents/notes/implemented/architecture/2026-09-24-handwritten-passthrough-remote-codecs.md)。
- [端点名不得与 RemoteNamespaceService 的保留成员重名](../.agents/notes/implemented/bug-fix/2026-09-23-reserved-remote-endpoint-names.md)。
- [peer 范围是一条并集](../.agents/notes/implemented/architecture/2026-09-28-peer-range-is-a-union.md)。
- [cosmokit 写成直接依赖](../.agents/notes/implemented/process/2026-09-23-cosmokit-as-a-direct-dependency.md)：
  pnpm 的隔离布局下声明生成会报 TS2742。

**验证**

- [三份测试各证一件不同的事](../.agents/notes/implemented/testing/2026-09-24-three-test-layers.md)：
  端到端证明「合法」、单元测试指出「坏在哪」、客户端那份钉打包产物，
  `test/manifest.test.ts` 只核声明。

## 界面实现

### 分组与卡片

**组靠标题与间距，行才配一张卡。** 页面上从上到下两块：设置表单（官方
`SettingsForm`，它自带保存按钮、只读与「读不到」的说明）与模型目录。分组之间 20px、
组内 12px，分组标题就是一行小字。摘要不值得一个卡头，而一行模型值得：它是一个能
展开、能改、能单独写回去的对象，卡片的边框把「这一行的边界」画出来，行与行之间也
就有了 8px 的呼吸。

### 模型行的卡头

**卡头是自己画的按钮，不用 `DisclosureRow`。** 官方那个是根 24px 高、
`overflow: hidden` 的横条，标题又是 `flex: none` 不许收缩，于是名字一长就把右边的
事实与标签挤出可视区；它也只收一个 `icon` 与一行 `title`，塞不下「名字与标签一行、
事实另一行」这种两行身份。现在行首是一颗盖满整行的 `button`（自己带
`aria-expanded`），里面三段：状态点、身份、箭头。身份第一行是名字（过长省略，
`title` 里留着全名）加「未服务 / 已覆盖 N 项 / 有未保存的改动」几枚标签，第二行是
事实。

事实写成**带标签的**短语（`路由 aperture`，不是裸的 `aperture`）并用 `·` 分隔、随
宽度换行：不带标签的一串十一项，用户得自己数到第几项才知道哪个是协议。
展开/收起是本地 state、按行记；收起**不丢草稿**——收起来不等于放弃，那颗「有未保存
的改动」会一直挂着，要放弃得按「取消」。

状态点仍是官方 `StateDot`，但它说三件事：绿是这一轮把它注册成了路由、灰是这一轮
注册过而它没在里面、黄是根本没有路由能服务它；那一轮没走到注册时（报告里没有
`publish` 这一项）不装作「没注册上去」，而是说「这一轮没有注册，是否可用看不出来」。
官方 `StateDot` 自己是 `aria-hidden`，说给谁听得由外层 `role="img"` 的 `aria-label` 给。

### 页面与编辑器

**页面持有状态，行与编辑器只按 props 画。** 草稿与展开是两张按模型 id 记的表，长在
`ApertureModels` 上，动作也在那里按这一行绑好（`onToggle` / `onStage` / `onSave` /
`onCancel` / `onClear`）再递下去；`ModelRow` 与 `ModelEditor` 自己不持有 state。这几
件状态本来就不属于某一行——收起一行不丢草稿、写完一行页面顺手把它收起来、两行各改
各的，说的都是「同一份状态喂给多行」。草稿到补丁的换算（改了哪几项、该发什么出去、
容量读不读得出来）在 `draft.ts` 里，因此行首那颗「有未保存的改动」与编辑器底部那句
「有 N 项改动还没写下去」问的是同一个函数，两处说法不会打架。

**模型目录与设置页是两个组件。** `ApertureModels` 挂在官方「模型」页本插件那几行的扩展位
（`settings.models.provider-card`）上：座位按设置命名空间派发，本插件注册的每一行路由都会得到
一份这一块，组件从递进来的目录行认出自己管哪一条路由，只画 `model.route` 等于那个 id 的模型
——**能列在那一页上的模型一定有路由**。没有路由可服务的模型在那一页上没有座位（当初的页脚座位
已撤掉，见[没有路由可服务的模型不在「模型」页出现](../.agents/notes/implemented/simplification/2026-10-04-unserved-models-move-to-the-config-page.md)），
它们由设置页那句话交代。这一块**默认收着**，折叠头与模型行一样自己画（同一个理由，见上面的「模型行的卡头」）：
上面一条 `border-l2` 细线，左边标题与模型数目、右边常驻箭头，高 32px，hover 提亮并给一层背景。页主的派发不带「这一行展开了吗」
这个事实，而卡片座位对**每一行**都渲染，摊开一次就是十几行的目录，收着才不喧宾夺主。同一张卡里
每一行都是同一条路由（卡片头就是它），行内不再重复「路由 / 协议」。设置页（`AperturePanel`）只剩实例地址、注册开关、「立刻刷新」，以及报告里那两句话：「这一轮哪里不对」，
与「另有 N 个模型没有路由可服务（名字…）」（名字最多报五个，多的写「等 N 个」）——后者是那些模型
在界面上唯一的线索，一条路由都没注册时换成另一句；
（重新发现是「去哪儿发现」这件事的一部分，因此那一颗按钮只在设置页上：模型目录那一块按一下只能刷新
自己那一小块，说不清这一轮到底发生了什么。）
它与模型目录共用 `shared.ts` 里的注入面类型、设置快照类型与「这一轮哪里不对」那句话的计算，因此同一份报告
在两处说的是同一件事。

**编辑器里的字段也是官方那两个字段组件。** 文本字段用 `SettingsValueField`，按
「名称与协议」（显示名称、目录别名、API 协议）与「容量」（上下文窗口、最大输出
token 数）分两组，一组之内单列往下排；输入类型是两个 `Checkbox`、推理是一个
`SegmentedControl`（跟随发现 / 开 / 关，「跟随发现」就是这一项不写），各占一行
——官方「模型」页的输入类型同样独占容量字段下方的一行。分段控件与官方一样贴着内容
宽（`.dap-controlStart` 的 `align-self: flex-start`；flex 列的默认拉伸会把它撑成整行）。
单列而不是摆成一个大栅格，是因为官方 `.field + .field` 会给相邻字段画一条半宽的分隔
线（specificity 0,2,0），栅格一换行线就对不齐了；每个字段外面套一层 `.dap-fieldCell`
就绕开了，不必动 `!important`。

一行的动作是「保存 / 清空覆盖 / 取消」（都是 `sm`）：官方「改完点卡片底部的应用」在
只有一个编辑对象时很自然，而一份草稿对应多行时「按了保存到底写了哪几行」没有答案，
因此一行一个保存按钮（它就在这一行里面，不必再自称「这一行」）。动作左边还有一句
「和已保存的值相同 / 有 N 项改动还没写下去」：按下去之前先知道这一按会不会真的写。

**来源跟着字段走，长解释收进「i」。** `provenance` 是「这一项事实从哪儿来」的诊断
信息。字段下面只留一句来源（`SettingsValueField` 的 `hint`：`来源：Aperture`）；
「留空即用发现到的名字」这类怎么做的话收进官方的 `help`，也就是标签旁边那颗「i」
——点开才占位置（`fieldHelp` 给 `aria-label`：`显示名称的说明`）。勾选框与分段开关
那两行官方组件没有 `hint`，来源就挨着控件写一句。一个字段下面挂两句（怎么做 + 从哪
来），五个字段就是十行灰字，正文会被诊断信息盖住。协议没有单独一项来源：写过就是
配置，没写过就是从通告的端点推导出来的。

**提示语只说两件事。** 模型那一段的提示语只在**目录读不到**
（`catalog.available === false`，这时模型列表会是空的，不说原因等于没说）与**这一轮
没能注册**（`publish.reason`，比如路由键已被别的适配器占用）时出现；正常的一轮（注册
成功、或者注册开关关着）一个字都不说（`roundProblem`）——开关关着这件事页面上那颗
开关自己就说了。没有实例地址时的空状态是「还没有实例地址：
填上并保存之后才会去发现模型」——地址空着发现根本不会跑，「还没发现到模型」在那儿
等于没说。

**容量读写同一套 K/M 词汇（与官方「模型」页共用一套写法）。** 输入框认 `1M`、
`100K`，后缀是**十进制**的（`1M` = 1000000，不是 1048576），存下去的仍是普通
token 数；回写成能原样读回来的**最短**形式（`384000` → `384K`，而 `1048576` 不是
整千，照原样写出来）；提交时按**解析后的值**比较，因此 `100k` 与 `100K` 是同一个数、
不算改动——否则值没变却会往用户层里写一笔，那一行就凭空多一颗「已覆盖」。两边就是
官方那两个函数（`parseCapacity` / `formatCapacity`）：空串是「这一项不覆盖」，读不
出来的在本地挡下——`1G`、`1.5`、`0` 都不发端点，因为面板那一层只收不小于 1 的整数。
挡的是同一条判定（`capacityBad`）：输入框上标出「读不出来」，按保存则弹一句带字段名
的提示，两处不会给出不同答案。容量在收起那一行的事实里仍写成 `1,048,576` 这种带
千位分隔符的原文：那说的是**生效值**，不是你要填的那个数。

## 已知边界

- **不转换 API 格式**，这是设计目标而不是缺陷：三种线缆协议由 `@earendil-works/pi-ai`
  实现，本插件只把发现结果翻译成它的模型描述符。只支持 OpenAI Chat Completions、OpenAI
  Responses 与 Anthropic Messages；Gemini 原生端点接不了。
- **路由键被别的适配器占着时不注册**：`ctx.llm.registerAdapter` 对同一个键会抛
  `DUPLICATE_ADAPTER`，本插件先探测再注册，撞上就跳过、把那个键写进报告的原因里，并在
  `llm/adapters-updated` 时重试。升级上来的部署最常见的原因是旧版本写下的
  `llm-pi-ai.providers.<键>` —— 那份配置要用户自己删。
- `supported_endpoints` 是唯一的协议依据。网关如果不报，就按 OpenAI 兼容处理。
- models.dev 是尽力而为的补全：拉不到就是拉不到，发现本身照常成功。
- **界面只存在于 Web 界面**（插件页 + 官方「模型」页 + Typert 注册表）；没有它们的部署里发现
  照常，只是没有可点按的界面。从非本机来源打开的页面拿不到宿主设置，插件页会把失败原因摆
  在页面上（而不是假装可编辑）；设置文档本身不接受写入时（表单快照的
  `state.writable === false`），表单会置灰并说明原因；连快照都拿不到时
  （`state.status === 'unavailable'`）设置那一段只剩官方表单的一句说明，这一轮哪里不对那句
  话与「设置 → 模型」页里的模型目录照常显示（模型目录读的是同一个报告端点，与设置文档无关）。
- **更高优先级的补丁层能盖住写入**：profile 的补丁文档之上还有
  `$DSH_HOME/cordis.patch.yml` 这类层。同一行在那里也被写过时，配置页的保存写进
  profile 的补丁文档、却不生效——写入本身可能被设置接缝拒收（配置页会说这一笔没被
  收下），也可能落盘了却仍是那一层说了算；两种都得去那一层改。
- **改了 `routePrefix` 之后旧键没有服务者**：路由是进程内注册、不落盘，旧键不会报错也不
  需要清理（除非有别的适配器顶上那个键，那时按上面那条处理）。
- **动作端点的一句结论仍是中文**：`PanelAction.summary` 由 Host 端写好（「已注册
  2 条路由…」），因此英文界面里那一行也是中文。要让它跟着语言走，得把 `summary`
  换成「码 + 实参」再由界面渲染；地址与注册开关的写入不走端点，它们的话由界面自己
  按语言组织。
- **界面的两个半边**：设置（实例地址、注册开关，以及报告里那两句话）挂在插件页的包级配置槽位上；
  模型目录挂在官方「模型」页自己的扩展位 `settings.models.provider-card` 上（键控，键是设置命名
  空间 `aperture`，于是本插件注册的每一行路由都会得到一块，组件从递进来的目录行认出自己管哪一条
  路由）。那个座位的名字与 owner props 由那个页声明，本插件只注册内容，因此**那一行自己的编辑器
  对本插件仍是只读的**（设置段是 `aperture`，不是模型页的通用表单），能编辑的是本插件挂进去的
  那一块。**只有真的有模型的路由才占一行**：一种协议在
  这个网关上没有模型时，那一行既选不出东西、也声明不了任何事实（本插件也不把那条路由注册进
  provider 目录）。
