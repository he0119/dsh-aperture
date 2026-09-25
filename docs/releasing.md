# 发布

发布由**标签**触发，只此一条路：推一个 `v*` 标签，Publish 工作流把它发到 npm 的可信发布
（Trusted Publishing）上，成功后自动建 GitHub Release。本机不需要任何 npm token，也没有
`workflow_dispatch` 入口——手动触发会在默认分支上跑，等于凭空指定一个版本发出去。

发一次版就一条命令：`npm version` 改版本号并打标签，`git push --follow-tags` 推上去。

## 一次发布

main 上有一条 ruleset 要求 `pull_request` 且 `required_linear_history`（禁 merge commit），但
**仓库管理员可以绕过 ruleset**，所以发布提交与标签都直接在本地做、一起推上去：

```sh
# 工作目录必须是干净的，否则 npm version 会拒绝（它会把改动混进发布提交里）。
npm version 0.4.0 -m "chore(release): %s"
# ↑ 一次做三件事：改 package.json 与 package-lock.json、提交、打注解标签 v0.4.0。
#   它只跑 preversion/version/postversion 三个钩子，不会触发本包的 prepare（tsc），因此不会顺带构建。

git push --follow-tags          # 提交与标签一起推上去，Publish 工作流接手

npm view dsh-aperture version   # 几分钟后确认线上的版本
```

`0.4.0` 也可以写成 `patch` / `minor` / `major`，由你决定升幅（见下）。`-m` 里的 `%s` 会被替换成
版本号，所以提交信息是 `chore(release): 0.4.0`——与历史一致。

走这条路的前提是**你以管理员身份绕过 ruleset**。如果哪天想做 code review 或让别人也能发版，就改成
开 PR：`npm version 0.4.0 --no-git-tag-version` → 提交 → 推送分支 → 合并，然后再 `git tag -a v0.4.0`
打标签。多出来的那一步是必要的，因为合并方式（squash）会换掉提交 SHA，`npm version` 顺手打的那个标签
随后就指错了地方。

## 为什么标签要在本地打、且必须打在 main 顶端

GitHub 在 Release 页面建标签时，会把它落在**当刻 main 的 HEAD** 上。历史上正是这么歪的：
`v0.2.0` 那个标签指到了一个跟版本号无关的 `ci(publish)!` 提交上（发布提交之后又合并了别的
改动），于是发布证明（provenance）记的是一段包含杂项的区间。

本地打标签就没有这个问题——标签落点是你自己指定的那个提交，而 `npm version` 更是把「改版本号」
与「打标签」绑在同一个提交上。为了让这条规则可执行，Publish 工作流在发 npm 之前做三道硬校验，
任何一道不过就**在 npm 之前失败**：

| 校验 | 挡下什么 |
| --- | --- |
| 标签指向的提交里 `package.json` 就是 `vX.Y.Z` | 标签打在版本提交**之后**的某个提交上 |
| 标签指向的提交是 `origin/main` 的祖先 | 标签打在没合进 main 的分支上 |
| 标签指向的提交仍**等于** main 顶端 | 版本号已被后续发布取代（发出去就是往旧版本上倒灌） |

`npm version` + `push --follow-tags` 这套天然满足三道：标签与版本号在同一个提交上、这个提交就是
你刚推的 main 顶端。

第三道意味着「一个标签对应一个提交」：**推完标签就别再往 main 推东西了**，否则要么校验失败，要么
你得确认那个新提交该不该进这一版。顺序上先推标签，再继续改代码。

第三道不过时把标签挪到正确的提交上，或者等下一次发布；第一、二道不过说明标签打错了地方，
`git push origin :refs/tags/v0.4.0` 删掉重打。

> 标签必须带 `v` 前缀且能解析成 `x.y.z`（可带预发布后缀，如 `v0.4.0-rc.1`），`v1.2` 这种会直接失败。
> 已在 npm 上的同版本会被识别为「已存在」并安全跳过（发布成功的那一刻 registry 上就能查到，
> 判断是可靠的）；这一步跳过时，Release 条目仍然会建出来。

## 版本号在哪、怎么算

**`package.json` 是版本号的唯一来源**，标签只是它的复述——工作流只核对、不改写。改动它的是
`npm version`，它把「改版本号」「提交」「打标签」合成一个动作，因此版本号与标签天然指着同一个提交。
工作流连 `package.json` 也不改写（早先会用它去「对齐」标签），对齐等于悄悄修正一个本该让你看见的
不一致。

升幅由人决定（`npm version major|minor|patch|0.4.0`），**没有任何东西自动推算**。这里曾经有两套
机器互相打架：Release Drafter 按 PR 标题算版本号，而人工又用 `npm version` 写一遍，两边互不知情，
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

- `.github/workflows/ci.yml`：PR、推 main 时跑 `test` / `typecheck` / `build`（Node 24.11；与 `engines` 下限一致）。
- `.github/workflows/publish.yml`：推 `v*` 标签时先复用一遍上面的检查，再依次做三道落点校验、
  发布到 npm、建 Release。发布 job 里额外跑一次 `npm ci`，因为 `lib/` 靠 `prepare` 现场编译，
  而 check job 的依赖不跨 job 共享。
- `.github/workflows/autolabeler.yml`：PR 打开/更新时按标题补标签，上面那节的分组全靠它。
  本仓库**不再**用 Release Drafter 起草 Release——它的核心能力是「按 PR 标题推算版本号」，
  而版本号现在由发布 PR 决定，两者会互相打架（这正是之前版本错位的来源）。

包里的两半边都是构建产物、都不入库：`lib/`（宿主半边）由 `tsc -p tsconfig.json` 编译，`lib/client.js`
（浏览器半边，含 `.map`）由 `tsdown` 从 `src/client/` 打包，两者都由 `prepare`（`npm run build`）在安装与
发布时现场跑——原因见 [internals.md](internals.md) 的「浏览器半边也要构建」。

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
