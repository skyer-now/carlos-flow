# vendor/

- `acorn.mjs`：acorn 8.15.0 的官方 ESM 构建（MIT，见 `acorn-LICENSE`），用于 `scripts/ast-negative-control.mjs` 与 `src/ast-assertions.js` 的 AST 断言比对。
- 为什么随包存放而不声明为 npm 依赖：Cindy 插件以 `.cindy` 形态随包运行，宿主不保证安装 `node_modules`（已实测本机插件目录没有依赖），声明依赖会让 AST 能力在真实插件环境静默不可用。
- 升级方式：从 npm registry 取同版本 `dist/acorn.mjs` 与 `LICENSE` 覆盖，并更新本文件中的版本号。
