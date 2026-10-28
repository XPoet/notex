# NoteX 数据库契约

> 契约版本：V006
> 最后更新：2026-10-28

## 1. 存储位置与连接约束

- 数据库固定存放在 Tauri 系统应用数据目录的 `database/notex.db`；前端不得传入或读取该路径。
- 启动连接必须启用 `foreign_keys = ON`、`journal_mode = WAL`、`synchronous = NORMAL` 和 `busy_timeout = 5000`。
- 所有结构变更必须新增只增不改的 `src-tauri/migrations/VNNN__*.sql`；单个迁移与迁移记录写入同一事务。
- 迁移执行失败时，应用进入诊断状态，不得继续正常业务。

## 2. Migration 记录

`schema_migrations` 记录已成功执行的迁移。

| 字段         | 类型    | 约束         | 说明                         |
| ------------ | ------- | ------------ | ---------------------------- |
| `version`    | INTEGER | 主键、正整数 | Migration 版本号，例如 `1`   |
| `name`       | TEXT    | 非空、唯一   | Migration 文件名，不含扩展名 |
| `applied_at` | TEXT    | 非空         | UTC Unix 时间戳（秒）        |

应用仅接受连续的 `V001` 起始 Migration；发现重复版本、版本断档、名称不匹配或 SQL 执行错误时停止启动。

## 3. V001 核心表

### 3.1 `notes`

| 字段                         | 类型    | 约束                                         |
| ---------------------------- | ------- | -------------------------------------------- |
| `id`                         | TEXT    | 主键                                         |
| `title`                      | TEXT    | 非空，默认空字符串                           |
| `content`                    | TEXT    | 非空，默认空字符串                           |
| `category_id`                | TEXT    | 可空，外键到 `categories.id`，删除分类时置空 |
| `is_pinned`                  | INTEGER | 非空，取值 0 或 1，默认 0                    |
| `is_deleted`                 | INTEGER | 非空，取值 0 或 1，默认 0                    |
| `trashed_from_category_id`   | TEXT    | 可空，供分类分支删除后的恢复使用             |
| `trashed_from_category_path` | TEXT    | 可空，供回收站展示使用                       |
| `created_at`                 | TEXT    | 非空，UTC RFC 3339                           |
| `updated_at`                 | TEXT    | 非空，UTC RFC 3339                           |
| `deleted_at`                 | TEXT    | 可空，UTC RFC 3339                           |

### 3.2 `categories`

| 字段         | 类型    | 约束                                         |
| ------------ | ------- | -------------------------------------------- |
| `id`         | TEXT    | 主键                                         |
| `name`       | TEXT    | 非空                                         |
| `parent_id`  | TEXT    | 可空，外键到 `categories.id`，删除父节点受限 |
| `level`      | INTEGER | 非空，取值 1 至 5                            |
| `sort_order` | INTEGER | 非空，默认 0                                 |
| `created_at` | TEXT    | 非空，UTC RFC 3339                           |
| `updated_at` | TEXT    | 非空，UTC RFC 3339                           |

同一父级下名称唯一：根节点使用部分唯一索引，子节点使用 `(parent_id, name)` 唯一索引。层级、循环和跨树移动等业务校验由后续 Category Service 在事务中完成。

### 3.3 `tags` 与 `note_tags`

`tags.name` 全局唯一；`note_tags` 使用 `(note_id, tag_id)` 复合主键，关联删除时级联清理。

| 表          | 关键字段                                 |
| ----------- | ---------------------------------------- |
| `tags`      | `id`、`name`、`created_at`、`updated_at` |
| `note_tags` | `note_id`、`tag_id`、`created_at`        |

### 3.4 `assets` 与 `note_assets`

资源由内容哈希唯一约束识别，物理文件仅存相对路径。为了同时支持资源去重和多笔记共享，`assets` 不保存 `note_id`，关联由 `note_assets` 表维护。

| 表            | 关键字段                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `assets`      | `id`、`file_name`、`original_name`、`extension`、`relative_path`、`mime_type`、`size`、`width`、`height`、`hash`、`created_at` |
| `note_assets` | `note_id`、`asset_id`、`created_at`                                                                                            |

`extension`、`relative_path`、`mime_type`、`size` 和图片尺寸必须由 Rust 基于真实文件内容校验后写入；后续资源服务以 `note_assets` 引用计数决定是否可以清理物理文件。

### 3.5 `app_settings` 与 `recovery_drafts`

| 表                | 关键字段                                                                  | 说明                                     |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `app_settings`    | `key`、`value`、`updated_at`                                              | 设置值只能由 Settings Service 校验后写入 |
| `recovery_drafts` | `note_id`、`title`、`content`、`failure_code`、`created_at`、`updated_at` | 自动保存持续失败时保存可恢复草稿元数据   |

T10 复用既有 `app_settings` 表，不新增结构 Migration。允许的键和值由 Repository 以单事务 UPSERT 保存：

| `key`                      | `value`                                | 默认值与约束                                                 |
| -------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `theme`                    | `light`、`dark` 或 `system`            | 默认 `system`                                                |
| `note_sort`                | `updatedAt`、`createdAt` 或 `title`    | 默认 `updatedAt`；排序字段只能在 Rust 白名单中映射           |
| `editor_font_size`         | 14、15、16、17 或 18 的十进制字符串    | 默认 `15`，单位由前端固定为 px                               |
| `show_category_counts`     | `true` 或 `false`                      | 默认 `true`                                                  |
| `default_export_directory` | 经 Rust 规范化后的现有可写目录绝对路径 | 默认不存在该行；读取时重新检查，失效或不可写时回退到桌面目录 |
| `startup_password_hash`    | 带随机盐与参数的 Argon2id PHC 字符串   | 默认不存在该行；存在即启用开启密码，关闭时在事务中移除此键   |

设置读取会补齐缺失默认值，但不会把用户提供的键、未知 JSON 或任意路径写入数据库。默认导出目录失效后保留数据库原值用于未来恢复，当前快照回退为桌面目录；前端只会收到经过校验的当前有效路径。

开启密码复用现有键值表，不改变表结构或 Migration 版本。密码配置由独立 Security Service / Repository 维护，普通 `save_settings` 无权写入该键。保存使用事务；修改和关闭前由 Rust 校验当前密码，校验或写入失败保留原配置。密码哈希不进入 `SettingsSnapshot`，也不进入导出或关闭备份。启动前仅以只读连接读取密码键；空值、损坏格式、异常哈希参数和数据库读取错误均阻止启动，不视为未配置。

### 3.6 V002 `asset_cleanup_queue`

| 字段            | 类型    | 约束       | 说明                                                  |
| --------------- | ------- | ---------- | ----------------------------------------------------- |
| `relative_path` | TEXT    | 主键       | 仅保存受控的 `assets/{asset-id}.{extension}` 相对路径 |
| `queued_at`     | TEXT    | 非空       | 首次加入清理队列的 UTC RFC 3339 时间                  |
| `attempts`      | INTEGER | 非空、非负 | 已尝试删除文件的次数                                  |
| `last_error`    | TEXT    | 可空       | 仅保存稳定错误码，不保存系统绝对路径                  |

### 3.7 V003 `notes_fts`

V003 新增 FTS5 虚拟表 `notes_fts`，用于未删除笔记的全文检索。表包含不索引的稳定 `note_id` 与索引列 `search_text`；不保存前端路径、查询历史或用户行为。

- `search_text` 由 Rust 从笔记标题、正文、完整分类路径和全部标签名构建；分类和标签变更也会触发重建。
- 中文按连续字符词元写入，英文、数字按连续词元写入，其他常见符号作为词元边界；查询使用同一规则生成短语，保证中文词组顺序匹配、英文大小写不敏感与多关键词 AND。
- 回收站笔记不写入索引；恢复后重新进入索引。所有影响上述字段的事务提交后，Repository 在同一 SQLite 连接内原子重建索引；重建失败不记录笔记正文到日志。

## 4. 索引与后续演进

- V001 为外键过滤、笔记列表、分类排序和资源引用计数建立基础索引。
- V003 使用 FTS5 `notes_fts`；结果按 BM25 相关度、`updated_at DESC`、`id DESC` 排序，并使用受限 offset 分页。
- 每项新增字段、索引或约束必须先更新本文档，再新增对应 Migration、Repository 测试和调用方。

## 5. T03～T10 数据写入规则

### 5.1 笔记与恢复草稿

- 创建笔记时以 UUID、空标题和空正文插入 `notes`，`created_at` 与 `updated_at` 均使用 UTC RFC 3339。
- 普通保存必须在一个事务内更新 `title`、`content` 和 `updated_at`；标题和正文最大长度由 Rust Service 校验，避免异常大请求耗尽内存。
- 完全空白且没有 `note_assets` 关联的临时笔记可在离开时删除；非空笔记、含资源笔记和已删除笔记不得被该清理逻辑删除。
- 正常保存失败后，`recovery_drafts` 以 `note_id` 为主键 UPSERT 标题、正文、失败码和时间；恢复草稿不是历史版本，也不替代前端内存草稿。

### 5.2 资源文件与关联

- 文件固定写入应用数据目录内的 `assets/{asset-id}.{extension}`；`relative_path` 只保存该相对路径，禁止保存绝对路径或前端提供的路径。
- 服务端根据文件头识别 PNG、JPEG、WebP、GIF，并以受限内存和尺寸的完整解码验证可读性；`extension`、`mime_type`、`size`、`width`、`height` 必须与实际字节一致。
- 服务端先计算 SHA-256。哈希已存在时仅在事务中幂等插入 `note_assets`；哈希不存在时先写入 `temp/` 临时文件、`sync_all`、原子移动到 `assets/`，再在事务内插入 `assets` 与 `note_assets`。
- 资源记录或关联事务失败时，服务端必须删除本次新建的最终文件；临时文件失败时也必须清理。后续 T05 负责永久删除后的引用计数垃圾回收。
- 图片文件不存在时不得删除或改写 Markdown；健康检查仅返回缺失数量，避免暴露应用数据目录。

### 5.3 回收站与资源清理

- 普通删除只将 `notes.is_deleted` 设为 `1`，同时写入 `deleted_at`、删除前的 `category_id` 和当时完整分类路径；不得解除 `note_assets`，也不得清理资源文件。
- 恢复时仅当记录的原分类仍存在才恢复到该分类；否则恢复到未分类。恢复后清空回收站元数据。
- 永久删除和清空回收站在事务中删除笔记及关联关系；仅把引用计数为零的资源相对路径写入 `asset_cleanup_queue`，再删除资源记录。事务提交后逐项删除文件。
- 文件删除失败不回滚已提交的笔记删除；队列保留并记录稳定错误码，后续任何永久删除、清空或应用启动可幂等重试。成功删除或文件已不存在时才移除队列项。

### 5.4 分类

- 分类名在 Service 中执行 trim、非空和同级不区分大小写唯一校验；根节点与子节点都适用。`level`、循环、目标父级及整棵子树深度均在同一事务中校验。
- 新建或移动时以同级最大 `sort_order + 1` 追加；拖拽排序通过显式同级 ID 顺序重写连续排序值。
- “仅删除当前分类”在事务中把直属笔记和直属子分类移动到父级；“删除整个分支”把分支内未删除笔记软删除并记录删除前完整路径，然后删除分类节点。
- 分类筛选使用递归 CTE 返回当前分类与所有后代的未删除笔记；未分类筛选使用 `category_id IS NULL`。

### 5.5 标签

- 标签名在 Service 中执行 trim、非空和不区分大小写全局唯一校验。笔记标签关系使用 `INSERT OR IGNORE`，重复关联保持幂等。
- 重命名为已有标签必须先返回合并影响数；确认合并后，在一个事务中将关系迁移至目标标签、去重并删除源标签。
- 删除标签只删除 `note_tags` 关系和 `tags` 记录；不得修改笔记内容、分类或资源。
- 多标签筛选使用 `GROUP BY note_id HAVING COUNT(DISTINCT tag_id) = 选中标签数`，只返回同时包含全部标签的未删除笔记。

### 5.6 大图片决策 D01

T04 将“文件过大”明确为实际字节数达到或超过 10 MiB。此前端交互门槛只要求显示文件大小并允许用户取消，不进行压缩、转码、尺寸调整或静默拒绝；用户确认后仍由后端执行完整格式和安全校验。

### 5.7 搜索索引

- 创建、保存、清理、分类调整、标签调整、移入回收站、恢复和永久删除成功后，必须在同一数据库连接内重建 `notes_fts`，不得把索引状态交给前端维护。
- 搜索请求在 Rust Service 中执行 trim、长度、关键词数、分页边界校验；空查询不访问 FTS，前端清空后返回全部笔记入口。
- 查询只接受经过 Service 分词和转义后生成的 FTS 表达式，SQL 的 `MATCH`、`LIMIT` 与 `OFFSET` 均使用参数绑定，禁止前端传入 SQL、字段名或排序规则。
- 应用启动完成 Migration 后重建一次索引；`rebuild_search_index` 可在索引异常时重复执行，不修改原始笔记、分类或标签数据。

### 5.8 设置

- 读取设置、校验、写入和时间戳更新均在 Rust Settings Service／Repository 中完成；前端不得直接读写 `app_settings`。
- 默认导出目录必须先通过系统目录对话框取得；Service 使用规范化后的既有目录并验证可写性，拒绝文件、相对路径和不可写目录。
- “打开数据目录”不接受前端路径；Command 仅取得 Tauri 系统应用数据目录，再由后端受控调用 opener。
- 笔记列表、分类筛选和标签筛选从同一 `note_sort` 白名单读取排序规则；`is_pinned DESC` 始终优先于用户排序，回收站和全文搜索保持各自既定排序。
