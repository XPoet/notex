# NoteX IPC 契约

> 契约版本：V010
> 最后更新：2026-10-28

## 1. 通用规则

- Vue 组件只能调用 TypeScript Service；Service 统一封装 Tauri `invoke`。
- Command 仅负责参数反序列化、线程调度和 Service 调用；不得接收前端提供的数据库路径或任意文件路径。`export_notes.targetDirectory` 是唯一例外：前端 Service 只传递系统目录选择器的结果，Rust 仍不信任该值，必须将其规范化并验证为已存在的本地目录。
- 失败以稳定错误码返回，前端仅展示安全诊断信息，不显示 SQL、系统绝对路径或笔记内容。
- Rust 在应用 Command 的统一入口校验解锁状态。新进程默认锁定，仅放行 `get_access_status`、`unlock_app`、`show_main_window` 和 `exit_application`；其他接口（包括初始化、设置、图片、搜索、导入和导出）在解锁前统一返回 `APP_LOCKED`。

## 2. `bootstrap_app`

### 请求

无参数。

### 成功响应：`BootstrapSnapshot`

| 字段            | 类型      | 说明                                            |
| --------------- | --------- | ----------------------------------------------- |
| `status`        | `'ready'` | 初始化成功时固定为 `ready`                      |
| `schemaVersion` | number    | 最后成功执行的 Migration 版本；当前 V003 为 `3` |

### 失败响应：`BootstrapError`

| 字段      | 类型                                                                                                                                                                             | 说明                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `code`    | `DATA_DIRECTORY_UNAVAILABLE` ｜ `DATA_DIRECTORY_NOT_WRITABLE` ｜ `DATABASE_OPEN_FAILED` ｜ `DATABASE_LOCKED` ｜ `DATABASE_CORRUPTED` ｜ `MIGRATION_FAILED` ｜ `BOOTSTRAP_FAILED` | 稳定错误码                                     |
| `message` | string                                                                                                                                                                           | 面向用户的安全提示，不包含正文、SQL 或内部路径 |

### 行为

1. Command 在阻塞线程执行目录创建、可写性检查、数据库连接和 Migration。
2. 首次启动创建 `database`、`assets`、`temp`、`logs`、`config` 和 `database/notex.db`。
3. 重复启动幂等执行；已成功执行的 Migration 不重复运行。
4. 若存在此前正常保存失败而落盘的恢复草稿，启动会在同一数据库事务内恢复标题和正文、删除对应草稿，再重建搜索索引；恢复失败时停止后续写入，绝不丢弃草稿。
5. 任一步失败时前端进入只读诊断页，停止后续写入调用。
6. 启动响应不得返回应用数据目录、数据库、资源或日志的绝对路径；设置页只能通过 `open_data_directory` 请求后端受控打开固定目录。

### 2.1 `show_main_window`

无参数，成功返回空值。

前端在启动解锁页、诊断页或工作区的首帧 UI 已绘制后，通过 TypeScript Window Service 调用。Command 只操作固定标签为 `main` 的应用窗口，显示并聚焦该窗口；不接收窗口标签、路径或其他前端参数。原生窗口创建时使用与启动面板一致的暖色背景，避免页面资源尚未加载时暴露系统白底。失败复用 `BootstrapError` 的安全错误码和提示。

### 2.2 应用关闭与 `exit_application`

原生层拦截窗口 `CloseRequested` 和应用 `ExitRequested`，向固定 `main` 窗口发送无载荷事件 `notex-exit-requested`。Vue 应用根部通过 Window Service 注册监听，所有路由共用同一关闭流程，不依赖工作台是否挂载。

前端串行保存当前草稿，保存期间若有新的编辑则继续保存最新版本；保存失败时阻止关闭并展示重试提示。保存成功后调用 `exit_application`，无参数，成功返回空值，窗口操作失败复用 `BootstrapError`。重复关闭请求不会启动多份备份。

Command 委托 Shutdown Service 隐藏主窗口；尚未解锁时直接退出，不读取笔记或创建备份。已解锁时等待后台阻塞任务：Backup Service 通过 Export Repository 在同一数据库事务中读取所有未删除笔记、分类层级和关联图片，生成应用数据目录内固定的 `backups/NoteX-latest.zip`。本功能不接受前端路径，也不受手动导出默认目录或当前筛选条件影响。

ZIP 内按分类层级保存 Markdown，未分类笔记放入“未分类”目录；图片集中保存在 `assets` 并改写相对引用。分类和笔记重名时沿用手动导出的文件名清理、冲突编号规则。回收站、标签、应用设置和数据库文件不参与本次 Markdown 导出。

已开启密码时，所有 Markdown 和图片条目以同一开启密码进行 AES-256 ZIP 加密；未开启时使用普通 ZIP。空笔记库在加密模式下写入一个同样加密的 `NoteX-backup.txt` 说明条目，确保空库备份也需要密码。ZIP 文件名不加密，解压工具须支持 AES ZIP。

Security Service 在会话锁与数据库写锁内重新读取密码配置，验证内存中的备份密码仍匹配当前哈希，再委托 Backup Service 生成 ZIP；已配置密码但缺少有效会话密码时停止备份，不能回退为无密码压缩包。密码配置和退出备份共用锁，防止并发执行时产生不一致的密码。

后台直接流式写入同目录 `NoteX-latest.zip.part`，完成 ZIP 尾部写入并同步文件后，将旧备份暂移到 `NoteX-latest.zip.rollback`，发布新的 `NoteX-latest.zip`，成功后清理回滚文件。正常结束只保留一份 ZIP；任务失败时回滚上一份完整 ZIP，清理本次中间文件，不弹出导出进度或错误提示，随后退出进程。后台任务结束前持续拦截重复退出，结束后才允许进程退出。启动未完成或数据库不可用时不得创建空库覆盖旧备份；强制结束、崩溃和断电不在关闭事件保证范围内。

## 3. 前端状态

`app` Pinia Store 管理 `idle`、`loading`、`locked`、`ready`、`failed` 五种启动状态。先读取开启密码状态：配置密码且尚未解锁时仅渲染解锁页，不初始化笔记工作区或读取完整设置；解锁后先完成 `bootstrap_app`，再加载设置，最后切换为 `ready`。无密码时沿相同顺序直接初始化。配置读取失败进入诊断页，不能回退到免密码启动。只有 `ready` 才渲染路由；设置 Store 的临时加载状态不得切换回启动遮罩。当前接口不提供修改或迁移数据目录的能力。

### 3.1 开启密码接口

- `get_access_status`：无参数，返回 `AccessSnapshot { passwordEnabled: boolean, locked: boolean }`。Rust 只读设置表中的密码哈希，不读取笔记、不运行 Migration、不创建数据库。首次启动数据库不存在时返回未配置密码并允许初始化；数据库或已保存哈希损坏时拒绝进入工作区。
- `unlock_app`：请求 `{ password: string }`，在阻塞线程使用 Argon2id 校验密码，成功返回已解锁的 `AccessSnapshot`。密码原样校验，保留首尾空格和 Unicode；失败保持锁定。已保存的旧密码仍支持最多 128 个字符的验证，避免新密码长度限制导致无法解锁或修改密码。验证成功后同步已有无密码的旧版自动备份；同步失败返回安全错误并保持锁定。解锁状态和备份所需密码仅保存在当前进程内存，新进程默认重新锁定。
- `configure_startup_password`：请求 `{ request: { currentPassword?: string, newPassword: string | null } }`，仅允许已解锁会话调用。未设置密码时可直接设置；修改和关闭已配置密码都必须先验证当前密码。`newPassword: null` 表示关闭；字符串必须为 4～20 个 Unicode 字符且不能全部为空白。已经存在的自动备份会保留内容、以流式读取方式重新压缩为使用新密码或无密码的 ZIP，不借此用当前数据库覆盖原备份。没有备份时只更新配置，退出时按新配置创建。成功只返回 `AccessSnapshot`，设置立即持久化，下次启动按新配置校验。

密码仅以随机盐的 Argon2id PHC 哈希保存在 `app_settings.startup_password_hash`。用于 ZIP 加密的密码只在解锁后的 Rust 会话内存中保留，替换、关闭密码或进程结束时通过 `zeroize` 清理；解锁参数和配置请求也在处理完成后清理。密码和哈希不返回前端、不写日志、不进入 Markdown 或关闭备份。密码计算与文件操作在阻塞线程执行；统一入口只读取原子解锁标记，不等待密码计算。连续输错 5 次后，该进程的解锁及密码变更共用 30 秒冷却；读取状态不能重置失败计数。软件不提供忘记密码找回入口。

配置更新先在数据库事务内暂存密码哈希，生成新的 ZIP 并发布后才提交事务，最后清理回滚文件；压缩、发布或提交失败时恢复原配置和原备份，返回 `PASSWORD_BACKUP_SYNC_FAILED` 或 `PASSWORD_SAVE_FAILED`。异常中断留下回滚文件时，根据当前已验证的密码配置检查新旧 ZIP，保留与已提交配置匹配的一份并清理临时文件；无法验证时保留恢复文件并返回同步错误。

安全边界：此功能控制应用启动访问并加密自动备份的文件内容，不加密 SQLite、原始图片或手动导出；有权访问应用数据文件的人仍可直接读取或修改这些文件。

错误码：`APP_LOCKED` ｜ `PASSWORD_INCORRECT` ｜ `PASSWORD_VALIDATION_FAILED` ｜ `PASSWORD_READ_FAILED` ｜ `PASSWORD_SAVE_FAILED` ｜ `PASSWORD_BACKUP_SYNC_FAILED` ｜ `PASSWORD_TOO_MANY_ATTEMPTS`。错误只包含稳定码和安全提示，不包含密码、哈希、SQL 或系统路径。

## 4. 笔记接口

所有笔记接口只作用于未删除笔记。Command 在阻塞线程执行，前端不得传入数据库路径、分类路径或排序 SQL。

### `create_note`

无参数。创建一条空白笔记并返回完整详情；新建成功后前端立即聚焦标题输入框。

### `list_notes`

无参数。读取本地 `note_sort` 设置后返回未删除笔记的 `NoteSummary[]`；`is_pinned DESC` 始终优先，再按设置映射的 `updated_at DESC`、`created_at DESC` 或 `title COLLATE NOCASE ASC`、`id DESC` 排序。前端不得传入排序字段或 SQL。

| 字段             | 类型     | 说明                                               |
| ---------------- | -------- | -------------------------------------------------- |
| `id`             | string   | 笔记 UUID                                          |
| `title`          | string   | 原始标题；空标题由前端展示层回退                   |
| `contentPreview` | string   | 正文归一化后的前 160 个字符，不含 HTML             |
| `tagNames`       | string[] | 笔记当前关联的标签名，按名称排序；未关联时为空数组 |
| `isPinned`       | boolean  | 是否置顶；用于列表项展示置顶标识                   |
| `createdAt`      | string   | UTC RFC 3339                                       |
| `updatedAt`      | string   | UTC RFC 3339                                       |

### `get_note`

请求：`{ id: string }`。成功返回 `NoteDetail`：`id`、`title`、`content`、`createdAt`、`updatedAt`。不存在或已删除时返回 `NOTE_NOT_FOUND`。

### `save_note`

请求：`{ id: string, title: string, content: string }`。在一个数据库事务内更新标题、正文、`updated_at` 和该笔记的全文索引；若该笔记存在恢复草稿则一并删除。成功返回更新后的 `NoteDetail`。标题与正文最大长度由 Rust 限制，前端不可绕过。

### `cleanup_empty_note`

请求：`{ id: string }`。仅当笔记标题和正文均为空白、没有关联资源且未删除时删除临时笔记；其他情况保持幂等且不修改数据。前端在切换笔记前调用。

### `save_recovery_draft`

请求：`{ id: string, title: string, content: string, failureCode: string }`。仅在正常保存失败后调用，以 UPSERT 方式写入 `recovery_drafts`；失败不会覆盖前端内存草稿。下一次成功启动会以事务恢复该草稿。该接口不记录正文到日志。

### 笔记错误码

`NOTE_NOT_FOUND` ｜ `NOTE_VALIDATION_FAILED` ｜ `NOTE_LIST_FAILED` ｜ `NOTE_SAVE_FAILED` ｜ `RECOVERY_DRAFT_SAVE_FAILED`

### `set_note_pinned`

请求：`{ id: string, pinned: boolean }`。只作用于未删除笔记；在数据库事务内更新 `is_pinned` 与 `updated_at`，成功后返回更新后的 `NoteDetail`。重复设置相同状态保持幂等。错误码复用笔记错误码。

## 5. 图片资源接口

### `save_pasted_image`

请求：`{ noteId: string, bytes: number[] }`。前端只能在编辑器的用户粘贴事件中读取剪贴板文件或系统位图后调用，不传入文件路径、扩展名、MIME 或哈希。

Rust 必须根据字节文件头识别 PNG、JPEG、WebP 或 GIF，并以受限内存和尺寸的完整解码校验可读性和尺寸；不信任前端类型。原始文件字节可用时直接保存；只有系统仅提供 RGBA 位图时，前端无损编码为 PNG 再请求本接口。服务端以 SHA-256 去重、临时文件加同步和原子移动写入 `assets/{asset-id}.{extension}`，再以事务创建或复用资源记录和笔记关联。任一步失败时不插入 Markdown，也不保留临时或孤立文件。

成功响应：`SavedAsset`。

| 字段           | 类型   | 说明                                                 |
| -------------- | ------ | ---------------------------------------------------- |
| `id`           | string | 稳定资源 UUID                                        |
| `relativePath` | string | 固定为 `assets/{asset-id}.{extension}`，不含绝对路径 |
| `mimeType`     | string | 由 Rust 检测出的真实类型                             |
| `width`        | number | 图片宽度                                             |
| `height`       | number | 图片高度                                             |
| `size`         | number | 实际字节数                                           |

前端使用返回值插入 `![图片](./assets/{asset-id}.{extension})`，随后触发自动保存。文件达到或超过 10 MiB 时，必须在调用前显示实际大小并允许用户继续或取消；取消时不得调用原生接口。

### `get_note_asset_health`

请求：`{ noteId: string }`。返回 `AssetHealth { missingAssetCount: number }`。仅返回缺失数量，不向前端公开文件系统路径；大于零时编辑区显示资源缺失提示，原 Markdown 引用保持不变。

### `read_note_image`

请求：`{ noteId: string, relativePath: string }`。仅接受当前未删除笔记已关联的 `assets/{file-name}` 资源。Rust 在阻塞线程中验证数据库关联、受控相对路径和规范化后的资源目录范围，拒绝越界路径及指向目录外的符号链接，并校验文件头为支持的图片格式。成功通过 `tauri::ipc::Response` 返回原始图片字节，不公开本机绝对路径。前端收到的数据由 IPC 通道决定：macOS 的 postMessage 通道返回数字数组，其他通道可返回 `ArrayBuffer`；Service 必须先将数字数组转换为 `Uint8Array`，再创建 Blob，以保留原始图片字节。

前端 Service 将字节转换为 Blob URL。CodeMirror 在正文的本地 Markdown 图片引用所在行直接显示图片，随正文一起滚动；点击可放大、缩放、旋转和切换图片，Esc 关闭。切换笔记、移除图片引用或组件卸载时释放 Blob URL；读取失败显示“图片无法读取”，保留正文引用。CSP 仅为图片增加 `blob:` 来源，不开放通用文件系统权限。

### 图片错误码

`ASSET_NOTE_NOT_FOUND` ｜ `INVALID_IMAGE_DATA` ｜ `UNSUPPORTED_IMAGE_FORMAT` ｜ `IMAGE_DIMENSIONS_INVALID` ｜ `ASSET_STORAGE_UNAVAILABLE` ｜ `ASSET_WRITE_FAILED` ｜ `ASSET_SAVE_FAILED` ｜ `ASSET_READ_FAILED`

## 6. 回收站接口

### `trash_note`、`list_trashed_notes`、`restore_note`

- `trash_note` 请求：`{ id: string }`，成功返回空值。删除前由前端 flush 当前草稿；普通删除只进入回收站。
- `list_trashed_notes` 无参数，返回 `TrashedNoteSummary[]`：`id`、`title`、`contentPreview`、`deletedAt`、`trashedFromCategoryPath`。
- `restore_note` 请求：`{ id: string }`，成功返回恢复后的 `NoteDetail`。原分类不存在时返回未分类，前端依据 `restoredToUncategorized` 显示提示。

### `permanently_delete_note`、`empty_trash`

- `permanently_delete_note` 请求：`{ id: string }`；`empty_trash` 无参数。两者均在前端二次确认后调用，成功返回 `TrashCleanupResult { deletedNoteCount, pendingFileCleanupCount }`。
- 文件清理失败不会撤销已完成的永久删除；`pendingFileCleanupCount` 大于零时前端显示可安全重试的提示，不暴露路径。

### 回收站错误码

`TRASH_NOTE_NOT_FOUND` ｜ `TRASH_OPERATION_FAILED`

## 7. 分类接口

`list_categories` 返回嵌套 `CategoryNode[]`（含 `path`、`noteCount`、`children`）；`create_category` 请求 `{ name, parentId? }`；`rename_category` 请求 `{ id, name }`；`move_category` 请求 `{ id, parentId?, orderedIds }`；`get_category_delete_impact` 请求 `{ id }`；`delete_category` 请求 `{ id, mode: 'current' | 'branch' }`。分类筛选通过 `list_notes_by_category` 请求 `{ categoryId? }`，省略 `categoryId` 表示未分类。

分类 Command 不接收层级、路径或 SQL。错误码：`CATEGORY_NOT_FOUND` ｜ `CATEGORY_VALIDATION_FAILED` ｜ `CATEGORY_DUPLICATE_NAME` ｜ `CATEGORY_MAX_DEPTH_EXCEEDED` ｜ `CATEGORY_CYCLE_DETECTED` ｜ `CATEGORY_OPERATION_FAILED`。

## 8. 标签接口

`list_tags` 返回 `TagSummary[]`；`create_tag` 请求 `{ name }`；`rename_tag` 请求 `{ id, name }`，当目标名称已存在时返回 `TagMergePreview`；`merge_tag` 请求 `{ sourceId, targetId }`；`delete_tag` 请求 `{ id }`；`set_note_tags` 请求 `{ noteId, tagIds }`；`list_notes_by_tags` 请求 `{ tagIds }`。服务端忽略重复标签 ID，仅执行 AND 筛选。

标签错误码：`TAG_NOT_FOUND` ｜ `TAG_VALIDATION_FAILED` ｜ `TAG_DUPLICATE_NAME` ｜ `TAG_OPERATION_FAILED`。

## 9. 关闭与保存行为

前端自动保存防抖为 1 秒；连续输入期间不得每键调用 `save_note`。切换笔记、立即保存快捷键和窗口关闭请求前必须执行当前笔记的串行 flush。保存失败时保留内存草稿，尝试写入 `recovery_drafts`，并阻止窗口关闭、展示重试入口；不得静默丢弃内容。

## 10. 全局搜索接口

### `search_notes`

请求：`{ query: string, offset?: number, limit?: number }`。

- `query` 去除首尾空格后必须为 1～200 个字符，最多 12 个空格分隔关键词；多个关键词使用 AND。
- `offset` 默认 `0`，范围 `0～10000`；`limit` 默认 `30`，范围 `1～100`。二者仅用于稳定分页，不接受前端排序字段。
- 服务端以同一分词规则搜索标题、正文、完整分类路径和标签名，忽略英文大小写，统一排除回收站笔记；不返回命中位置或高亮 HTML。

成功响应：`SearchPage`。

| 字段         | 类型             | 说明                            |
| ------------ | ---------------- | ------------------------------- |
| `items`      | `SearchResult[]` | 当前分页的搜索结果              |
| `total`      | number           | 查询快照中的匹配总数            |
| `nextOffset` | number ｜ `null` | 下一页偏移；无下一页时为 `null` |

`SearchResult` 包含 `id`、`title`、`contentPreview`、`categoryPath?`、`tagNames`、`updatedAt`。结果按相关度、`updatedAt DESC`、`id DESC` 排序；分类和标签仅作展示和索引字段，前端不得根据它们重新筛选或排序。

### `rebuild_search_index`

无参数。仅在用户主动从搜索错误状态恢复时调用；Rust 在阻塞线程内从原始 `notes`、`categories` 和 `tags` 重建 FTS5 索引。成功返回空值，不返回索引内容、数据库路径或笔记正文。

### 搜索错误码

`SEARCH_VALIDATION_FAILED` ｜ `SEARCH_QUERY_FAILED` ｜ `SEARCH_INDEX_REBUILD_FAILED`

## 11. 设置接口

### `get_settings`

无参数。返回 `SettingsSnapshot`：

| 字段                              | 类型                                    | 说明                                               |
| --------------------------------- | --------------------------------------- | -------------------------------------------------- |
| `theme`                           | `'light' ｜ 'dark' ｜ 'system'`         | 默认 `system`；前端在启动前据此设置根元素属性      |
| `noteSort`                        | `'updatedAt' ｜ 'createdAt' ｜ 'title'` | 默认 `updatedAt`                                   |
| `editorFontSize`                  | `14 ｜ 15 ｜ 16 ｜ 17 ｜ 18`            | 默认 `15`，单位为 px                               |
| `showCategoryCounts`              | boolean                                 | 默认 `true`；保留兼容，侧栏不再显示数量            |
| `dataDirectory`                   | string                                  | 系统应用数据目录的绝对路径，仅供设置页只读展示     |
| `defaultExportDirectory`          | string                                  | 当前有效的默认导出目录绝对路径；未配置时为桌面目录 |
| `hasCustomDefaultExportDirectory` | boolean                                 | 是否已保存用户选择的默认导出目录                   |
| `appVersion`                      | string                                  | 由应用包版本读取                                   |
| `schemaVersion`                   | number                                  | 最后成功 Migration 版本                            |

### `save_settings`

请求：`{ theme, noteSort, editorFontSize, showCategoryCounts, defaultExportDirectory? }`。所有非路径值必须是上述枚举或范围内的值；`defaultExportDirectory` 只能来自系统目录选择器，Rust 规范化、验证存在和可写后保存。省略该字段时保留当前默认导出目录，传入 `null` 时清除并回退到桌面目录。成功返回完整 `SettingsSnapshot`；其中数据目录和当前有效的默认导出目录绝对路径仅用于设置页只读展示及导出默认值，前端不得将它们拼接为任意文件访问请求。

### `open_data_directory`

无参数。后端使用 Tauri 系统应用数据目录并受控调用 opener；不接收任意路径。成功返回空值。

### 设置错误码

`SETTINGS_VALIDATION_FAILED` ｜ `SETTINGS_READ_FAILED` ｜ `SETTINGS_SAVE_FAILED` ｜ `SETTINGS_DIRECTORY_UNAVAILABLE` ｜ `SETTINGS_DIRECTORY_NOT_WRITABLE` ｜ `SETTINGS_OPEN_FAILED`

## 12. Markdown 导出接口

### 目录选择与安全边界

前端通过 Tauri `dialog` 插件选择已存在的目标目录；取消选择时不得发起导出。前端 Service 仅将该选择结果传入 `export_notes`，Rust 仍会验证路径为已规范化的本地目录、拒绝文件和相对路径，并且绝不将目标目录的绝对路径返回给前端。

每次导出会在目标目录中创建一个不覆盖已有文件的 `NoteX 导出-YYYYMMDD-HHmmss` 子目录。结果只返回安全的目录显示名；前端只能使用本次任务的 `jobId` 调用 `open_export_directory`，由 Rust 从受控任务记录中打开目录，不能自行传入路径。

### `export_notes`

请求：`{ jobId, scope, targetDirectory, onProgress }`。

| 字段              | 类型                                                               | 说明                                                            |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| `jobId`           | string                                                             | 前端生成的 UUID；一次导出任务的唯一标识                         |
| `scope.kind`      | `'note'` ｜ `'category'` ｜ `'categoryWithDescendants'` ｜ `'tag'` | 当前笔记、仅当前分类、分类含全部子分类或单个标签                |
| `scope.id`        | string                                                             | 笔记、分类或标签 UUID；Rust 重新校验实体存在性与可导出状态      |
| `targetDirectory` | string                                                             | 仅由目录选择器提供；Rust 规范化并验证为本地目录，响应中绝不回传 |
| `onProgress`      | Tauri `Channel<ExportProgress>`                                    | 每个已处理笔记发送一次，不携带绝对路径或正文                    |

`ExportProgress` 包含 `total`、`processed`、`succeeded`、`failed`、`currentTitle?`。进度以创建任务时的数据库快照为准；回收站笔记永不参与导出。同一笔记和同一资源在单次任务中至多处理一次。

工作台导出弹窗提供“当前笔记”和“当前分类”。“当前分类”使用当前笔记的分类 ID，导出该分类的全部直属笔记，不含子分类，也不受工作台列表筛选条件限制。未分类笔记使用 `{ kind: 'category', id: 'uncategorized' }`，Rust 将其解析为 `category_id IS NULL`；该保留值仅用于 `category` 范围。导出前先保存当前草稿，保存失败时阻止打开导出弹窗。

成功响应：`ExportResult`。

| 字段             | 类型            | 说明                                      |
| ---------------- | --------------- | ----------------------------------------- |
| `jobId`          | string          | 可用于取消或受控打开本次导出目录          |
| `directoryLabel` | string          | 已创建导出目录的显示名，不含绝对路径      |
| `exportedCount`  | number          | 成功写入的 Markdown 数量                  |
| `failedCount`    | number          | 未写入的笔记数量                          |
| `cancelled`      | boolean         | 用户请求取消后为 `true`；此前成功内容保留 |
| `issues`         | `ExportIssue[]` | 缺失资源或单篇导出失败的安全摘要          |

`ExportIssue` 包含 `noteId?`、`title`、`code`、`message`，不包含系统错误文本、源文件路径或笔记正文。单篇因路径或写入失败时记为失败并继续下一篇；资源缺失仅记录问题，Markdown 仍按导出后的相对路径写入。

### `cancel_export`

请求：`{ jobId }`。仅标记正在运行的受控任务取消；服务会在下一篇笔记开始前停止后续写入，已成功内容不回滚。任务不存在、已完成或 UUID 无效时返回稳定校验错误。

### `open_export_directory`

请求：`{ jobId }`。仅允许打开本进程已成功登记的导出目录，服务端调用受控 `opener` 插件；不接收前端路径。成功返回空值。

### 导出错误码

`EXPORT_VALIDATION_FAILED` ｜ `EXPORT_SCOPE_NOT_FOUND` ｜ `EXPORT_TARGET_UNAVAILABLE` ｜ `EXPORT_SNAPSHOT_FAILED` ｜ `EXPORT_WRITE_FAILED` ｜ `EXPORT_PROGRESS_UNAVAILABLE` ｜ `EXPORT_TASK_NOT_FOUND` ｜ `EXPORT_OPEN_FAILED`

## 13. 笔记导入接口

### `import_note`

请求：`{ fileName: string, bytes: number[] }`。成功返回完整 `NoteDetail`。

导入页 `/imports` 复用管理页布局，支持文件选择和拖入、多文件清单、逐篇进度、成功后查看以及失败项重试。每批最多 100 个文件，由前端串行调用；单篇失败不阻断后续文件，重试只处理失败项，已成功项不会重复导入。切换页面会保留当前会话清单；重启后不保留清单。

文件由用户通过浏览器文件选择控件或拖入显式提供。前端 Service 读取原始字节，不能传入本机路径，Rust 也不读取前端指定的外部文件。无需新增文件系统权限或 Capability。前后端均限制单文件不超过 10 MiB，Rust 重新校验文件名不含路径分隔符和控制字符、扩展名为 `.md` 或 `.txt`（忽略大小写），不信任 MIME 类型。

Rust 支持 UTF-8（含可选 BOM）以及带 BOM 的 UTF-16 LE / BE，严格拒绝无效编码、NUL 和非文本控制字符，不以替换字符静默修复。其他编码需先转换。正文保留原有文本与换行；不解析 Markdown 标题、分类或标签，也不读取 Markdown 引用的图片或其他文件。

笔记名使用去掉最后一个扩展名的文件名，不得为空白，沿用笔记的 4,000 字符标题和 4,000,000 字符正文限制。每次调用生成新 UUID，允许同名笔记；分类固定为 `NULL`（未分类），不置顶。Command 在阻塞线程委托 Import Service 校验与解码，再由 Notes Repository 在同一事务内插入完整笔记和搜索索引；失败时不留下空白或部分笔记。整个流程不修改源文件，不需要数据库结构变更。

### 导入错误码

`IMPORT_VALIDATION_FAILED` ｜ `IMPORT_UNSUPPORTED_FORMAT` ｜ `IMPORT_FILE_TOO_LARGE` ｜ `IMPORT_INVALID_ENCODING` ｜ `IMPORT_SAVE_FAILED`。前端文件读取失败使用 `IMPORT_READ_FAILED`。界面仅展示安全提示，不显示路径、正文或系统原始错误。
