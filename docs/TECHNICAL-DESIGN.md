# NoteX 技术设计方案

## 1. 技术栈

| 类型 | 技术 |
|---|---|
| 包管理器 | pnpm |
| 桌面框架 | Tauri 2 |
| 原生开发 | Rust |
| 前端语言 | TypeScript |
| 构建工具 | Vite |
| 前端框架 | Vue 3 |
| UI 组件库 | Element Plus |
| 状态管理 | Pinia |
| 路由管理 | Vue Router |
| 样式方案 | SCSS |
| 本地数据库 | SQLite |
| SQLite 驱动 | rusqlite |
| Markdown 编辑器 | CodeMirror 6 |
| 前端代码检查 | Oxlint |
| 前端代码格式化 | Oxfmt |
| Vue 类型检查 | vue-tsc |
| Rust 格式化与检查 | rustfmt + Clippy |
| 测试 | Vitest + Vue Test Utils + Cargo Test |

项目初始化时使用各技术的最新稳定版本，不使用 Alpha、Beta、RC、Nightly 或 Git 开发版本。

实际依赖版本通过以下锁文件固定：

```text
pnpm-lock.yaml
src-tauri/Cargo.lock
```

`.npmrc` 建议启用精确版本：

```ini
save-exact=true
```

## 2. 总体架构

```text
Vue 前端界面
  ↓ Tauri invoke / Channel
Rust 原生层
  ↓
SQLite / 本地文件系统
```

职责边界：

- Vue 负责页面、组件、交互和界面状态。
- TypeScript Service 统一封装 Tauri 调用。
- Rust 负责业务规则、SQLite、文件系统和原生能力。
- 前端不直接执行 SQL，也不直接访问应用数据目录。

Rust 采用：

```text
Command → Service → Repository → SQLite / File System
```

## 3. 前端规范

统一使用 Vue Composition API 和 `<script setup lang="ts">`：

```vue
<script setup lang="ts">
</script>

<template>
</template>

<style scoped lang="scss">
</style>
```

目录职责：

- `src/views/`：页面。
- `src/layouts/`：布局。
- `src/components/`：通用组件。
- `src/features/`：业务模块。
- `src/services/`：Tauri 调用封装。
- `src/stores/`：Pinia 状态。
- `src/composables/`：可复用逻辑。
- `src/types/`：公共类型。
- `src/utils/`：工具函数。
- `src/styles/`：全局样式和主题。

其他要求：

- 基础组件优先使用 Element Plus，并采用按需自动导入。
- 产品核心布局和复杂业务组件自行封装。
- 路由使用 Vue Router Hash 模式。
- Markdown 源码编辑器使用 CodeMirror 6。
- Vue 组件不得直接调用原始 `invoke()`。

## 4. 样式方案

使用 SCSS 和 CSS Custom Properties：

```text
src/styles/
├── _tokens.scss
├── _mixins.scss
├── _themes.scss
├── _element-plus.scss
├── reset.scss
└── global.scss
```

规则：

- 组件样式默认使用 `scoped`。
- CSS 变量用于浅色、深色和跟随系统主题。
- Element Plus 主题覆盖集中维护。
- 避免大量内联样式、过深选择器嵌套和无理由使用 `!important`。

## 5. Rust 与 SQLite

Rust 分层职责：

- Command：接收参数、基础校验、调用 Service、返回结果。
- Service：业务规则、事务边界、数据库与文件操作协调。
- Repository：SQL 和数据库实体映射。

SQLite 使用 `rusqlite` bundled 模式，避免依赖操作系统 SQLite。

连接初始化至少执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

数据库要求：

- SQLite 仅由 Rust 访问。
- SQL 必须参数化。
- 数据库写入使用事务。
- 数据库任务不得阻塞 Tauri 主线程。

## 6. 数据库迁移

迁移文件统一放在：

```text
src-tauri/migrations/
├── V001__initial_schema.sql
├── V002__add_indexes.sql
└── V003__update_schema.sql
```

规则：

- 所有结构变更必须新增 Migration。
- 已发布 Migration 不得修改。
- 单个迁移在事务中执行。
- 迁移失败时不得继续启动正常业务。
- 数据结构变更必须补充迁移测试。

## 7. Tauri 插件与安全

建议插件：

| 插件 | 用途 |
|---|---|
| dialog | 文件或目录选择 |
| clipboard-manager | 剪贴板访问 |
| opener | 打开本地文件或目录 |
| log | 本地日志 |
| window-state | 保存窗口大小和位置 |
| single-instance | 防止多个实例同时运行 |

安全原则：

- Capability 使用最小权限。
- 不开放 Shell、任意 HTTP 或任意文件系统权限。
- 不加载远程页面，不启用远程 IPC。
- 前端不得传入任意数据库或文件路径。
- Rust 必须校验文件路径和允许范围。
- 不使用 `v-html` 渲染不可信内容。
- 日志不得记录笔记正文、剪贴板内容和敏感数据。
- 启动、设置和导出响应不得向前端返回应用数据目录、数据库、资源或日志的绝对路径；需要打开本地目录时只能由后端接受固定标识后受控执行。
- 全文索引必须随单笔记写入在同一事务内增量更新；只在启动恢复或用户主动修复索引时执行全量重建，避免自动保存随数据规模线性退化。
- 自动保存失败的恢复草稿必须在下一次成功启动时以事务恢复，恢复完成后删除草稿；恢复失败时保留原草稿并停止写入。

## 8. 代码质量工具

前端工具职责：

| 工具 | 职责 |
|---|---|
| Oxfmt | 格式化 TypeScript、Vue、SCSS、JSON、Markdown 等前端文件 |
| Oxlint | 检查 JavaScript、TypeScript 和 Vue `<script>` |
| vue-tsc | 检查 Vue SFC、Template 和 TypeScript 类型 |
| Vitest | 前端单元测试 |

Rust 工具职责：

| 工具 | 职责 |
|---|---|
| rustfmt | Rust 格式化 |
| Clippy | Rust 静态检查 |
| Cargo Test | Rust 测试 |

推荐 Oxfmt 配置文件：`.oxfmtrc.json`。

```json
{
  "semi": false,
  "singleQuote": true,
  "tabWidth": 2,
  "useTabs": false,
  "trailingComma": "all",
  "printWidth": 100,
  "endOfLine": "lf",
  "ignorePatterns": [
    "dist/**",
    "coverage/**",
    "src-tauri/target/**"
  ]
}
```

## 9. 项目目录

```text
notex/
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── .oxlintrc.jsonc
├── .oxfmtrc.json
│
├── docs/
│   ├── PRD.md
│   ├── TECHNICAL-DESIGN.md
│   ├── DATABASE.md
│   └── design/
│
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── app/
│   ├── views/
│   ├── layouts/
│   ├── features/
│   ├── components/
│   ├── services/
│   ├── stores/
│   ├── composables/
│   ├── types/
│   ├── utils/
│   └── styles/
│
└── src-tauri/
    ├── Cargo.toml
    ├── Cargo.lock
    ├── tauri.conf.json
    ├── capabilities/
    ├── migrations/
    └── src/
        ├── commands/
        ├── services/
        ├── repositories/
        ├── database/
        ├── domain/
        └── utils/
```

## 10. 开发脚本

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "format": "oxfmt",
    "format:check": "oxfmt --check",
    "lint": "oxlint --type-aware",
    "lint:fix": "oxlint --type-aware --fix",
    "typecheck": "vue-tsc --noEmit",
    "test": "vitest run",
    "check:frontend": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "check:rust": "cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml",
    "check": "pnpm check:frontend && pnpm check:rust"
  }
}
```

## 11. 测试与发布

前端使用 Vitest 和 Vue Test Utils，Rust 使用 Cargo Test。

要求：

- 数据库测试使用临时 SQLite。
- 文件测试使用临时目录。
- 缺陷修复应增加回归测试。
- macOS 执行前端检查、Rust 检查和 Tauri 构建。

发布目标：

- macOS：自用阶段生成未签名 DMG；未来对外分发时再完成签名和 Apple 公证。

## 12. 最终技术决策

1. 使用 Tauri 2，不使用 Electron。
2. 使用 Vue 3、TypeScript、Vite、Element Plus 和 SCSS 开发前端。
3. 使用 Pinia 管理状态，Vue Router 使用 Hash 模式。
4. 使用 CodeMirror 6 实现 Markdown 源码编辑器。
5. 使用 Rust 管理 SQLite、文件系统和原生能力。
6. Vue 前端不直接执行 SQL 或访问应用数据目录。
7. Rust 使用 Command、Service、Repository 分层。
8. SQLite 使用 rusqlite bundled，并通过 Migration 管理结构。
9. 使用 Oxfmt 格式化前端代码，不使用 Prettier。
10. 使用 Oxlint 检查前端代码，不使用 ESLint。
11. 使用 vue-tsc 补充 Vue SFC 和 Template 类型检查。
12. 使用 rustfmt、Clippy 和 Cargo Test 保证 Rust 代码质量。
13. 使用 `pnpm-lock.yaml` 和 `Cargo.lock` 固定依赖版本。
