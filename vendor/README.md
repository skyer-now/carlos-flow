# vendor/

- `acorn.mjs`：acorn 8.15.0 的官方 ESM 构建（MIT，见 `acorn-LICENSE`），用于 `scripts/ast-negative-control.mjs` 与 `src/ast-assertions.js` 的 AST 断言比对。
- 为什么随包存放而不声明为 npm 依赖：Cindy 插件以 `.cindy` 形态随包运行，宿主不保证安装 `node_modules`（已实测本机插件目录没有依赖），声明依赖会让 AST 能力在真实插件环境静默不可用。
- 当前版本：acorn 8.15.0（文件内无版本号，以本条记录为准）。升级时从 npm registry 取同版本 `dist/acorn.mjs` 与 `LICENSE` 覆盖，并更新本行与下方 SHA256。
- 当前 SHA256：`b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249`（可用 `sha256sum vendor/acorn.mjs` 复核）。
