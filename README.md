# NoteX

NoteX 是一款本地笔记桌面应用。项目使用 Tauri 2、Vue 3、TypeScript、Rust 和 SQLite 构建。

## 下载安装

可从本仓库 [GitHub Releases](https://github.com/XPoet/notex/releases) 最新版本页面 的 **Assets** 直接下载安装包，无需安装开发环境：

| 平台                          | 安装包                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Windows x64                   | `NoteX_<版本号>_windows_x64-setup.exe`，或用于 MSI 安装的 `NoteX_<版本号>_windows_x64.msi` |
| macOS Apple Silicon（M 系列） | `NoteX_<版本号>_macos_aarch64.dmg`                                                         |

Windows 运行 EXE 或 MSI 安装；macOS 打开 DMG，将 NoteX 拖入“应用程序”。当前 Windows 安装包未配置代码签名证书，macOS 使用 ad-hoc 签名且未经 Apple 公证，首次安装或启动可能出现系统安全提示。安装说明、校验方法和发布启用步骤见 [发布指南](docs/RELEASE.md)。

## 技术栈

| 范围       | 技术                                                   |
| ---------- | ------------------------------------------------------ |
| 桌面端     | Tauri 2、Rust                                          |
| 前端       | Vue 3、TypeScript、Vite、Vue Router、Pinia             |
| UI 与样式  | Element Plus 按需导入、SCSS                            |
| 编辑器     | CodeMirror 6                                           |
| 本地存储   | SQLite、rusqlite bundled                               |
| 测试与质量 | Vitest、Vue Test Utils、Oxfmt、Oxlint、vue-tsc、Clippy |

## 开发环境

当前工程基线使用 Node.js `25.2.1`、pnpm `10.13.1` 和 Rust `1.96.1`；Rust 最低版本由 `src-tauri/Cargo.toml` 固定为 `1.85`。

在 macOS 上还需要安装 Xcode Command Line Tools，以便编译 Tauri 原生应用：

```bash
xcode-select --install
```

可先确认本地工具链：

```bash
node --version
pnpm --version
rustc --version
cargo --version
```

## 安装依赖

首次克隆或切换到新工作区后，使用锁文件安装依赖：

```bash
pnpm install --frozen-lockfile
```

不要手动修改 `pnpm-lock.yaml` 或 `src-tauri/Cargo.lock`。新增或升级依赖必须先确认现有依赖无法满足需求，并完成完整质量门验证。

## 启动与调试

### 仅调试前端页面

```bash
pnpm dev
```

Vite 会启动在 `http://localhost:1420`。该命令只验证浏览器前端，不会加载 Tauri IPC，也不会初始化实际应用数据目录。

### 调试完整桌面应用

```bash
pnpm tauri:dev
```

该命令会自动启动 Vite，再启动 Tauri 原生窗口。应用启动后会执行本地数据初始化：

1. 通过 Tauri 系统路径 API 获取固定应用数据目录。
2. 创建 `database`、`assets`、`temp`、`logs`、`config` 子目录。
3. 创建或打开 `database/notex.db`。
4. 应用 V001 Migration，并向前端返回数据目录与结构版本。

初始化失败时，应用显示安全诊断与重试入口；不会把 SQL、数据库绝对路径或笔记内容暴露给界面。

## 常用命令

| 命令                | 用途                                         |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | 仅启动 Vite 前端开发服务器                   |
| `pnpm tauri:dev`    | 启动完整 Tauri 桌面应用                      |
| `pnpm format`       | 格式化前端代码与受管文档                     |
| `pnpm format:check` | 检查前端格式                                 |
| `pnpm lint`         | 使用 Oxlint 进行类型感知检查                 |
| `pnpm typecheck`    | 使用 vue-tsc 检查 TypeScript 与 Vue SFC 类型 |
| `pnpm test`         | 运行 Vitest 测试                             |
| `pnpm build`        | 执行前端类型检查并构建静态资源               |
| `pnpm tauri:build`  | 构建 Tauri 原生发行包                        |
| `pnpm release`      | 递增补丁版本、检查、生成 DMG 并创建版本提交  |
| `pnpm check`        | 运行完整前端与 Rust 质量门                   |

可针对当前启动闭环运行聚焦验证：

```bash
pnpm exec vitest run bootstrap
cargo test --manifest-path src-tauri/Cargo.toml bootstrap
```

## 质量检查

提交前必须执行：

```bash
pnpm check
git diff --check
```

`pnpm check` 会顺序执行：

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 构建与打包

### GitHub 自动发布

`main` 收到推送时（包括通过 Pull Request 合并 `develop`），GitHub Actions 自动递增补丁版本，例如 `0.0.10 → 0.0.11`，同步四处 NoteX 自身版本，生成版本提交与标签并将版本提交回 `main`，随后构建 Windows x64（EXE、MSI）及 macOS Apple Silicon 安装包。质量检查与全部构建成功、安装包完整性检查通过后，才公开 GitHub Release，并附上下载链接、自动生成的变更说明和 `SHA256SUMS.txt`。

日常发版可直接推送 `main`，或推送 `develop` 并合并 PR，无需提前执行 `pnpm release` 或修改版本号。同一次推送的失败重跑复用已分配版本，不会重复递增；版本分配参考仓库、`main`、已有标签和草稿中的最高正式版本，避免连续合并时发生版本冲突。版本提交只更新 NoteX 自身版本，不升级依赖；`src-tauri/Cargo.lock` 仅同步 `NoteX` 包版本。

### 本地准备新版本

以下命令保留为本机 Mac 独立打包工具，GitHub 自动发布不要求执行。若先手动递增版本，再合并 PR，工作流仍会在最高版本基础上额外递增一次 patch。

先提交当前开发改动，确保 Git 工作区没有未提交或未跟踪的文件，再执行：

```bash
pnpm release --dry-run # 预览下一补丁版本，不修改文件或创建提交
pnpm release           # 默认递增 patch，例如 0.0.7 → 0.0.8
pnpm release minor     # 递增 minor，例如 0.0.7 → 0.1.0
pnpm release major     # 递增 major，例如 0.0.7 → 1.0.0
pnpm release 1.2.3     # 指定高于当前版本的正式版本号
```

发布命令同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src-tauri/Cargo.lock` 中 NoteX 自身的版本，不修改依赖版本或 pnpm 锁文件。随后调用 `pnpm tauri:build:dmg`，执行完整前端与 Rust 质量检查、生成当前 Mac 的未签名 DMG 并输出 SHA-256 校验值。全部成功后，仅暂存上述四个版本文件，自动创建 `chore(release): v版本号` Git 提交。

命令不会创建 Git 标签、推送远程或上传产物。检查或打包失败时，版本改动保留在工作区，不自动提交；先用 `git diff` 检查失败状态，修复问题并将四个版本文件恢复到发布前的版本，提交修复后重新执行。若 Git 提交阶段失败，先检查 `git status` 中的暂存内容，再处理 Git 报错。

### 前端构建

```bash
pnpm build
```

构建产物位于 `dist/`，由 Tauri 的 `beforeBuildCommand` 自动调用，无需在原生构建前单独执行。

### 当前平台 Debug 构建

```bash
pnpm exec tauri build --debug
```

该命令用于开发阶段验证当前平台的原生编译和打包链路。

### macOS 自用 DMG

```bash
pnpm tauri:build:dmg
```

该命令会先运行完整检查，再生成当前 Mac 的发行产物并输出 SHA-256 校验值。`--no-sign` 明确跳过 Developer 签名；自用 DMG 位于 `src-tauri/target/release/bundle/dmg/`。双击 DMG，将 `NoteX.app` 拖入“应用程序”文件夹后即可安装。

当前自用版本不签名、不公证，也不上传 App Store。若 macOS 对从外部位置复制的未签名应用显示 Gatekeeper 提示，在 Finder 中按住 Control 点按 `NoteX.app`，选择“打开”并再次确认；不要通过关闭系统安全机制绕过提示。

首次安装后，应在断网状态完成新建、编辑、文本和图片粘贴、分类、标签、搜索、回收站、导出、设置、目录选择、窗口恢复与单实例的本机验收。保留上述 `shasum` 输出，便于确认后续安装的文件未被替换。

## 目录说明

```text
src/                 Vue 页面、布局、状态、服务与样式
src-tauri/src/       Tauri Command、Rust Service、Repository 与数据库代码
src-tauri/migrations/ 只增不改的 SQLite Migration
src-tauri/capabilities/ 最小权限配置
docs/                PRD、技术设计、数据库／IPC 契约与开发计划
tests/               前端单元与组件测试
```

## 数据与文档约定

- 数据库结构以 [docs/DATABASE.md](docs/DATABASE.md) 为准；结构变更必须先更新该文档，再新增 Migration。
- Tauri Command 与前后端 DTO 以 [docs/IPC.md](docs/IPC.md) 为准；Vue 组件不得直接调用 `invoke()`。
- 不得通过删除数据库或临时执行 DDL 代替 Migration；已发布 Migration 不得修改。
- 前端不得读取应用数据目录或执行 SQL；数据库和文件系统仅由 Rust 管理。
