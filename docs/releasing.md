# 发布

发布以**标签**为锚：一个 `v*` 注解标签指着哪个提交，就发那个提交里 `package.json` 声明的版本，只此
一条。标签由 **Release 工作流**在人工点按钮之后打在**当刻 main 顶端**，随后它显式调 Publish 把版本
发到 npm 的可信发布（Trusted Publishing）上，成功后自动建 GitHub Release。本机不需要任何 npm token。

**合并版本号 PR 不等于发布**：`main` 上的版本号只表示「下一版是这个号」，什么时候发由人按一下按钮
决定（见下）。

依赖与构建走 pnpm（`packageManager` 钉在 `pnpm@11.7.0`），发布链路上仍有两处是 npm：`npm view` 查线上
版本、`npm publish` 真发布——可信发布与 provenance 是 npm CLI 的能力，工作流里那两步没有换。

## 一次发布

分两段：**版本号走 PR 合进 `main`**，**想发的时候点一次 Release 按钮**。

```sh
# 1. 版本号：只改 package.json，这一步不发布
pnpm version 0.4.0 --no-git-tag-version
git checkout -b chore/release-0.4.0
git commit -am "chore(release): 0.4.0"
git push -u origin chore/release-0.4.0
gh pr create --title "chore(release): 0.4.0" --body "…"   # 等 check 绿了再合
#    合并之后 main 上就是 0.4.0，npm 上还没有——这中间想合多少别的 PR 都行

# 2. 想发的时候点按钮（网页上 Actions → Release → Run workflow，或命令行）
gh workflow run release.yml --ref main -f version=0.4.0

npm view dsh-aperture version   # 工作流绿了再确认线上版本（见「工作流绿了但 npm view 查不到」）
```

`version` 这个入参**不是版本号的来源**——工作流仍只从 `main` 的 `package.json` 读版本号，入参是发布者
对自己要发什么的**断言**，对不上就什么都不做。它挡三类事：记错了现在升到哪一版、在错误的分支上点、
手滑点了两次。

工作流随后核对这次运行是在 `main` 上触发的、核对入参、确认标签还不存在（已存在就直接用，见「发布失败
了怎么重试」），然后在**当刻 `main` 顶端**打注解标签并推送——标签与版本提交因此按构造是同一个 SHA。
最后以 `workflow_call` 调 Publish：用 `GITHUB_TOKEN` 推的标签不会再触发别的 workflow，所以只能显式
调用，不是多此一举。

`pnpm version` 也能一步做完「改号 + 提交 + 打标签」（`-m "chore(release): %s"` 里的 `%s` 会换成
版本号），但那样标签落在**合并前**的提交上，而合并不保留那个 SHA（squash 换 SHA，rebase 同样重写）。
走 PR 时只取它改号那一半（`--no-git-tag-version`）。工作目录必须是干净的，否则 `pnpm version` 会
拒绝——它会把改动混进发布提交里。

`0.4.0` 也可以写成 `patch` / `minor` / `major`，由你决定升幅（见下）。`pnpm-lock.yaml` 不记录本包
的版本号，因此不必跟着改。

### 发布失败了怎么重试

按钮点下去之后标签已经在远端了，重试**不要删标签**，两条路都行、也都不会重复发布：

```sh
gh workflow run release.yml --ref main -f version=0.4.0   # 再点一次按钮，填同一个版本号
gh run rerun <run-id>                                     # 或者重跑失败的那次运行
```

再点一次按钮时，工作流发现标签已存在就直接进发布，不会重复打标签；npm 那一步按 registry 上有没有这个
版本判断，已经在线上就只补一个 Release 条目。重跑整次运行一样安全：打标签那步也是「已存在就直接用」。

前提是 `main` 上仍是这个版本号。**`main` 一旦升到下一个版本（比如 0.4.1），0.4.0 就再也发不出去了**
——这是有意的，理由见下。

### 手动推标签（善后）

标签推送这条入口一直在（`on: push: tags`），需要绕开按钮时就用它：

```sh
git push origin :refs/tags/v0.4.0     # 删远端
git tag -d v0.4.0                      # 删本地
git tag -a v0.4.0 -m "chore(release): 0.4.0" origin/main
git push origin v0.4.0                 # 标签不受分支 ruleset 约束，这一推过得去
```

已经建出来的 Release 不必动：工作流发现它已存在就跳过建条目，而 npm 那一步按「这个版本在 registry
上在不在」判断，因此既不会重复发布，也不会漏发。

### 工作流绿了但 `npm view` 查不到

可信发布是异步的：`npm publish` 打出 `+ dsh-aperture@0.4.0` 的同时还会说
「Your package is being processed and may take a few minutes to become available」。在那几分钟里，
registry 对这个版本就是 404，`latest` 也还停在上一版——直接 `curl https://registry.npmjs.org/…`
同样查不到，不是缓存问题，等一会儿再看。

## 标签与提交是怎么绑上的

发布要防的错只有一类：**标签指向的提交不是「这个版本」的那个提交**。历史上的坑正是这么来的——
GitHub 在 Release 页面建标签会把它落在**当刻 main 的 HEAD** 上，`v0.2.0` 于是指到了一个跟版本号无关
的 `ci(publish)!` 提交上（发布提交之后又合了别的改动），发布证明（provenance）就此记下的是一段包含
杂项的区间。

现在的做法是让**同一个工作流在同一次运行里**读版本号、打标签、发布：标签不可能落在别的提交上，也
不需要人去挑提交。发布时刻仍然由人定（按按钮），但「哪个提交配哪个标签」这件事不再由人经手。

Publish 在发 npm 之前仍然做三道硬校验，任何一道不过就**在 npm 之前失败**：

| 校验 | 挡下什么 |
| --- | --- |
| 标签指向的提交里 `package.json` 就是 `vX.Y.Z` | 标签打在版本提交**之后**的某个提交上 |
| 标签指向的提交是 `origin/main` 的祖先 | 标签打在没合进 main 的分支上（比如合并前的那个提交） |
| `main` 当前的 `package.json` 仍是这个版本 | 往旧版本倒灌：main 升到 0.4.2 之后再补发 0.4.1，npm 的 latest 会被拽回去 |

第三道的判据是「main 现在声明的还是这个版本」，**不是**「标签仍是 main 顶端」。后者在 PR-only 之后
已经站不住：所有改动都走 PR，main 一直在动，一次无关的合并就能把它打破，而且打破之后连重跑都救不
回来——`v0.3.3` 就被这样卡过一次。换成前者之后，合并别的 PR 不再影响发布；而 `main` 一旦升到下一个
版本，旧版本就再也发不出去，那正是倒灌的定义。

> 标签必须带 `v` 前缀且能解析成 `x.y.z`（可带预发布后缀，如 `v0.4.0-rc.1`），`v1.2` 这种会直接失败。
> 已在 npm 上的同版本会被识别为「已存在」并安全跳过；这一步跳过时，Release 条目仍然会建出来。
> 判断依据是 `npm view dsh-aperture@<版本>`，而 registry 收下发布不是瞬时的（见「工作流绿了但
> npm view 查不到」），因此刚发完就重跑同一条工作流，它可能仍当成「没发过」去发一次——那一发会被 npm
> 以「该版本已存在」拒绝，工作流随之失败。重跑请等那几分钟过去。

## 版本号在哪、怎么算

**`package.json` 是版本号的唯一来源**，标签只是它的复述——工作流只核对、不改写。改它的是
`pnpm version`（走 PR 时加 `--no-git-tag-version`，只改号），标签由 Release 工作流在同一次运行里打好，
两者因此天然指着同一个提交；发布按钮上那个入参**也只是断言**，不是第二个来源。工作流连
`package.json` 也不改写（早先会用它去「对齐」标签），对齐等于悄悄修正一个本该让你看见的不一致。

升幅由人决定（`pnpm version major|minor|patch|0.4.0`），**没有任何东西自动推算**。这里曾经有两套
机器互相打架：Release Drafter 按 PR 标题算版本号，而人工又用 `pnpm version` 写一遍，两边互不知情，
于是标签落点每次都不一样。现在只留人工这一条。

0.x 阶段的约定是：**破坏性变更按 minor 升**（`feat!:` → `0.4.0` 而不是 `1.0.0`），到 1.0.0 时再
改回按 major 升。这个约定不写进任何配置，因为它就是一个人的判断。

## Release 条目与日志

Release 由 Publish 工作流在 **npm 发布成功之后**创建，所以条目里的版本一定已经在 npm 上，顺序
不会倒过来。日志用 GitHub 自己生成的（`gh release create --generate-notes`），分组规则在
[`.github/release.yml`](../.github/release.yml)。

⚠️ **GitHub 原生只按 label 分组**——`changelog.categories[*].labels` 里的 `*` 是「兜底」而**不是**
通配符（文档原话：Use `*` as a catch-all），没有约定式提交分类器。所以分组靠标签，标签由
[`.github/workflows/autolabeler.yml`](../.github/workflows/autolabeler.yml) 按 **PR 标题**自动补上
（规则表在 [`.github/autolabeler.yml`](../.github/autolabeler.yml)）。因此 **PR 标题要照约定式
提交写**，否则分组会落到「其它改动」：

| PR 标题 | 自动补的标签 | 日志章节 |
| --- | --- | --- |
| `feat(panel)!: …` | `breaking-change` | 💥 破坏性变更 |
| `feat: …` | `enhancement` | ✨ 新功能 |
| `fix: …` | `bug` | 🐛 修复 |
| `docs: …` | `documentation` | 📖 文档 |
| `chore(deps): …` | `dependencies` | ⬆️ 依赖更新 |
| `chore:` / `ci:` / `refactor:` … | `chore` | 🧰 维护 |

分类是**顺序**匹配、第一个命中即止，兜底那一节必须放在最后。带 `!` 的提交会同时拿到
`breaking-change` 与 `enhancement` / `bug`，靠顺序落进「破坏性变更」。标题里那个 emoji 前缀
（`✨ feat: …`）与分组无关，只是给人看的。

Release 条目还带一句「已发布到 npm」的说明，排在自动日志前面。

## 工作流一览

- `.github/workflows/ci.yml`：PR、推 main 时跑 `test` / `typecheck` / `build`（Node 22.19；与官方 DSH
  和本包的 `engines` 下限一致）。它的 job 名 `check` 就是 ruleset 要求的那个状态检查——因此任何 PR
  都得等它绿。
- `.github/workflows/release.yml`：**只在人工点按钮时跑**（`workflow_dispatch`，没有别的入口，合并 PR
  不会触发）。核对入参、核对这次运行落在 `main` 顶端、确认标签还不存在，然后在当刻 `main` 顶端打注解
  标签并推送，最后调下面那个工作流。同一时刻只允许一次发布在跑（`concurrency`），免得两次并发把 npm
  的 `latest` 拽回旧版本。
- `.github/workflows/publish.yml`：由上面那个工作流以 `workflow_call` 调进来，也仍然接受直接推 `v*`
  标签。先复用一遍 ci.yml 的检查，再依次做三道落点校验、发布到 npm、建 Release。发布 job 里额外跑一次
  `pnpm install --frozen-lockfile`，因为 `lib/` 靠 `prepare` 现场编译，而 check job 的依赖不跨 job 共享。
- `.github/workflows/autolabeler.yml`：PR 打开/更新时按标题补标签，上面那节的分组全靠它。
  本仓库**不再**用 Release Drafter 起草 Release——它的核心能力是「按 PR 标题推算版本号」，
  而版本号现在由发布 PR 决定、发布时刻由按钮决定，两者会互相打架（这正是之前版本错位的来源）。

Host 端与 Web Client 端都是构建产物、都不入库：同一份 `tsdown.config.ts` 生成 Host 单文件 ESM
`lib/index.js`、`lib/types/**/*.d.ts`，以及 Web Client 的 `lib/client.js`（含 `.map`）。它们都由
`prepare`（清 `lib/` 后跑完整 tsdown 构建）在安装与发布时现场跑——原因见 [internals.md](internals.md)
的「Host 端与 Web Client 端统一由 tsdown 构建」。

## npm 侧的一次性登记

发布用 npm 的**可信发布**（Trusted Publishing）而不是长期 token——CI 里没有 `NPM_TOKEN` 可偷，
发布时会把 provenance 证明签好。代价是每个新包要在 npm 上登记一次，登记时要选「允许哪些动作」：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `he0119` |
| Repository | `dsh-aperture` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | `npm publish`（界面上的名字；实际放行的是 `createPackage`） |

发新包或换工作流文件名时，要连 Allowed actions 一起核对。名字对不上（大小写、`.yml` 后缀、仓库
归属）会在 OIDC 换 token 那一步失败；动作没放行则在 PUT 那一步拿到
`403 ... OIDC permission denied for this action`——它出现在 OIDC 换 token **成功之后**，别当成
工作流或标签的毛病。`--provenance` 会一并附上构建来源证明，所以发布产物能追溯到具体的 commit
与工作流。
