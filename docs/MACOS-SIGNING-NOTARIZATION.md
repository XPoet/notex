# NoteX macOS 正式签名与 Apple 公证完整教程

> 核对日期：2026-10-28。适用范围：NoteX、Tauri 2、GitHub Releases、macOS Apple Silicon DMG。
>
> 本文是接入教程。仓库当前仍使用 ad-hoc 签名；新增本文不会改变现有安装包、Apple 账号、GitHub Secrets 或发布工作流。只有完成配置、发布新版本并通过最终下载验收后，才能对外说明“已签名并公证”。

## 1. 要解决什么问题

目标是让用户从 GitHub Releases 下载新的 DMG，拖入“应用程序”后，可以通过 macOS 默认的来源验证，无需再到“系统设置 → 隐私与安全性”选择“仍要打开”。

需要建立以下发布流程：

```text
有效的 Apple Developer Program 会员资格
  ↓
Developer ID Application 证书与对应私钥
  ↓
构建 NoteX，正式签名并启用 Hardened Runtime
  ↓
提交 Apple 公证，确认 Accepted
  ↓
装订公证票据（staple）
  ↓
验证最终 DMG 与内部 NoteX.app
  ↓
上传 GitHub Release，浏览器下载后再次验收
```

三个概念需要分清：

| 项目              | 作用                                     | 单独完成是否足够               |
| ----------------- | ---------------------------------------- | ------------------------------ |
| Developer ID 签名 | 标识开发者，并验证签名后代码没有被篡改   | 还需要公证                     |
| Apple 公证        | Apple 自动检查提交的软件，并签发公证票据 | 仍须保留有效签名；建议装订票据 |
| Staple / 装订     | 将票据附到分发文件上，支持离线验证       | 不能替代签名或公证             |

正式签名与公证不要求上架 Mac App Store，也不等于通过 App Store 人工审核。正常的首次联网下载确认，例如“这是从互联网下载的应用，是否确定要打开”，仍可能出现；验收目标是通过系统来源验证，不是消除所有系统确认框。依据：[Apple Developer ID](https://developer.apple.com/developer-id/)、[Apple 公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。

## 2. NoteX 当前配置与必须修改的位置

以下结论来自当前仓库源码，不应直接套用其他项目的发布模板。

| 文件                                | 当前状态                                                                      | 实际接入时的处理                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| `package.json`                      | Tauri CLI 固定为 `2.11.4`；应用版本 `0.0.17`                                  | 无需升级依赖                                         |
| `src-tauri/tauri.conf.json`         | `productName: NoteX`、`identifier: cn.xpoet.notex`；没有自定义 `bundle.macOS` | 保持名称、标识符和已有配置；签名身份通过环境变量传入 |
| `.github/workflows/release.yml`     | `Build installers` 为 macOS 强制设置 `APPLE_SIGNING_IDENTITY: '-'`            | 必须替换该步骤；只新增同名 Secret 不会覆盖这个 `'-'` |
| `package.json` 的 `tauri:build:dmg` | 带 `--no-sign`                                                                | 不能用于正式签名验收；本文直接调用 Tauri CLI         |
| `scripts/release.mjs`               | `pnpm release` 修改版本后调用上述无签名脚本，并自动提交                       | 本地验证不执行该命令                                 |
| macOS 验证步骤                      | 验证 DMG、代码签名完整性，并直接启动二进制                                    | 增加正式身份、公证票据与 Gatekeeper 验证             |
| `scripts/github-release.mjs`        | Release 正文写死“ad-hoc、未经公证、仍要打开”                                  | 接入成功时同步更新新版本文案                         |
| [RELEASE.md](./RELEASE.md)          | 安装说明仍描述当前未公证状态                                                  | 新版本验收通过后再更新状态                           |

当前发布矩阵只有 Windows x64 和 macOS Apple Silicon，macOS 使用 GitHub 托管的 `macos-15` runner，目标为 `aarch64-apple-darwin`。本教程保留这个范围。

当前流程为 `main` 推送 → `prepare` 分配版本并创建草稿 → 两个平台构建和上传 → `publish` 公开发布。没有 `workflow_dispatch`，所以当前页面上不提供手动“Run workflow”入口。

### 2.1 本教程为何还要单独公证 DMG

按项目固定的 Tauri CLI `2.11.4` 源码：应用打包流程会对 `.app` 签名，提交公证并装订应用票据；DMG 流程随后生成并签名 DMG，没有单独提交 DMG 公证的步骤。未提供完整公证凭据时，应用打包流程在部分情况下只输出跳过公证的警告，因此不能只看“构建成功”。依据：[应用打包源码](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/app.rs)、[DMG 打包源码](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)、[公证与装订源码](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-macos-sign/src/lib.rs)。

本文保留 Tauri 对内部应用的自动公证，再对最终 DMG 显式公证和装订，分别验收两层产物。这会增加一次 Apple 提交，并非 Apple 要求每一层都重复公证。Apple 的通用建议是公证最外层分发容器；这里增加 DMG 步骤，是为了保留现有 Tauri 行为，同时验证用户实际下载的文件。依据：[Apple 打包与分发说明](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)。

## 3. 开始前准备清单

| 项目                    | 要求 / 用途                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Apple 账号              | 已启用双重认证，用于加入开发者计划                                                 |
| Apple Developer Program | 有效的付费会员，或 Apple 已批准的费用豁免资格                                      |
| 账号权限                | 能由 Account Holder 创建 Developer ID Application 证书；团队密钥由有权限的成员创建 |
| Mac                     | 首次创建 CSR、保存签名私钥、导出证书以及本地验收                                   |
| Xcode                   | 使用支持当前 macOS 的稳定版；公证使用 `notarytool`，不用旧的 `altool` 公证流程     |
| GitHub 仓库管理权限     | 能配置 Actions Secrets，并提交发布工作流修改                                       |
| 安全存储                | 密码管理器 / 加密备份，用于保存 `.p12`、`.p8` 和导出密码                           |
| 测试环境                | 一台未放行过旧版 NoteX 的 Apple Silicon Mac，或干净 macOS 测试环境                 |

Apple Developer Program 官方标准价格为每年 99 美元，或可用地区的当地货币价格；实际金额、税费和支付方式以注册页面为准。公证不要求另买一个“公证证书”。免费开发者账号不满足这里的正式 Developer ID 分发方案。依据：[注册说明](https://developer.apple.com/programs/enroll/)、[会员比较](https://developer.apple.com/support/compare-memberships/)。

### 3.1 个人还是组织

| 类型                | 适合情况                 | 注册重点                                               |
| ------------------- | ------------------------ | ------------------------------------------------------ |
| 个人 / Individual   | 以个人身份维护 NoteX     | 身份核验；Apple 使用个人法定姓名作为相关开发者身份信息 |
| 组织 / Organization | 由公司或其他法人实体发布 | 法人资格、授权代表、组织信息，通常需要 D-U-N-S 编号    |

不要把 GitHub 用户名 `XPoet` 或产品名 `NoteX` 当作证书必然显示的开发者名称。证书身份来自 Apple 核验后的个人或组织信息；最终以实际签发的证书为准。注册类型不会要求把应用名称改成个人姓名。依据：[Apple 注册要求](https://developer.apple.com/programs/enroll/)。

### 3.2 本机工具检查

在终端执行以下只读检查：

```bash
xcode-select --print-path
xcodebuild -version
xcrun --find notarytool
xcrun notarytool --version
xcrun --find stapler
security find-identity -v -p codesigning
```

如果 `xcodebuild` 显示当前只选择了 Command Line Tools，先安装完整 Xcode、启动一次并完成许可及组件安装，再按实际安装位置选择开发目录：

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

该命令只在确实需要切换时由维护者执行；路径对应标准 Xcode 安装位置。Apple 已停止接受 `altool` 公证提交，本文全部使用 `notarytool`。依据：[Apple Developer ID 工具要求](https://developer.apple.com/developer-id/)。

## 4. 注册并确认开发者团队

1. 打开 [Apple Developer Program 注册页](https://developer.apple.com/programs/enroll/)。
2. 使用准备长期维护 NoteX 的 Apple 账号登录，完成双重认证。
3. 根据真实主体选择个人或组织，完成身份与组织核验。
4. 完成会员购买或已获批的费用豁免流程，等待账号显示会员资格有效。
5. 打开 [Apple Developer Account](https://developer.apple.com/account/)，确认当前选择的是发布 NoteX 的团队。
6. 在会员信息中记录 Team ID，并保存到密码管理器的项目记录中。
7. 检查是否存在尚未接受的新开发者协议；由 Account Holder 处理后再配置公证。

后续 `.p12` 签名身份与公证使用的团队必须一致。多团队账号尤其要检查 Team ID，不要只比较登录邮箱。

## 5. 创建 Developer ID Application 证书

### 5.1 先准备仓库外的凭据目录

建议使用本机用户资料目录下的专用目录。以下命令只创建目录，不会生成或打印任何密钥：

```bash
NOTEX_SIGNING_DIR="$HOME/Library/Application Support/NoteXSigning"
mkdir -p "$NOTEX_SIGNING_DIR"
chmod 700 "$NOTEX_SIGNING_DIR"
```

后续文件均保存到这个目录或密码管理器中。当前仓库 `.gitignore` 没有通用的 `.p12`、`.p8`、`.env` 忽略规则；不要将凭据放进仓库，即使计划“稍后再忽略”。Base64 只是编码，不是加密。

### 5.2 在自己的 Mac 上创建 CSR

1. 打开 macOS 的“钥匙串访问 / Keychain Access”。可通过 Spotlight 搜索打开。
2. 从应用菜单选择“证书助理 / Certificate Assistant”→“从证书颁发机构请求证书 / Request a Certificate From a Certificate Authority”。
3. `User Email Address` 填写维护者邮箱。
4. `Common Name` 填写便于识别的名称，例如 `NoteX Developer ID`。
5. `CA Email Address` 留空，选择“存储到磁盘 / Saved to disk”。
6. 将生成的 `.certSigningRequest` 保存到刚才的仓库外目录。

这个过程会在本机钥匙串中创建私钥。CSR 不是私钥，后续下载的 `.cer` 也不包含私钥；不要丢失创建 CSR 的这台 Mac 上的对应私钥。依据：[Apple 创建 CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)。

### 5.3 在 Apple 网站签发证书

1. 由 Account Holder 打开 [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)。
2. 确认团队，进入 Certificates，点击新增证书。
3. 选择 **Developer ID Application**。
4. 上传上一步生成的 CSR，按页面流程生成并下载 `.cer`。
5. 在创建 CSR 的 Mac 上打开 `.cer`，导入登录钥匙串。

本教程使用可导出私钥的手动证书流程。不要选择 `Apple Development`、`Apple Distribution`、`Developer ID Installer` 或 ad-hoc：当前分发的是 `.app` 和 `.dmg`，需要 **Developer ID Application**。`Developer ID Installer` 面向签名 `.pkg` 安装器。依据：[Apple Developer ID 证书说明](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)。

### 5.4 确认证书与私钥配对

在“钥匙串访问”选择登录钥匙串 →“我的证书 / My Certificates”，找到类似条目：

```text
Developer ID Application: 你的姓名或组织名称 (TEAMID)
  对应的私钥
```

展开证书后应能看到对应私钥。终端执行：

```bash
security find-identity -v -p codesigning
```

应能找到有效的 `Developer ID Application: ... (TEAMID)` 身份。完整复制引号内的名称，后面作为 `APPLE_SIGNING_IDENTITY`；不要填写证书下载文件名、GitHub 用户名或单独的 Team ID。

如果输出是 `0 valid identities found`，先修复证书、私钥和信任链，暂不进入构建。只导入别的 Mac 上下载的 `.cer`，无法获得那台 Mac 上的私钥。

### 5.5 导出 CI 需要的 `.p12`

1. 在“我的证书”中选中 Developer ID Application 身份及其对应私钥。
2. 选择导出，格式选择 Personal Information Exchange / `.p12`。
3. 保存到仓库外的凭据目录，例如 `NoteX-Developer-ID.p12`。
4. 设置独立的高强度导出密码，并存入密码管理器。
5. 按 macOS 提示授权导出。

`.p12` 必须包含证书和私钥。无法选择 `.p12` 或看不到私钥时，返回前一步检查，不要把 `.cer` 改后缀代替。钥匙串导出依据：[Apple 导出钥匙串项目](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)。

证书与私钥应有加密备份。失去私钥后，不能从 `.cer`、GitHub Release 或已签名的 NoteX 中恢复私钥。

## 6. 准备 Apple 公证凭据

签名证书与公证凭据是两套材料：`.p12` 用于签名；下面的 `.p8` 或 App 专用密码用于向 Apple 公证服务证明提交者身份，二者不能互换。

### 6.1 推荐：App Store Connect 团队 API Key

1. 打开 [App Store Connect](https://appstoreconnect.apple.com/)，确认团队。
2. 进入 Users and Access / 用户和访问 → Integrations / 集成 → App Store Connect API。
3. 选择 **Team Keys / 团队密钥**，不要选择个人密钥。
4. 如果团队尚未启用 API 访问，由 Account Holder 按页面要求申请访问。
5. 由 Account Holder 或 Admin 创建团队密钥，名称可设为 `NoteX GitHub Notarization`，按 Tauri 指引选择 Developer 权限。
6. 记录 `Issuer ID`，记录新密钥的 `Key ID`。
7. 下载私钥 `AuthKey_<KEY_ID>.p8`，保存到仓库外凭据目录。
8. 完成加密备份后，确认本机文件权限仅允许自己读取。

团队 API Key 的私钥只能下载一次。本文的 `Issuer ID + Key ID + .p8` 组合专指团队 API Key，避免个人 API Key 在不同工具版本中的兼容差异。个人开发者会员也有自己的团队，可以使用团队密钥；会员类型与 API 密钥类型不是同一概念。依据：[Apple 创建 API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)、[Tauri macOS 公证配置](https://v2.tauri.app/distribute/sign/macos/#notarization)。

变量对应关系：

| 环境变量             | 内容                                   | 常见填错方式                      |
| -------------------- | -------------------------------------- | --------------------------------- |
| `APPLE_API_ISSUER`   | 团队 API 页上的 Issuer ID，通常为 UUID | 填成 Team ID                      |
| `APPLE_API_KEY`      | Key ID                                 | 填成 `.p8` 文件内容               |
| `APPLE_API_KEY_PATH` | runner 或本机上 `.p8` 文件的完整路径   | 填成 Base64 或 GitHub Secret 名称 |

API 私钥文件权限示例；将文件名替换为实际下载的文件名：

```bash
chmod 600 "$NOTEX_SIGNING_DIR/AuthKey_实际KEYID.p8"
```

### 6.2 替代方案：Apple 账号 + App 专用密码

如果暂时无法创建团队 API Key，可使用 Tauri 支持的另一组凭据：

| 环境变量         | 内容                              |
| ---------------- | --------------------------------- |
| `APPLE_ID`       | Apple 账号邮箱                    |
| `APPLE_PASSWORD` | 为发布流程创建的 **App 专用密码** |
| `APPLE_TEAM_ID`  | 开发者团队 Team ID                |

App 专用密码在 [Apple 账号页面](https://account.apple.com/) 的“登录与安全性 → App 专用密码”生成，需要启用双重认证。这里不能使用 Apple 账号主密码，也不能使用 `.p12` 导出密码。依据：[Apple App 专用密码](https://support.apple.com/102654)。

本教程后面的可复制流程统一使用团队 API Key。选择 App 专用密码时，需要同时替换 Tauri 构建环境变量，以及手动 `notarytool` 的认证参数；不能只改其中一处，也不要同时配置两种认证后依赖工具的优先级。

## 7. 先在本机完成一次正式构建

### 7.1 设置非明文凭据内容的环境变量

先在当前终端定义以下变量，将示例值替换为自己的证书身份、Issuer ID、Key ID 和私钥路径：

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: 你的姓名或组织名称 (TEAMID)'
export APPLE_API_ISSUER='你的团队API Issuer ID'
export APPLE_API_KEY='你的Key ID'
export APPLE_API_KEY_PATH="$HOME/Library/Application Support/NoteXSigning/AuthKey_你的KeyID.p8"
```

这里没有在命令中填写 `.p8` 内容或密码。不要把这组设置写进仓库的 `.env`、`package.json` 或工作流明文。Tauri 的 `APPLE_SIGNING_IDENTITY` 会覆盖配置文件中的签名身份；`'-'` 表示 ad-hoc，正式构建不能保留这个值。依据：[Tauri 环境变量](https://v2.tauri.app/reference/environment-variables/)。

### 7.2 先验证公证认证

将同一组团队 API 凭据登记到本机钥匙串中的命名配置，供后面的手动 DMG 公证使用：

```bash
xcrun notarytool store-credentials 'notex-notary' \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER"

xcrun notarytool history --keychain-profile 'notex-notary'
```

认证成功但历史为空属于正常情况。401、403 等错误应先按第 11 节排查。这个钥匙串配置供手动命令使用；Tauri 构建仍需要上一节的 `APPLE_API_*` 环境变量。

如果选择 App 专用密码，可改用交互式登记，按提示输入邮箱、Team ID 和 App 专用密码，避免把密码写入终端历史：

```bash
xcrun notarytool store-credentials 'notex-notary'
```

命令认证与钥匙串配置依据：[Apple 自定义公证流程](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)。

### 7.3 检查依赖并构建

在 NoteX 仓库根目录操作。前端依赖尚未安装时，使用现有锁文件安装；不要更新依赖或锁文件：

```bash
pnpm install --frozen-lockfile
```

执行项目要求的检查，再构建 Apple Silicon DMG：

```bash
pnpm check
pnpm exec tauri build --ci --target aarch64-apple-darwin --bundles dmg -- --locked
```

如果本机缺少 Rust 目标，先安装对应标准库：

```bash
rustup target add aarch64-apple-darwin
```

本次不要使用：

- `pnpm tauri:build:dmg`：当前脚本含 `--no-sign`。
- `pnpm release`：会改版本并调用上述脚本，成功后还会创建 Git 提交。
- `--skip-stapling`：会跳过等待公证与装订，不满足本文的发布验收要求。

`--ci` 用于无交互打包，`--locked` 固定 Rust 依赖；命令参数依据：[Tauri CLI](https://v2.tauri.app/reference/cli/#build)。

日志中应能确认：正式身份参与签名、应用公证状态为 `Accepted`、应用完成装订。只有 `Bundling ... dmg` 或进程退出码为 0 不足以证明已经公证。

### 7.4 定位本次产物

由于命令显式传入了 `--target`，产物位于：

```text
src-tauri/target/aarch64-apple-darwin/release/bundle/
  macos/NoteX.app
  dmg/NoteX_<版本号>_aarch64.dmg
```

GitHub 发布脚本上传时会将文件规范命名为 `NoteX_<版本号>_macos_aarch64.dmg`。本机 Tauri 原始文件名与 Release 附件名不同，这是现有脚本的行为。

下面的手动命令从仓库当前版本号组成准确文件名，不使用通配符选择历史产物。执行前确认本次构建成功，且期间没有修改版本号。

### 7.5 公证最终 DMG，并装订票据

在仓库根目录设置准确路径，并确认文件存在：

```bash
NOTEX_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
NOTEX_DMG_PATH="src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/NoteX_${NOTEX_VERSION}_aarch64.dmg"
test -f "$NOTEX_DMG_PATH"
```

只有 `test` 检查通过且已确认该文件来自刚才的成功构建，才继续执行：

```bash
xcrun notarytool submit "$NOTEX_DMG_PATH" \
  --keychain-profile 'notex-notary' \
  --wait \
  --timeout 30m
```

记录 Submission ID。只有明确看到 **`status: Accepted`** 才继续；`In Progress`、超时、`Invalid` 都不能作为发布通过。

```bash
xcrun stapler staple "$NOTEX_DMG_PATH"
xcrun stapler validate "$NOTEX_DMG_PATH"
```

装订会改变 DMG 文件内容，所以 SHA-256 必须在装订完成后计算。不要先生成校验文件，随后再装订或修改 DMG。

Apple 处理时间不是固定值。初次提交或服务繁忙时可能超过本节的等待时间；超时只说明客户端停止等待，服务端可能仍在处理。通过第 11 节的 `info` 查询原 Submission ID，不要立刻反复提交。

## 8. 接入现有 GitHub Actions

本节是建议修改方案，代码片段尚未写入真实工作流。先完成本地验证，再以正常代码评审流程接入。保留现有 prepare、版本分配、Windows 构建、草稿上传和 publish 机制。

### 8.1 配置 8 个 Repository Secrets

打开 [NoteX 仓库](https://github.com/XPoet/notex) → Settings → Secrets and variables → Actions → Repository secrets → New repository secret。

| Secret 名称                  | 填写内容                                      | 来源                             |
| ---------------------------- | --------------------------------------------- | -------------------------------- |
| `APPLE_CERTIFICATE`          | `.p12` 的 Base64，单行                        | 第 5 节导出的证书和私钥          |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` 导出密码                               | 导出时设置                       |
| `APPLE_SIGNING_IDENTITY`     | 完整 `Developer ID Application: ... (TEAMID)` | `security find-identity` 输出    |
| `KEYCHAIN_PASSWORD`          | CI 临时钥匙串的独立随机密码                   | 密码管理器生成，不是本机登录密码 |
| `APPLE_API_ISSUER`           | 团队 Issuer ID                                | App Store Connect                |
| `APPLE_API_KEY`              | 团队 Key ID                                   | App Store Connect                |
| `APPLE_API_KEY_BASE64`       | `.p8` 文件的 Base64，单行                     | 第 6 节下载的团队私钥            |
| `APPLE_TEAM_ID`              | Team ID，用于核对最终签名                     | 开发者会员信息                   |

本教程将 Team ID 额外作为明确的验收期望值。API Key 认证本身使用 Issuer ID，不是通过 `APPLE_TEAM_ID` 认证。

在本机复制 Base64 到剪贴板，不在终端打印文件内容：

```bash
base64 -i "$NOTEX_SIGNING_DIR/NoteX-Developer-ID.p12" | tr -d '\r\n' | pbcopy
```

粘贴到 `APPLE_CERTIFICATE` 并保存，然后准备 API 私钥：

```bash
base64 -i "$NOTEX_SIGNING_DIR/AuthKey_实际KEYID.p8" | tr -d '\r\n' | pbcopy
```

粘贴到 `APPLE_API_KEY_BASE64` 并保存。密码直接从密码管理器填写，不要贴到聊天、Issue 或提交记录。GitHub 单个 Secret 上限为 48 KB；正常只导出一套必要的签名身份即可，不要把整个钥匙串导出。依据：[GitHub Secrets 限制](https://docs.github.com/en/actions/reference/security/secrets)。

本文使用 Repository Secrets。如果改为 Environment Secrets，还需要在 `build` job 声明对应 `environment`，并处理环境访问规则；只在页面创建环境 Secret 并不会自动注入当前 job。Secret 未配置时，工作流表达式会得到空字符串。依据：[GitHub 使用 Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

### 8.2 在构建前导入证书和 API 私钥

在 `.github/workflows/release.yml` 的 `jobs.build.steps` 中，放在 Rust 测试完成之后、原 `Build installers` 之前。以下每个代码块都表示 `steps` 下的步骤列表，粘贴时与现有 `- name:` 对齐；不要复制成新的完整 workflow。

当前项目直接调用 Tauri CLI。这里显式创建临时钥匙串，不依赖其他 Action 自动导入证书；`APPLE_CERTIFICATE` 只提供给导入步骤，不再提供给后面的 Tauri 步骤，避免重复导入。

```yaml
- name: Prepare macOS signing credentials
  if: runner.os == 'macOS'
  shell: bash
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
    APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
    APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
    APPLE_API_KEY_BASE64: ${{ secrets.APPLE_API_KEY_BASE64 }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: |
    set -euo pipefail
    umask 077
    for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY KEYCHAIN_PASSWORD APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_BASE64 APPLE_TEAM_ID; do
      if [ -z "${!name}" ]; then
        echo "::error::Missing required secret: $name"
        exit 1
      fi
    done
    case "$APPLE_SIGNING_IDENTITY" in
      'Developer ID Application: '*) ;;
      *) echo '::error::A Developer ID Application identity is required'; exit 1 ;;
    esac
    case "$APPLE_API_KEY" in
      *[!A-Za-z0-9]*) echo '::error::Invalid API Key ID format'; exit 1 ;;
    esac

    signing_dir="$RUNNER_TEMP/notex-signing"
    mkdir -p "$signing_dir"
    chmod 700 "$signing_dir"
    certificate_path="$signing_dir/developer-id.p12"
    keychain_path="$signing_dir/notex-build.keychain-db"
    api_key_path="$signing_dir/AuthKey_${APPLE_API_KEY}.p8"
    printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$certificate_path"
    printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$api_key_path"
    chmod 600 "$certificate_path" "$api_key_path"

    security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain_path"
    security set-keychain-settings -lut 21600 "$keychain_path"
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain_path"
    security import "$certificate_path" \
      -k "$keychain_path" \
      -P "$APPLE_CERTIFICATE_PASSWORD" \
      -T /usr/bin/codesign
    security set-key-partition-list \
      -S apple-tool:,apple:,codesign: \
      -s -k "$KEYCHAIN_PASSWORD" "$keychain_path" > /dev/null
    security list-keychains -d user -s \
      "$keychain_path" "$HOME/Library/Keychains/login.keychain-db"
    security find-identity -v -p codesigning "$keychain_path" \
      | grep -F -- "\"$APPLE_SIGNING_IDENTITY\"" > /dev/null

    echo "NOTEX_API_KEY_PATH=$api_key_path" >> "$GITHUB_ENV"
```

导入步骤依据：[GitHub 在 macOS runner 安装 Apple 证书](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)。这里仅采用证书及钥匙串部分；当前 NoteX 普通 Developer ID 分发不需要照抄示例中的 iOS provisioning profile。

注意：

- 不启用 `set -x`，不打印 `env`，不输出解码后的证书或私钥。
- 临时文件只放 `$RUNNER_TEMP/notex-signing`，不放入 `src-tauri`，不作为 artifact 上传。
- 本例适用于当前 GitHub 托管 runner，job 结束后整台临时虚拟机销毁。不要原样用于长期存在的 self-hosted runner；后者必须另行设计凭据清理和钥匙串搜索列表恢复。
- 不将私钥或其 Base64 写入 `$GITHUB_ENV`；其中只记录私钥文件路径。

### 8.3 替换原来的 Build installers 步骤

用下面两个步骤替换原 `Build installers`，不保留原来设置 `'-'` 的 `env`：

```yaml
- name: Build Windows installers
  if: runner.os == 'Windows'
  run: pnpm exec tauri build --ci --target ${{ matrix.target }} --bundles ${{ matrix.bundles }} -- --locked

- name: Build signed and notarized macOS installer
  if: runner.os == 'macOS'
  env:
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
    APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
    APPLE_API_KEY_PATH: ${{ env.NOTEX_API_KEY_PATH }}
  run: pnpm exec tauri build --ci --target ${{ matrix.target }} --bundles ${{ matrix.bundles }} -- --locked
```

Windows 步骤保持原构建命令。Apple 凭据只注入 macOS 所需步骤；无需把它们提升到 workflow 全局环境。

Tauri 的 `bundle.macOS.hardenedRuntime` 默认是 `true`。当前项目没有关闭它，无需为了公证额外增加 entitlements 或降低安全能力。不要套用 Electron 或其他运行时的大量 JIT、允许未签名内存、禁用库校验等权限。依据：[Tauri macOS 配置](https://v2.tauri.app/reference/config/#macconfig)。

如果希望在仓库配置中显式表达默认值，可在原 `bundle` 中新增以下字段，保留其余字段；这属于可选说明，不是本文所需前置修改：

```json
{
  "macOS": {
    "hardenedRuntime": true
  }
}
```

不要为了签名修改 `identifier: cn.xpoet.notex`，否则会影响应用身份及数据目录约定。

### 8.4 在上传前公证最终 DMG

放在 macOS 构建步骤之后、macOS 安装验收和 `Upload missing installers to the draft` 之前：

```yaml
- name: Notarize and staple final macOS DMG
  if: runner.os == 'macOS'
  shell: bash
  env:
    APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
    APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
    APPLE_API_KEY_PATH: ${{ env.NOTEX_API_KEY_PATH }}
  run: |
    set -euo pipefail
    shopt -s nullglob
    dmg=(src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg)
    if [ "${#dmg[@]}" -ne 1 ]; then
      echo '::error::Expected exactly one macOS DMG'
      exit 1
    fi
    submission="$RUNNER_TEMP/notex-dmg-submission.json"
    result="$RUNNER_TEMP/notex-dmg-notarization.json"
    xcrun notarytool submit "${dmg[0]}" \
      --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY" \
      --issuer "$APPLE_API_ISSUER" \
      --output-format json > "$submission"
    submission_id="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["id"])' "$submission")"
    echo "DMG notarization ID: $submission_id"
    xcrun notarytool wait "$submission_id" \
      --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY" \
      --issuer "$APPLE_API_ISSUER" \
      --timeout 30m --output-format json > "$result"
    python3 - "$result" <<'PY'
    import json
    import sys

    with open(sys.argv[1], encoding="utf-8") as file:
      result = json.load(file)
    print(f"DMG notarization ID: {result.get('id')}")
    print(f"DMG notarization status: {result.get('status')}")
    if result.get("status") != "Accepted":
      raise SystemExit("DMG notarization was not accepted")
    PY
    xcrun stapler staple "${dmg[0]}"
    xcrun stapler validate "${dmg[0]}"
```

提交与等待分开执行，确保等待超时之前已经在日志中记录 Submission ID；出现失败时，可以查询原提交。只有等待完成并确认 `Accepted` 后才装订。

这一步修改的是本机尚未上传的 DMG。现有发布脚本随后上传最终字节，GitHub 再为其提供 SHA-256，沿用当前 `SHA256SUMS.txt` 机制即可。

### 8.5 加强 macOS 验收

用下面步骤替换原 `Verify macOS installer and app startup`。它继续保留原来的 8 秒启动检查，并增加正式身份、Team ID、两层票据及系统策略评估：

```yaml
- name: Verify macOS installer and app startup
  if: runner.os == 'macOS'
  shell: bash
  env:
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: |
    set -euo pipefail
    shopt -s nullglob
    dmg=(src-tauri/target/${{ matrix.target }}/release/bundle/dmg/*.dmg)
    if [ "${#dmg[@]}" -ne 1 ]; then
      echo '::error::Expected exactly one macOS DMG'
      exit 1
    fi
    hdiutil verify "${dmg[0]}"
    codesign --verify --strict "${dmg[0]}"
    xcrun stapler validate "${dmg[0]}"
    spctl --assess --type open --context context:primary-signature \
      --verbose=4 "${dmg[0]}"

    mountpoint="$RUNNER_TEMP/notex-install"
    mkdir -p "$mountpoint"
    hdiutil attach "${dmg[0]}" -mountpoint "$mountpoint" -nobrowse -readonly
    trap 'hdiutil detach "$mountpoint"' EXIT
    app="$mountpoint/NoteX.app"
    codesign --verify --deep --strict "$app"
    signature_info="$(codesign --display --verbose=4 "$app" 2>&1)"
    printf '%s\n' "$signature_info" | grep -Fx -- "Authority=$APPLE_SIGNING_IDENTITY"
    printf '%s\n' "$signature_info" | grep -Fx -- "TeamIdentifier=$APPLE_TEAM_ID"
    xcrun stapler validate "$app"
    syspolicy_check distribution "$app"
    spctl --assess --type execute --verbose=4 "$app"

    "$app/Contents/MacOS/NoteX" > "$RUNNER_TEMP/notex-startup.log" 2>&1 &
    app_pid=$!
    sleep 8
    if ! kill -0 "$app_pid" 2>/dev/null; then
      cat "$RUNNER_TEMP/notex-startup.log"
      exit 1
    fi
    kill "$app_pid"
    wait "$app_pid" || true
```

`syspolicy_check` 用于当前 macOS 15 runner；旧 macOS 的本地验收见第 9 节。`codesign --verify --deep` 在这里用于验证嵌套代码，不是使用 `codesign --deep --sign` 粗略重签整个应用。诊断命令依据：[Apple 排查分发问题](https://developer.apple.com/forums/thread/706442)。

### 8.6 超时、检查和新版本文案

当前 `build` job 的 `timeout-minutes` 为 60。首次接入可先改为 120，给 Rust 编译、两次公证和安装验收留出等待空间；根据真实 Actions 耗时调整。增加超时不会保证 Apple 在指定时间内处理完毕。

修改工作流时，同步更新 `tests/release-workflow.spec.mjs` 中有意义的发布约束：缺少凭据直接失败、Windows 不依赖 Apple 凭据、公证及验收在上传之前、正式步骤不再设置 ad-hoc 身份。修改公开 Release 文案时同步检查 `tests/github-release.spec.mjs`。不要把所有 YAML 文本逐字快照当作唯一测试。

实际接入后需要同步调整：

- `scripts/github-release.mjs` 的 macOS 安装文案。
- `docs/RELEASE.md` 的 macOS 签名状态，以及“构建不需要 Apple 账号”的适用范围。
- 若变更了本地 `tauri:build:dmg` 脚本，再同步 `README.md` 中对应说明；保留自用无签名脚本时，应继续明确其用途。

新版本可使用以下安装说明，且应保留适用版本边界：

> macOS：下载适用于 Apple Silicon 的 DMG，将 NoteX 拖入“应用程序”。此版本使用 Developer ID Application 正式签名并通过 Apple 公证。首次打开时，如系统显示互联网下载确认，请核对开发者身份后选择“打开”。

只修改新版本的发布说明，不将历史 ad-hoc 版本改写为已公证。

## 9. 发布后的最终验收

### 9.1 必须验收 GitHub 上的最终文件

1. 正常提交并合并工作流修改到 `main`，等待 **Release desktop apps** 完成。
2. 确认正式 Release 出现，版本号、提交、Apple Silicon DMG 和 `SHA256SUMS.txt` 对应同一次发布。
3. 在干净测试环境中，用 Safari 或 Chrome 从正式 Release 下载 DMG；保留浏览器设置的隔离属性。
4. 校验下载文件 SHA-256 与 `SHA256SUMS.txt` 一致。
5. 通过 Finder 打开下载的 DMG，将应用拖入“应用程序”。
6. 从“应用程序”双击启动，而不是直接运行 `.app/Contents/MacOS/NoteX`。
7. 核对首次确认窗口显示的开发者身份，确认无需使用“仍要打开”。
8. 检查新建、保存、重启读取笔记等核心功能。
9. 在另一个干净测试环境中，下载完成后断网，验证已装订的安装包及应用仍能通过安装与启动流程。

不要用已经对旧版本选择过“仍要打开”的本机环境，作为唯一验收证据。不要通过移除 quarantine 属性、全局关闭 Gatekeeper、重新 ad-hoc 签名来制造通过结果。Apple 建议测试真实分发产物，并使用不同于开发机的测试环境。依据：[Apple 测试 Developer ID 软件](https://developer.apple.com/documentation/security/testing-a-notarized-app)、[Apple 打包分发测试](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)。

### 9.2 安装后的命令行复核

在测试机上执行：

```bash
codesign --verify --deep --strict --verbose=2 /Applications/NoteX.app
codesign --display --verbose=4 /Applications/NoteX.app
xcrun stapler validate /Applications/NoteX.app
syspolicy_check distribution /Applications/NoteX.app
spctl --assess --type execute --verbose=4 /Applications/NoteX.app
```

重点检查：

| 检查项                         | 通过标准                                                       |
| ------------------------------ | -------------------------------------------------------------- |
| 代码签名                       | 完整性验证成功                                                 |
| `Authority`                    | `Developer ID Application: ...`，身份符合本次发布者            |
| `TeamIdentifier`               | 与维护者记录的 Team ID 一致                                    |
| `Identifier`                   | `cn.xpoet.notex`                                               |
| `CodeDirectory` 的 flags       | 包含 `runtime`，表示 Hardened Runtime                          |
| `Timestamp`                    | 存在可信时间戳                                                 |
| `stapler validate`             | 票据验证成功                                                   |
| `syspolicy_check distribution` | 通过分发检查                                                   |
| `spctl`                        | 评估通过；通常可见 `accepted`、`source=Notarized Developer ID` |

不同系统版本的输出文本可能不同，判断时结合退出状态和实际诊断，不要只匹配一段展示文案。`syspolicy_check` 从 macOS 14 开始提供；更旧系统上使用 `codesign`、`stapler`、`spctl` 和实际 Finder 启动共同验收。依据：[Apple 分发诊断](https://developer.apple.com/forums/thread/706442)。

### 9.3 下载 DMG 的复核

将下面文件名替换为实际下载版本，再执行：

```bash
NOTEX_DOWNLOADED_DMG="$HOME/Downloads/NoteX_实际版本号_macos_aarch64.dmg"
shasum -a 256 "$NOTEX_DOWNLOADED_DMG"
hdiutil verify "$NOTEX_DOWNLOADED_DMG"
codesign --verify --strict --verbose=2 "$NOTEX_DOWNLOADED_DMG"
xcrun stapler validate "$NOTEX_DOWNLOADED_DMG"
spctl --assess --type open --context context:primary-signature \
  --verbose=4 "$NOTEX_DOWNLOADED_DMG"
```

SHA-256 只能证明文件与公布摘要一致，不能替代开发者签名和 Apple 公证。

## 10. 如何发布第一个正式签名版本

推荐顺序如下：

1. 在 Apple 侧完成会员、证书和团队 API Key 配置。
2. 在本机确认签名身份有效，并完成正式构建、两层票据和启动验收。
3. 在 GitHub 配置完整 Secrets。
4. 提交 CI 接入代码、必要测试和新版本安装说明，通过项目全部检查。
5. 通过正常 PR 合并到 `main`，由现有流程自动递增 patch 并构建新版本。
6. 观察 macOS 签名、公证、票据校验、系统策略评估及两个平台构建结果。
7. 从公开 Release 下载最终 DMG，完成第 9 节验收并记录结果。
8. 对外说明从哪个版本开始完成正式签名和公证，引导旧版本用户下载新版本。

不要手动修改版本号或先运行 `pnpm release`；当前 GitHub 工作流已负责版本递增。

### 10.1 旧版和重跑行为

| 情况                               | 正确处理                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| 已公开的旧 ad-hoc Release          | 保留历史版本，通过新的提交发布新版本；Secrets 不会改变旧附件 |
| 旧草稿已经上传 ad-hoc DMG          | 新代码发布新版本；现有脚本不会覆盖已上传完整附件             |
| 新流程缺少 Secret，尚未上传 DMG    | 配置凭据后按失败原因决定是否重跑；确认该运行已使用新流程     |
| 需要修改代码 / workflow 才能修复   | 提交修复并发布下一个版本；旧运行固定检出旧版本快照           |
| Apple / 网络临时故障，代码无需变化 | 查看原 Submission ID；确认状态后重跑相应失败任务             |
| Release 已公开，但下载链接验证失败 | 该版本可能已公开，先查真实 Release 状态，再修复下载访问问题  |

现有上传逻辑只补传缺失附件，不替换完整附件。已公开版本的重跑只重新验证下载，不会重新构建。不要移动旧标签，也不要让同一版本号对应不同字节的安装包。需要人工处理历史附件时，应单独评估并取得明确授权。

## 11. 常见问题与排查顺序

### 11.1 `0 valid identities found` / 找不到签名身份

按以下顺序检查：

1. 证书类型是否为 Developer ID Application。
2. 证书是否导入了当前用户的登录钥匙串，或 CI 临时钥匙串是否加入搜索列表。
3. 证书下面是否有对应私钥；CI `.p12` 是否确实导出了私钥。
4. 证书有效期、撤销状态与 Apple 中间证书信任链是否正常。
5. `APPLE_SIGNING_IDENTITY` 是否与 `security find-identity` 的完整名称一致。

不要将证书手动设为“始终信任”来掩盖错误信任链，也不要把 `.cer` 改名成 `.p12`。

### 11.2 `errSecInternalComponent` / `User interaction is not allowed`

通常发生在 CI 无法无交互访问私钥时。核对临时钥匙串已解锁、`security import` 使用了正确密码、执行过 `set-key-partition-list`、搜索列表包含该钥匙串，且后续构建使用同一 runner 用户。还要检查 `.p12` 是否真正包含私钥。

不要在日志里打印导出密码排查。先看命令退出状态和安全处理后的错误消息。

### 11.3 公证认证 401 / 403

核对以下对应关系：

- Key ID、Issuer ID、`.p8` 是否来自同一团队密钥。
- 是否错误使用了个人 API Key。
- API Key 是否已撤销，账号成员角色或团队访问是否变化。
- Apple Developer Program 是否有效，Account Holder 是否需要接受新协议。
- 使用 App 专用密码时，是否错误填入主密码、导出密码或其他团队 ID。

先用 `notarytool history` 验证认证，不要在认证未通过时重复完整 Rust 构建。

### 11.4 `Invalid` / 公证拒绝

在本机使用已登记的钥匙串配置读取结果。下面将 `实际SubmissionID` 替换为本次 ID：

```bash
xcrun notarytool info '实际SubmissionID' \
  --keychain-profile 'notex-notary'

xcrun notarytool log '实际SubmissionID' \
  --keychain-profile 'notex-notary'
```

CI 中未创建该钥匙串配置，应使用 API Key 参数：

```bash
xcrun notarytool log '实际SubmissionID' \
  --key "$APPLE_API_KEY_PATH" \
  --key-id "$APPLE_API_KEY" \
  --issuer "$APPLE_API_ISSUER"
```

查看 Apple 返回的具体路径与错误，重点检查：未签名的嵌套二进制、无效签名、缺少 Hardened Runtime、缺少可信时间戳、调试权限 `com.apple.security.get-task-allow` 被设置为 `true`。修复构建配置后重新构建，不要通过关闭验证继续发布。依据：[Apple 常见公证问题](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)。

### 11.5 `In Progress` / 超时

记录 Submission ID，通过 `notarytool info` 或 `history` 查询。客户端超时不等于 Apple 拒绝，也不代表服务端自动取消。如果 Tauri 内部应用公证在打印 ID 前被 job 整体超时终止，可通过 `history` 按提交名称和时间定位。首次提交与新团队可能需要更长处理时间，不承诺“几分钟必过”。

不要在正式发布步骤加入 `--skip-stapling` 来规避等待。确需异步处理时，需要另行设计“等待 Accepted → 装订 → 验收 → 上传”的工作流，不能在提交完成后直接发布。

### 11.6 `stapler` 报找不到票据

确认：

1. 公证状态已经是 Accepted。
2. 装订目标与提交对象一致；不能将应用的提交结果误当作 DMG 已单独通过。
3. 公证后没有重新签名、重建或修改目标文件。
4. Apple 票据服务可访问；存在短暂传播延迟时，保留原产物并稍后重试。

不要在公证通过后修改 `.app/Contents`，再试图复用原票据。

### 11.7 本机能开，浏览器下载却被拦截

先确认下载的是新版本、新 DMG，而不是旧 Release、历史缓存或源码压缩包。比较 SHA-256，并检查最终安装应用的 Authority、TeamIdentifier 和票据。

本机直接运行内部可执行文件、未带浏览器隔离属性的测试副本、已经人工放行过的旧安装，都不能代替最终下载验收。使用干净测试环境重现，再根据 `syspolicy_check` 和 `spctl` 诊断修复。

### 11.8 Apple 公证通过但应用启动崩溃

公证不验证全部业务行为。保留现有 CI 启动检查，查看 crash report 和控制台日志；检查运行时依赖、文件访问、Hardened Runtime 与实际 entitlement 是否匹配。只有错误日志明确指出某项必要能力时，才增加最小权限并重新签名、公证。

### 11.9 Windows job 因 Apple Secret 失败

检查是否误将凭据校验放进所有平台共用的脚本。Apple 凭据准备、公证和票据验收步骤应都有 `if: runner.os == 'macOS'`；Windows 继续使用原命令，不依赖 Apple 会员或钥匙串。

## 12. 证书、私钥与后续维护

### 12.1 每次发布

1. 固定源码快照与依赖锁文件，完成项目检查。
2. 对新构建执行正式签名与公证；不能因版本内容变化少而复用旧票据。
3. 通过票据和系统策略验收，再上传最终文件。
4. 下载公开附件验证 SHA-256，并进行安装启动抽检。
5. 记录版本、源码提交、签名团队、公证 Submission ID 和验收结果。

### 12.2 证书更新和凭据轮换

提前检查证书到期日和会员状态。需要更新签名证书时，创建新身份、加密备份、重新导出 `.p12`，更新 `APPLE_CERTIFICATE`、导出密码和签名身份；在新版本完整验证后切换发布使用。

团队 API Key 没有可重新下载的原私钥；丢失后需要创建替代密钥，并同步更新 Key ID、Issuer ID、`.p8` 与相关 Secrets。不要在验证替代凭据之前随意撤销仍在使用的证书或密钥，以免影响发布或既有软件验证。

发现私钥泄露时，停止继续使用该凭据，按 Apple 的撤销与安全事件流程处理，并更新 GitHub 凭据；不能只修改 GitHub Secret 就认定旧私钥已经失效。证书生命周期依据：[Apple Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)。

### 12.3 发布记录模板

以下模板只记录元数据，不记录任何密码或私钥内容：

```text
版本：v<版本号>
源码提交：<commit SHA>
GitHub Actions：<运行链接>
开发者团队：<Team ID>
签名身份：Developer ID Application: <姓名或组织> (<Team ID>)
应用公证 ID：<Submission ID>
DMG 公证 ID：<Submission ID>
应用与 DMG 票据校验：通过 / 失败
Gatekeeper / syspolicy_check：通过 / 失败
公开下载 SHA-256：<摘要>
测试 macOS / 芯片：<系统版本> / Apple Silicon
浏览器下载后首次启动：通过 / 失败
离线首次安装启动：通过 / 失败
验收日期与维护者：<日期> / <维护者>
```

## 13. 完成标准

只有以下项目全部满足，才算解决正式发行问题：

- Apple Developer Program 有效，正式签名身份与私钥可用。
- 正式 CI 不再设置 `APPLE_SIGNING_IDENTITY: '-'`，也不带 `--no-sign`。
- 凭据缺失时发布失败，不自动降级为 ad-hoc 或跳过公证。
- `.app` 签名身份、Team ID、Hardened Runtime 和可信时间戳正确。
- 应用与最终 DMG 的公证均 Accepted，票据验证通过。
- 系统策略检查和原有 macOS 启动检查通过。
- Windows 构建与安装验收通过。
- GitHub 上传的是装订完成后的文件，SHA-256 与公开下载一致。
- 干净 Mac 从浏览器下载并通过 Finder 安装启动，无需“仍要打开”。
- 新版安装文案与实际状态一致，历史版本状态没有被误改。

## 14. 官方资料

### Apple

- [Apple Developer Program 注册](https://developer.apple.com/programs/enroll/)
- [会员资格比较](https://developer.apple.com/support/compare-memberships/)
- [Developer ID 分发](https://developer.apple.com/developer-id/)
- [创建 CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
- [创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [导入与导出钥匙串项目](https://support.apple.com/guide/keychain-access/import-and-export-keychain-items-kyca35961/mac)
- [创建 App Store Connect API Keys](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [App 专用密码](https://support.apple.com/102654)
- [公证概念与要求](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [自定义公证工作流](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- [打包 Mac 软件并分发](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
- [测试公证后的应用](https://developer.apple.com/documentation/security/testing-a-notarized-app)
- [公证常见问题](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [排查分发问题：Apple DTS](https://developer.apple.com/forums/thread/706442)

### Tauri 2 与 GitHub

- [Tauri macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri 环境变量](https://v2.tauri.app/reference/environment-variables/)
- [Tauri macOS 配置](https://v2.tauri.app/reference/config/#macconfig)
- [Tauri 构建参数](https://v2.tauri.app/reference/cli/#build)
- [GitHub runner 安装 Apple 证书](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
- [GitHub 使用 Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Secrets 限制](https://docs.github.com/en/actions/reference/security/secrets)
