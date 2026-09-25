# 开发

安装与配置看 [README](../README.md)；这里放本地开发的流程——怎么构建、怎么测、怎么起一个专门
用来验证的实例。「为什么是现在这样」在 [internals.md](internals.md)，发布在 [releasing.md](releasing.md)。

## 装依赖、构建、检查、测试

```sh
npm install                # 若机器级 npm 缓存不可写：npm install --cache ./.npm-cache --ignore-scripts
npm run build              # tsc -> lib/（宿主半边）+ tsdown -> lib/client.js（浏览器半边）
npm run typecheck          # test/ 与浏览器半边两个 tsc 项目
npm test                   # 单元测试 + 端到端（229 个，离线运行；需要已安装的 devDependencies）

DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run test:live   # 只跑端到端，且指向真实实例
DSH_APERTURE_LIVE_URL=https://ai.example.ts.net npm run inspect     # 手动走查：打印写入后的补丁文档与 LLM 解析结果（先 npm run build）
```

`npm test` 里的端到端那一份（`test/live.test.ts`）不依赖网络：它在本地起一个假网关
（`test/fake-gateway.ts`，端口由内核挑），把插件挂到真的 Cordis Loader 上，再断言写进 profile
补丁文档的东西能被真的 `llm-pi-ai` 解析出来，所以 CI 跑得动它。三份测试各证一件不同的事，见
[internals.md](internals.md) 的「验证：哪一层证明什么」。

不在 Tailscale 网络里、又想手动看生成的配置段时，可以自己把那个假网关摆在固定端口上：

```sh
node scripts/fake-aperture-gateway.mjs 54117
DSH_APERTURE_LIVE_URL=http://127.0.0.1:54117 npm run inspect
```

## 改代码时两半都要构建，但生效方式不一样

两半都是编译产物：宿主半边 `src/*.ts` → `lib/*.js`（`tsc`），浏览器半边 `src/client/index.tsx` →
`lib/client.js`（`tsdown`）。因此改完都要构建——只改了半边时跑对应的那一条更省事：

```sh
npm run build:host      # 只重编宿主半边
npm run build:client    # 只重打浏览器半边
npm run watch:client    # 浏览器半边一直重打，改完只管刷新页面
```

`lib/` 里那份的 mtime 比源文件旧，就说明它还没构建（`lib/` 不入库，见 [releasing.md](releasing.md)）。

生效方式不同：宿主半边加载的是 `lib/`，改完必须**重启宿主**；浏览器半边由 DSH 按文件直接服务
产物，重建之后**刷新页面**就见效，不必重启。表现上最容易误判的是「改了没反应」——客户端改动要
刷新页面，宿主改动要重启，两件事都不是「改错了」。为什么浏览器半边现在也要打包（而不是像以前那样
手写产物），见 [internals.md](internals.md) 的「浏览器半边也要构建」。

## 起一个专门的开发实例

宿主半边的改动要重启才生效，但不必为此停掉日常在用的那个实例：另建一个**开发 profile**（从
shipped 的 `web` 模板拷一份），把本仓库装进去，再在另一个端口上起它。

```sh
npx @deepseek-ai/dsh@next --profile web-dev --from-default-profile web   # 只做一次：建出 ~/.dsh/profiles/web-dev
npx @deepseek-ai/dsh@next plugin --profile web-dev add /path/to/dsh-aperture
npx @deepseek-ai/dsh@next web-dev --port 3081                            # 开发实例，与日常那个实例互不影响
```

`dsh <name>` 就是 `dsh --profile <name>`，因此 `web-dev` 是 **profile 名**而不是子命令；`--port`
是 web app 自己的旗标（与 `--host` / `--no-open` / `--trusted-host` 同一族），启动器只认自己的几个
旗标，不认识的参数原样转给 app。装进开发 profile 的是**仓库目录本身**（`link:`），所以
`npm run build` 之后重启这个实例就能看到宿主半边的改动，日常那个实例不受影响。

开发 profile 就是普通 profile：它的 Aperture 地址与同步开关写在
`~/.dsh/profiles/web-dev/cordis.patch.yml`，与日常那个各写各的。因此在开发实例里点「立刻刷新」、
在配置页里改设置，落的都是这个文件，不会碰日常实例的配置。
