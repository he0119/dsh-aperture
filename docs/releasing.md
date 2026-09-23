# 发布

推标签即发布，不需要在本机持有 npm 凭据：

```sh
npm version patch          # 或 minor / major：改 package.json 与 lockfile，并打本地标签
git push --follow-tags     # 标签推到 GitHub 后，Publish 工作流接手
```

包里的两半边来源不同：`lib/`（宿主半边）不入库，由 `prepare`（`tsc -p tsconfig.json`）在安装与发布时现场编译；`client/aperture.js`（浏览器半边）是手写的经典脚本，原样随包分发、不经过构建——原因见 [internals.md](internals.md) 的「浏览器半边没有构建步骤」。

- `.github/workflows/ci.yml`：PR、推 main 时跑 `test` / `typecheck` / `build`（Node 24；`engines` 下限也是 24）。
- `.github/workflows/publish.yml`：推 `v*` 标签时先复用一遍上面的检查，通过后才发布；也可以在
  Actions 页面手动 `workflow_dispatch`，并用输入框指定版本号（留空则用 `package.json` 里的）。

版本号以**标签为准**：`v0.1.1` 会把 `package.json` 与 lockfile 里的版本改写成 `0.1.1` 再发布，
所以偶尔忘了先 `npm version` 也不会发错版本号。标签里的版本若不合法（如 `v1.2`），工作流直接失败。
同版本重复发布会被识别为「已存在」并安全跳过，而不是把红叉留给一次无害的重跑。

发布用 npm 的**可信发布**（Trusted Publishing）而不是长期 token——CI 里没有 `NPM_TOKEN` 可偷。
代价是每个新包要在 npm 上一次性登记。`dsh-aperture` 在 0.1.0 发布时已经登记过，后续版本不用再管；
只有全新包才需要先在
[npmjs.com](https://www.npmjs.com/package/dsh-aperture/access) 的包设置里加上这个 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `he0119` |
| Repository | `dsh-aperture` |
| Workflow filename | `publish.yml` |
| Environment | 留空 |

换了工作流文件名（或改了仓库归属）就要同步改这里，否则发布会在 OIDC 换 token 那一步失败。
`--provenance` 会一并附上构建来源证明，所以发布产物能追溯到具体的 commit 与工作流。
