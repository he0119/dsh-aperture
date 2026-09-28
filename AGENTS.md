# AGENTS.md

本仓库的协作约定，给 AI 助手与贡献者看。安装与用法在 [README](README.md)（英文版
[README.en.md](README.en.md) 与它对齐），实现与取舍的「为什么」在
[docs/internals.md](docs/internals.md)，目录结构与逐文件职责在
[docs/development.md](docs/development.md)，发布在 [docs/releasing.md](docs/releasing.md)。
文档、提交信息、给维护者的报告一律用中文。

## 文档分工

每条信息只写一处，别处放链接或一句话指过去：

| 文档 | 写什么 |
| --- | --- |
| `README.md` / `README.en.md` | 安装、配置、插件页怎么用；两份的键与结构保持对齐 |
| `AGENTS.md` | 本文件：协作约定、提交信息口径、验证清单、界面硬约束 |
| `docs/internals.md` | 为什么这么做：约束、踩过的坑、刻意的取舍 |
| `docs/development.md` | 怎么构建、怎么跑、怎么起一个专用开发实例 |
| `docs/releasing.md` | 发布流程（推 `v*` 标签触发可信发布）、标签落点三道校验、PR 标题与日志分组 |

## 官方文档

上游口径以官方文档站为准（<https://deepseek-harness.github.io/deepseek-harness/>，中英双语）。与本包
关系最近的三页：

- [Web Client](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client)：
  「包边界」规定功能插件包之间不得运行时互导值（跨包走 Cordis service 或 Slots）；页面里两侧也叫
  「Host 侧 / Client 侧」「Host face / Client face」。
- [客户端模块](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)：
  客户端产物的经典脚本契约（`window.__ModuleLoader__.load({ id, factory })`），以及
  `dsh.client` 里 `inject`（工厂到达与组合顺序）与 `external`（非基线模块请求）的分工。
- [新增设置卡片](https://deepseek-harness.github.io/deepseek-harness/reference/cookbook/adding-a-settings-card)：
  设置页卡片怎么按命名空间配对两侧。官方中文把插件包的两侧叫 **Host 半侧** / **浏览器半侧**
  （英文是 "Host half" / "browser half"），本仓库统一写 `Host 端` / `Web Client 端`——不写
  「半边」，也不写「客户端侧」。

## 提交信息

**只写这个提交做了什么、为什么这么做、有什么取舍。** 明确不要写：

- 维护者/作者本人的使用面或口述（「我完全没机会用这个东西」这类）；
- 谁报的（「用户报的」「用户截图报的」）——把现象与量到的数字写出来就够了；
- 演化过程（「原本是…后来改成…」）——直接写最终形态。

其余口径：

- 中文 conventional commits：`feat / fix / docs / refactor / test / build / chore / ci`，scope 用
  模块名或活动名（`panel` / `relay` / `client` / `build` / `release` / `publish` / `ci`），也可以不带；
  破坏性变更加 `!`，并在正文单独写一段 **破坏性**（对外契约、装过旧版的人会遇到什么）。
- **PR 标题照约定式提交写**：Release 日志的分组靠它自动补标签，标题写歪就落进「其它改动」，
  规则表见 [docs/releasing.md](docs/releasing.md)。
- 正文手折行，每行 ≤ 100 字符；一段一件事；一次逻辑改动一个提交，连带改动的文档与测试并入同一提交。
- 数字只写实测值：测试条数（`tests / pass / fail / skipped`）、量出来的 token 名与色值、产物字节数。
  机制细节可以引用文件与函数名，但不要复述 diff。

## 验证（提交前必须全绿）

```sh
pnpm test && pnpm run typecheck && pnpm run build
```

（`pnpm test` 的 `pretest` 会先重打 Web Client 产物；`pnpm install` 会跑 `prepare`，也就是一次完整
构建。CI 跑的是同一串，见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。）

- 三份测试各证一件不同的事，谁也顶替不了谁（分层见 [docs/internals.md](docs/internals.md) 的
  「验证：哪一层证明什么」）：`test/live.test.ts` 是唯一能证明「写进去的配置**合法**而不是看起来
  合理」的一份；各 `src/*.ts` 的单元测试钉端到端测不到的细节（请求头、URL 归一化、`planSync` 的
  逐条 op、写入被拒的分支）；`test/client.test.ts` 测的是**打包产物** `lib/client.js`。
- `test/manifest.test.ts` 不属于上面那三层，它核的是**声明**：拿宿主自己的
  `evaluatePluginCompatibility` 走一遍 `package.json` 的 peer 范围与 `engines.dsh`，要求它们接受
  devDependencies 装的那条版本线、又不接受更早的宿主。**升级 devDependencies 而忘了跟 peer 范围**，
  真机上就是插件整行被预检拒掉、界面上什么也不出现，而其余检查全绿——这份用例挡的就是它。
- `test/live.test.ts` 连的网关默认由 `test/fake-gateway.ts` 自己起（内核挑端口，不要网络）。那份
  固定载荷与用例是**一份契约**，改一处就要改另一处。
- **新断言要篡改验证**：把被测行为改回去，测试必须变红；报告里说明做了哪些篡改。
- 界面与样式的改动要**在真实 dev GUI 里量**（`getComputedStyle` 的实测值），不要推算色值；深浅两套
  主题各量一遍再下结论。开发实例怎么起见 [docs/development.md](docs/development.md)——另建一个
  `web-dev` profile，与日常那个实例互不影响。
- 真实 profile 上的**写操作**先问再做：让插件往某个 profile 的 `llm-pi-ai.providers` 里写、或改那份
  设置文档，都算。验收优先用只读走查——`DSH_APERTURE_LIVE_URL=… pnpm run inspect`（打印写入后的
  补丁文档与 LLM 解析结果），或者拿 `scripts/fake-aperture-gateway.mjs` 摆在固定端口上对着它跑。
- 验收需要临时夹具（临时 profile、假网关、假数据）时用完立刻删干净，并在报告里写明造过什么、
  清掉了没有。

## 界面与样式的硬约束

- Web Client 端运行时只 `require` 平台基线里的模块：`react`、`react/jsx-runtime`，以及官方原语包
  `@deepseek-ai/dsh-client-ui-primitives`——`tsdown.config.ts` 里那份 `EXTERNALS` 就是这三条，
  `dsh.client.external` 因此是空的。四个服务（`slots` / `locale` / `remote` / `configForms`）都从
  `ctx` 上取。
- **这条与官方插件指南「不要 require 任何 Harness Client 包」是有意的偏离**：控件、设置表单与图标
  全用官方原语，与官方设置页逐像素一致，代价用 `peerDependencies` 里的 `@deepseek-ai/dsh*` 范围兜底
  （宿主按**运行时 dsh 版本**校验；原语包本身不走 npm 解析，没有版本可以被 peer 拦住）。别把控件
  抄进本仓库，也别放宽那个 peer 范围。
- `dsh.client.inject` 那份清单与 `src/client/index.ts` 顶部那几条只为取服务声明的
  `import type {} from '…/client'` 一一对应。宿主只校验它是字符串数组，多写一个模块图里没有的 id
  不报错也不连边，所以它是**声明**——`apply` 真正等的是服务，不是清单。
- 配置页注册必须走 `ctx.slots.inject('plugins.bundle.config', …)`：这个槽位由**插件页**自己声明，
  那个声明完全可能晚于本插件的 `apply`，直接 `register` 会撞上「槽位尚未声明」。
- 颜色只许引用「这一页真的定义过」的 token：Theme 检查面列出的 `--dsw-alias-*`，加上官方原语自己
  引用的那几个（`bg-layer-3` / `border-l4` / `interactive-bg-hover` 等）与圆角 `--dsw-radius-*`。
  名单外的名字要登记进 `test/client.test.ts` 的那份 `allowed` 名单并写明理由。反例是
  `--dsw-alias-settings-card-*`：它只活在官方「模型」页自己那份组件 CSS 里，引用它等于引用空值，
  亮色主题下卡片连边都看不见（暗色主题反而正常，这就是它一直没被发现的原因）。每条 `var()` 都带
  中立回落值。
- 字典用 `ctx.locale.register(NS, { zh, en })` 一次交齐两种语言，键集必须一致（`locales.ts` 的类型
  与 `test/client.test.ts` 两处都核）；页头那条标题与描述来自 `locale/*.json` 的 `meta.*` 与
  `package.json` 的 `icon`，字典里不再写 `tab`。
- 样式源码是真 `.css`（`src/client/styles.css`），由 `tsdown.config.ts` 的 `cssInline()` 内联进产物
  （客户端模块系统只服务 `<包名>/client.js` 这一条经典脚本，没有旁挂 `.css` 的路由）。选择器全收在
  `[data-dsh-aperture]` 之下，类名一律 `dap-` 前缀，**同一个选择器不许定义两次**（用例会核，
  `.dap-facts` 吃过这个亏）；样式随 effect 注入、卸载时由 disposer 移除。
- effect 的依赖里**不放注入面**：它每轮渲染都重新组装，依赖它的身份会让 effect 每轮重跑、再触发
  渲染，界面于是一直转圈。刷新信号用自增计数器，`test/client.test.ts` 直接检查每个 effect 的依赖里
  没有对象。
- Remote 端点名不许与 `RemoteNamespaceService` 的保留成员重名（撞了会拒绝**整份**贡献，浏览器里
  只留一行 `console.error`、界面安静地什么都不出现）；那份名单抄在 `test/client.test.ts` 里，
  新端点起名时先对一遍。

## 代码结构

- `src/index.ts` 是唯一的插件外壳；发现、清单、发布、报告与写入分别落在其它模块，逐文件职责见
  [docs/development.md](docs/development.md)，别在这里复述一遍。
- Host 端源码里唯一的**运行期** DSH 依赖是 `@deepseek-ai/schemastery`（`src/config.ts` 的 `z`）；
  其余 `@deepseek-ai/*` 都是 `import type`，运行时由宿主提供。`lib/` 是构建产物、不入库。
- `src/client/**` 不在 Host 端 tsconfig 的 include 里（它要 DOM 与 JSX，走 `tsconfig.client.json`）；
  Host + `test/` + `tsdown.config.ts` 走 `tsconfig.test.json`，`pnpm run typecheck` 会把两份都跑完。
- 本包自带的 `cordis.patch.yml`（组合层）**故意不写 `config`**：缺省值只有 schema 一处，而补丁层是
  整行替换，写进去会让「已覆盖」的判据凭空为真，并把将来的缺省值钉死。
- 写入只碰 `llm-pi-ai.providers` 下本插件拥有的三个键（`route` / `route-responses` /
  `route-anthropic`，默认即 `aperture` / `aperture-responses` / `aperture-anthropic`）：内容相同不写、
  探测失败不写、路由没模型了就删掉、关掉同步就撤下。**每一轮刷新都必须从 HMR 事务之外起跑**（经
  `src/relay.ts` 那条模块作用域的通道），别把刷新挪回事件处理器里。
- 本插件不注册任何 provider 目录（`registerConfigurableProviders`）——`llm-pi-ai` 已经认领了那件事。

## Git

- **不要自己 push**（含 `--force`），也不要自己发版（`pnpm version` 会改 `package.json` 并打标签）；
  改完把状态与下一步命令交给维护者，由他决定。发布流程见 [docs/releasing.md](docs/releasing.md)。
- 改写历史前先留一个备份 ref，并在报告里给出新旧 sha 的对应关系，以及「树有没有变化」的核对方式。
