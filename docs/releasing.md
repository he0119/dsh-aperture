# 发布

推标签即**发布**：CI 用 npm 的可信发布（Trusted Publishing）把版本直接发上 npm——本机不需要持有任何 npm token，
发版就是推标签这一件事。

```sh
npm version patch                  # 或 minor / major：改 package.json 与 lockfile，并打本地标签
git push --follow-tags             # 标签推到 GitHub 后，Publish 工作流接手发布
npm view dsh-aperture version      # 几分钟后确认线上的版本
```

npm 侧登记的 Allowed actions 必须包含工作流实际用的动作（这里是 `npm publish`，即 `createPackage`）。动作没放行会在
PUT 那一步拿到 `403 ... OIDC permission denied for this action`——它出现在 OIDC 换 token **成功之后**，别当成工作流
或标签的毛病。

包里的两半边来源不同：`lib/`（宿主半边）不入库，由 `prepare`（`tsc -p tsconfig.json`）在安装与发布时现场编译；
`client/aperture.js`（浏览器半边）是手写的经典脚本，原样随包分发、不经过构建——原因见
[internals.md](internals.md) 的「浏览器半边没有构建步骤」。

- `.github/workflows/ci.yml`：PR、推 main 时跑 `test` / `typecheck` / `build`（Node 24；`engines` 下限也是 24）。
- `.github/workflows/publish.yml`：推 `v*` 标签时先复用一遍上面的检查，通过后把版本直接发到 npm；发布 job 里
  额外跑一次 `npm ci`，因为 `lib/` 靠 `prepare` 现场编译，而 check job 的依赖不跨 job 共享。也可以在
  Actions 页面手动 `workflow_dispatch`，并用输入框指定版本号（留空则用 `package.json` 里的）。
- `.github/workflows/release-drafter.yml`：PR 合并进 main 后维护一个 Release 草稿（见下节）；PR 打开时还会自动补标签。

## Release 草稿（Release Drafter）

`.github/release-drafter.yml` 负责把上一个 Release 之后合并的 PR 整理成下一个 Release 草稿，
标题就是下一版本号（如 `v0.2.0`）。PR 标题是约定式提交，所以归类直接读标题，不必手动打标签：

| PR 标题 | 草稿章节 | 版本升幅 |
| --- | --- | --- |
| 带 `!` 的（如 `feat(panel)!: …`） | 💥 破坏性变更 | major |
| `feat: …` | ✨ 新功能 | minor |
| `fix: …` | 🐛 修复 | patch |
| `docs: …` | 📖 文档 | patch |
| `chore(deps): …` | ⬆️ 依赖更新 | patch |
| 其余（`chore` / `ci` / `refactor` …） | 🧰 维护 | patch |

留给人工的只有三个标签：`major` / `minor` 强制升版本（多个规则命中取最高），`skip-changelog` 让这条 PR 整个不进草稿。
PR 打开时 Autolabeler 会按标题与分支名补标签，方便筛 PR——分组本身不依赖它们（fork 来的 PR 打不上标签也不影响归类）。

**发布草稿就等于发版**：在 Releases 页面把草稿 Publish（或在 Actions 页对 Release Drafter 手动 `workflow_dispatch`
并勾选 `publish`），生成的 `v*` 标签会触发 Publish 工作流直接发布。于是两条路都汇到同一个 Publish：
手动 `npm version` 推标签，或者发布草稿。

不要混用这两条路：手动推了标签而 GitHub Release 里没有对应条目时，草稿仍按**上一个 GitHub Release** 推算版本号，会和
已经发到 npm 的错位。走手动路就把草稿改名成同一版本再发布（或删掉草稿），要么就只走草稿这一条。

版本号以**标签为准**：`v0.1.1` 会把 `package.json` 与 lockfile 里的版本改写成 `0.1.1` 再发布，所以偶尔忘了先
`npm version` 也不会发错；标签里的版本不合法（如 `v1.2`）则工作流直接失败。已在 npm 上的同版本会被识别为「已存在」并
安全跳过——发布成功的那一刻 registry 上就能查到，判断是可靠的。

发布用 npm 的**可信发布**（Trusted Publishing）而不是长期 token——CI 里没有 `NPM_TOKEN` 可偷，发布时会把 provenance
证明签好。代价是每个新包要在 npm 上一次性登记，登记时还要选「允许哪些动作」：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `he0119` |
| Repository | `dsh-aperture` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | `npm publish` |

发新包或换工作流文件名时，要连 Allowed actions 一起核对。名字对不上（大小写、`.yml` 后缀、仓库归属）会在 OIDC 换
token 那一步失败，与动作没放行那条 403 是不同的故障。`--provenance` 会一并附上构建来源证明，所以发布产物能追溯到具体
的 commit 与工作流。
