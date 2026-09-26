# 开发

安装与配置看 [README](../README.md)；这里放本地开发的流程——怎么构建、怎么测、怎么起一个专门
用来验证的实例。「为什么是现在这样」在 [internals.md](internals.md)，发布在 [releasing.md](releasing.md)。

## 装依赖、构建、检查、测试

```sh
pnpm install               # 若机器级 pnpm store 不可写：pnpm install --store-dir ./.pnpm-store
pnpm run build             # tsdown 统一生成宿主、声明与浏览器产物
pnpm run typecheck         # Host/test 与 Web Client 两个 tsc 项目
pnpm test                  # 单元测试 + 端到端（232 个，离线运行；需要已安装的 devDependencies）

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net pnpm run test:live   # 只跑端到端，且指向真实实例
DSH_APERTURE_LIVE_URL=https://ai.example.ts.net pnpm run inspect     # 手动走查：打印写入后的补丁文档与 LLM 解析结果（先 pnpm run build）
```

包管理器是 pnpm，版本由 `package.json` 的 `packageManager` 钉在 `pnpm@11.7.0`，经 corepack 生效
（`pnpm --version` 打出来的就是它；`pnpm --version` 不对时先 `corepack enable`）。几个与 npm 不同的地方：

- `pnpm install` 会跑 `prepare`，也就是顺手做一次完整构建；CI 用的是 `pnpm install --frozen-lockfile`。
- pnpm 11 默认就会跑 `pre` / `post` 脚本（与 npm 一致），所以 `prebuild` 仍然先清 `lib/`、
  `pretest` 仍然先重打 Web Client 产物——不必额外配 `enable-pre-post-scripts`。
- pnpm 默认拦住依赖自带的安装脚本，清单在 `pnpm-workspace.yaml` 的 `allowBuilds`（本仓库只有这一处用到
  该文件）。装完提示 `Ignored build scripts` 时，看那里的注释再决定是否放行。

`pnpm test` 里的端到端那一份（`test/live.test.ts`）不依赖网络：它在本地起一个假网关
（`test/fake-gateway.ts`，端口由内核挑），把插件挂到真的 Cordis Loader 上，再断言写进 profile
补丁文档的东西能被真的 `llm-pi-ai` 解析出来，所以 CI 跑得动它。三份测试各证一件不同的事，见
[internals.md](internals.md) 的「验证：哪一层证明什么」。

不在 Tailscale 网络里、又想手动看生成的配置段时，可以自己把那个假网关摆在固定端口上：

```sh
node scripts/fake-aperture-gateway.mjs 54117
DSH_APERTURE_LIVE_URL=http://127.0.0.1:54117 pnpm run inspect
```

## 改代码时两端都要构建，但生效方式不一样

Host 端与 Web Client 端都由同一份 `tsdown.config.ts` 构建：Host 端 `src/*.ts` → 单一 ESM `lib/index.js` +
按模块输出的 `lib/types/**/*.d.ts`，Web Client 端 `src/client/`（`index.ts` 装配 +
`AperturePanel.tsx` 页面 + `ModelRow.tsx` / `ModelEditor.tsx` 行与编辑器 + `draft.ts` 草稿换算 +
`locales.ts` / `remote.ts` / `format.ts` / `styles.ts` + `styles.css`）→ `lib/client.js`。因此改完都要构建——只改了一端时跑对应的那一条更省事：

```sh
pnpm run build           # 清理 lib/，重打宿主、声明与浏览器三份产物
pnpm run build:host      # 只重打 Host ESM 与声明
pnpm run build:client    # 只重打 Web Client 端
pnpm run watch           # 两端一起监听
pnpm run watch:client    # Web Client 端一直重打，改完只管刷新页面
```

`lib/` 里那份的 mtime 比源文件旧，就说明它还没构建（`lib/` 不入库，见 [releasing.md](releasing.md)）。

生效方式不同：Host 端加载的是 `lib/`，改完必须**重启 Host**；Web Client 端由 DSH 按文件直接服务
产物，重建之后**刷新页面**就见效，不必重启。表现上最容易误判的是「改了没反应」——客户端改动要
刷新页面，Host 端改动要重启，两件事都不是「改错了」。两端的构建契约见
[internals.md](internals.md) 的「Host 端与 Web Client 端统一由 tsdown 构建」。

## 起一个专门的开发实例

Host 端的改动要重启才生效，但不必为此停掉日常在用的那个实例：另建一个**开发 profile**（从
shipped 的 `web` 模板拷一份），把本仓库装进去，再在另一个端口上起它。

```sh
npx @deepseek-ai/dsh@next --profile web-dev --from-default-profile web   # 只做一次：建出 ~/.dsh/profiles/web-dev
npx @deepseek-ai/dsh@next plugin --profile web-dev add /path/to/dsh-aperture
npx @deepseek-ai/dsh@next web-dev --port 3081                            # 开发实例，与日常那个实例互不影响
```

`dsh <name>` 就是 `dsh --profile <name>`，因此 `web-dev` 是 **profile 名**而不是子命令；`--port`
是 web app 自己的旗标（与 `--host` / `--no-open` / `--trusted-host` 同一族），启动器只认自己的几个
旗标，不认识的参数原样转给 app。装进开发 profile 的是**仓库目录本身**（`link:`），所以
`pnpm run build` 之后重启这个实例就能看到 Host 端的改动，日常那个实例不受影响。

开发 profile 就是普通 profile：它的 Aperture 地址与同步开关写在
`~/.dsh/profiles/web-dev/cordis.patch.yml`，与日常那个各写各的。因此在开发实例里点「立刻刷新」、
在配置页里改设置，落的都是这个文件，不会碰日常实例的配置。
