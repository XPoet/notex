# NoteX 发布指南

## 下载安装

打开 本仓库 GitHub Releases 最新版本页面，在下载表或 **Assets** 中选择安装包。首次自动发布成功前，仓库没有可供下载的 Release。

标记为 **Draft** 的版本仍处于构建或校验阶段，不能使用正式下载地址。草稿正文只显示构建状态；三个安装包全部上传并完成校验后，工作流自动公开 Release、生成下载表，并以未登录请求验证表中三个下载链接及 `SHA256SUMS.txt`。只有发布步骤通过后，才能将本次版本作为可下载版本交付。

| 平台                | 文件名                                 | 使用方式                  |
| ------------------- | -------------------------------------- | ------------------------- |
| Windows x64         | `NoteX_<版本号>_windows_x64-setup.exe` | 双击安装，适合一般用户    |
| Windows x64         | `NoteX_<版本号>_windows_x64.msi`       | MSI 安装包，与 EXE 二选一 |
| macOS Apple Silicon | `NoteX_<版本号>_macos_aarch64.dmg`     | 适用于 M 系列芯片的 Mac   |

自动发布不再构建 macOS Intel 安装包；此前已发布的版本不受此配置变更影响。

macOS 打开 DMG 后，将 `NoteX.app` 拖入“应用程序”。当前 macOS 包使用 ad-hoc 签名，未使用 Developer ID 证书，也未经过 Apple 公证；从浏览器下载后仍可能被 Gatekeeper 拦截。确认下载来自本仓库后，在系统设置 → 隐私与安全性中选择“仍要打开”，再确认启动。当前 Windows 包未配置代码签名证书，系统可能显示未知发布者或 SmartScreen 提示；首次安装缺少 WebView2 Runtime 的设备可能需要联网安装该运行环境。

`Source code (zip)` 和 `Source code (tar.gz)` 是 GitHub 自动提供的源码，不是安装包。该发布流程没有接入应用内自动更新，更新时下载并安装新版本。

下载 `SHA256SUMS.txt` 和对应安装包后，可校验文件完整性：

```bash
# macOS：在下载文件所在目录执行
shasum -a 256 NoteX_0.0.11_macos_aarch64.dmg
```

```powershell
# Windows PowerShell：在下载文件所在目录执行
Get-FileHash .\NoteX_0.0.11_windows_x64-setup.exe -Algorithm SHA256
```

将输出与 `SHA256SUMS.txt` 中对应文件的哈希比较，下载其他版本时替换示例版本号。

## 首次启用

1. 如果仓库还没有 `main`，先从引入发布工作流之前的 `develop` 基线创建 `main`，再推送包含本次工作流的 `develop`。保留两者的提交差异，才能发起首次发布 PR。
2. 确认仓库 Settings → Actions → General 允许 GitHub Actions 及工作流使用的 Actions 运行。工作流已在发布相关 job 中声明 `contents: write`；仓库或组织策略也必须允许该权限，并允许发布机器人向 `main` 写入版本提交。
3. 发起本仓库 `develop` → `main` 的 Pull Request 并合并。支持普通合并、Squash 和 Rebase。工作流以该 PR 的 `merge_commit_sha` 为源码基线，只更新四个版本字段，生成用于构建的版本提交；例如当前版本为 `0.0.10`，首次自动发布为 `v0.0.11`。
4. 在 Actions 中查看 **Release desktop apps**。两个构建目标全部成功后，检查 Releases 中的版本、三个安装包及 `SHA256SUMS.txt`，再下载对应平台安装包完成安装和启动验收。

工作流默认使用 GitHub 自动提供的 `GITHUB_TOKEN`。如果 `main` 的分支保护或 Ruleset 限制机器人直接提交，可以为获准写入 `main` 的专用发布机器人配置 `RELEASE_TOKEN` Actions Secret；只有 prepare 阶段使用该可选令牌。令牌需具有仓库 Contents 读写权限，并按仓库策略获得必要的分支规则例外。流程不会自动修改或绕过仓库保护；权限不足时保留草稿并明确报错，配置完成后重跑原工作流即可。

安装包构建不需要 Windows 签名证书或 Apple 账号。当前流程不包含发布者证书签名和 Apple 公证；需要消除系统来源提示时，再单独接入这些凭据。

## 后续发布

日常发布只需要：

1. 在 `develop` 提交并推送开发改动。
2. 合并本仓库 `develop` → `main` 的 PR。
3. 等待 Actions 完成自动版本递增、构建和 GitHub Release 发布。

不需要提前执行 `pnpm release`、手动改版本、创建标签或上传安装包。工作流取本次合并、当前 `main`、已有正式版本标签和 Release 草稿中的最高版本，自动递增一次 patch，并同步四处 NoteX 自身版本：

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` 中 `NoteX` 包

例如 `0.0.10 → 0.0.11 → 0.0.12`。`src-tauri/Cargo.lock` 仅同步 `NoteX` 包自身版本，不升级依赖，也不修改 `pnpm-lock.yaml`。版本提交写入 `main`；`develop` 不要求另行提交版本改动，下一次合并仍会按最高正式版本递增。

本地 `pnpm release` 保留为独立的 Mac 打包命令，不是 GitHub 发版的前置步骤。若手动执行后再合并 PR，自动流程仍会在最高版本基础上再增加一次 patch。

直接推送 `main`、合并其他来源分支、合并 fork 中同名 `develop` 或关闭但未合并的 PR，不会触发发布任务。

## 工作流与失败处理

工作流位于 [release.yml](../.github/workflows/release.yml)，发布校验逻辑位于 [github-release.mjs](../scripts/github-release.mjs)。

1. **prepare** 校验四处正式版本号一致，自动分配 patch 并在草稿中记录原始合并来源，生成只变更版本文件的提交及 `v<版本号>` 标签。创建标签后显式将草稿重新绑定到正式标签，并校验 GitHub 返回结果，避免草稿变为 `untagged-*` 后阻止安装包上传；随后将版本同步回 `main`。若 `main` 已有新的开发提交，同步提交基于最新 `main`，保留其余代码；构建仍固定使用原始合并对应的版本快照。更新分支只允许快进，分支继续前进时重新读取并有限重试。
2. **build** 使用 `pnpm install --frozen-lockfile` 安装依赖，并通过 `--locked` 固定 Rust 依赖。Windows x64 和 macOS Apple Silicon 都执行发布脚本回归测试，覆盖真实工作流入口的 ESM 加载；工作流统一使用 `pathToFileURL()`，支持 Windows 盘符和路径中的特殊字符。Apple Silicon job 运行完整前端检查；两个构建目标分别运行 rustfmt、Clippy、Rust 测试，再构建安装包。macOS 校验并挂载 DMG、验证应用签名并启动应用；Windows 静默安装 EXE 后启动已安装的应用，确认进程持续运行后才上传。任何一个目标失败都保留草稿。
3. **publish** 再次核对版本标签和合并提交，确认三个安装包上传完成、大小大于零且 GitHub 提供 SHA-256 摘要，将摘要写入 `SHA256SUMS.txt`，把草稿状态说明替换为正式下载表并公开 Release，保留自动生成的更新记录。随后逐一检查三个安装包与校验文件的公开链接，跟随重定向并对短暂 HTTP 错误有限重试；任何链接失败则任务失败，重跑已公开版本时只重验下载，不重复上传或发布。最新版由 GitHub 的版本排序规则确定，避免较旧版本稍后完成时覆盖较新版本的 Latest 标记。

发布工作流串行排队，最多保留 100 个等待中的运行，避免多个合并同时分配相同版本。若较新的合并已经分配版本，旧合并的代码已被该版本包含，则跳过迟到的旧事件，避免将旧代码作为更高版本发布。

网络、依赖下载或 runner 临时故障时，在原 Actions 运行中选择 **Re-run failed jobs**；如需重新构建所有平台，选择 **Re-run all jobs**。草稿会保留已分配版本及隐藏的合并来源标记，重跑不会再次递增，即使上次在创建版本标签或同步 `main` 时中断也能继续。不要移除或修改草稿中的隐藏来源标记。

重跑只补传缺失附件，复用已完整上传的安装包，不删除或替换已有附件。若已有附件不完整，流程停止，修复后通过新的 PR 自动发布下一版本。已公开发布的同一次合并会跳过递增、构建及上传；旧版本重跑不会降低 `main` 的版本。

需要修改代码或工作流才能修复的失败，应在 `develop` 修复并合并新的 PR，由工作流自动分配下一版本。不要移动旧版本标签，也不要使用同一版本号发布不同提交。旧失败草稿和标签保留供排查，流程不会自动清理它们。

首次启用后的验收需要以真实 GitHub Actions 运行和下载产物为准：本机测试不能替代 Windows 和 macOS Apple Silicon 的远程构建及最终安装验收。

## 参考

- [Tauri GitHub Actions 发布指南](https://v2.tauri.app/distribute/pipelines/github/)
- [Tauri 构建命令](https://v2.tauri.app/reference/cli/#build)
- [macOS 签名与 ad-hoc 签名](https://v2.tauri.app/distribute/sign/macos/)
- [GitHub PR 合并事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-workflow-when-a-pull-request-merges)
- [GitHub Release Asset API 与摘要](https://docs.github.com/en/rest/releases/assets)
- [GitHub Actions 并发队列](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
