/**
 * vue-tsc 启动 wrapper
 * 职责:让 vue-tsc 在 TypeScript 7.0 + Node 24 环境下正常工作
 *
 * 背景(vue-tsc 3.3.8 与 TS 7.0 架构性不兼容):
 *   - vue-tsc 的工作机制是:读取 tsc.js 源码 → 正则补丁(注入 .vue 扩展支持、
 *     代理 createProgram) → 执行补丁后的 tsc;
 *   - TypeScript 7.0 用 Go 重写了编译器,`lib/tsc.js` 只是 28 行的启动器,
 *     通过 execFileSync 调用原生 Go 可执行文件,不再有可补丁的 JS 源码;
 *   - 因此 vue-tsc 报错 "Failed to locate tsc module path from shim",
 *     这是架构性失效,不是简单的路径问题,补丁无法解决。
 *
 * 方案(双 TS 版本并存,官方推荐的兼容路径):
 *   - 主 TypeScript 保留 7.0:供主进程 `tsc -p tsconfig.electron.json` 使用,
 *     享受 Go 编译器的 10 倍性能提升;
 *   - 额外安装 `@typescript/typescript6`:它依赖 `@typescript/old`(npm alias
 *     到 typescript@^6),提供完整的 TS 6 JS 编译器源码;
 *   - 本 wrapper 显式将 `@typescript/old/lib/tsc.js` 路径传给 vue-tsc.run(),
 *     让 vue-tsc 用 TS 6 的 tsc.js 完成 .vue 文件的类型检查。
 *
 * 这样实现:
 *   ✅ Node.js 24(用户诉求)
 *   ✅ TypeScript 7.0 主力(用户诉求,不降级)
 *   ✅ vue-tsc 类型检查可用(通过 TS 6 兼容包)
 *   ✅ 不修改 node_modules(npm install 后仍可用)
 *
 * 用法:
 *   node scripts/vue-tsc.cjs --noEmit          # 等价于 `vue-tsc --noEmit`
 *   node scripts/vue-tsc.cjs --noEmit -p tsconfig.json
 */
const path = require('node:path');

// 解析 @typescript/old 包根目录(npm alias 到 typescript@^6,提供完整 TS 6 编译器源码)
// @typescript/old 的 package.json 通过 exports 暴露 ./package.json
const ts6PkgPath = require.resolve('@typescript/old/package.json');
const ts6Root = path.dirname(ts6PkgPath);

// 拼接出 @typescript/old/lib/tsc.js 的绝对路径(TS 6 完整 JS 编译器,vue-tsc 可补丁)
const tsc6Path = path.join(ts6Root, 'lib', 'tsc.js');

// 调用 vue-tsc 的 run(),显式传入 TS 6 的 tsc 路径,绕过其默认的 TS 7.0 路径解析
require('vue-tsc').run(tsc6Path);
