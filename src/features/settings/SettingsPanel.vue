<script setup lang="ts">
import { t, locale } from '@/i18n'
import { FolderOpened, Setting } from '@element-plus/icons-vue'
import { computed } from 'vue'
import type { NoteSort, SettingsSnapshot, ThemePreference } from '@/types/settings'
import type { AppLanguage } from '@/i18n/locale'

const props = defineProps<{
  settings?: SettingsSnapshot
  isSaving: boolean
  isOpeningDirectory: boolean
}>()

const emit = defineEmits<{
  update: [
    request: {
      language?: AppLanguage
      theme?: ThemePreference
      noteSort?: NoteSort
      editorFontSize?: 14 | 15 | 16 | 17 | 18
    },
  ]
  chooseDefaultExportDirectory: []
  openDataDirectory: []
}>()

const theme = computed({
  get: () => props.settings?.theme ?? 'system',
  set: (value: ThemePreference) => emit('update', { theme: value }),
})
const language = computed({
  get: () => props.settings?.language ?? locale.value,
  set: (value: AppLanguage) => emit('update', { language: value }),
})
const noteSort = computed({
  get: () => props.settings?.noteSort ?? 'updatedAt',
  set: (value: NoteSort) => emit('update', { noteSort: value }),
})
const editorFontSize = computed({
  get: () => props.settings?.editorFontSize ?? 15,
  set: (value: number) => emit('update', { editorFontSize: value as 14 | 15 | 16 | 17 | 18 }),
})

function updateEditorFontSize(value: number): void {
  if (isEditorFontSize(value)) {
    emit('update', { editorFontSize: value })
  }
}

function isEditorFontSize(value: number): value is 14 | 15 | 16 | 17 | 18 {
  return value === 14 || value === 15 || value === 16 || value === 17 || value === 18
}
</script>

<template>
  <section class="settings-panel">
    <article class="settings-group">
      <header>
        <div>
          <h2>{{ t('外观与编辑') }}</h2>
          <p>{{ t('设置会立即应用，并在下次启动时恢复。') }}</p>
        </div>
      </header>
      <label class="settings-row">
        <span
          ><strong>{{ t('界面语言') }}</strong
          ><small>{{ t('默认选择系统语种，无法匹配时使用英语。') }}</small></span
        >
        <el-select v-model="language" :disabled="isSaving" :aria-label="t('界面语言')">
          <el-option label="简体中文" value="zh-CN" />
          <el-option label="繁體中文" value="zh-TW" />
          <el-option label="English" value="en" />
        </el-select>
      </label>
      <label class="settings-row"
        ><span
          ><strong>{{ t('主题') }}</strong
          ><small>{{ t('选择界面颜色模式。') }}</small></span
        >
        <el-select v-model="theme" :disabled="isSaving">
          <el-option :label="t('跟随系统')" value="system" />
          <el-option :label="t('浅色')" value="light" />
          <el-option :label="t('深色')" value="dark" />
        </el-select>
      </label>
      <label class="settings-row">
        <span
          ><strong>{{ t('默认排序') }}</strong
          ><small>{{ t('置顶笔记始终优先显示。') }}</small></span
        >
        <el-select v-model="noteSort" :disabled="isSaving">
          <el-option :label="t('最近编辑')" value="updatedAt" />
          <el-option :label="t('创建时间')" value="createdAt" />
          <el-option :label="t('标题')" value="title" />
        </el-select>
      </label>
      <label class="settings-row">
        <span
          ><strong>{{ t('编辑器字体大小') }}</strong
          ><small>{{ t('仅影响 Markdown 源码编辑区。') }}</small></span
        >
        <el-select :model-value="editorFontSize" :disabled="isSaving" @update:model-value="updateEditorFontSize">
          <el-option v-for="size in [14, 15, 16, 17, 18]" :key="size" :label="`${size} px`" :value="size" />
        </el-select>
      </label>
    </article>

    <slot name="security" />

    <article class="settings-group">
      <header>
        <div>
          <h2>{{ t('本地目录与导出') }}</h2>
          <p>{{ t('数据目录固定由系统管理，不能修改或迁移。') }}</p>
        </div>
      </header>
      <div class="settings-row">
        <span>
          <strong>{{ t('当前数据目录') }}</strong>
          <small>{{ settings?.dataDirectory ?? t('正在读取数据目录。') }}</small>
        </span>
        <el-button :loading="isOpeningDirectory" @click="emit('openDataDirectory')">{{ t('打开数据目录') }}</el-button>
      </div>
      <div class="settings-row">
        <span>
          <strong>{{ t('默认导出目录') }}</strong>
          <small>{{ settings?.defaultExportDirectory ?? t('正在读取默认导出目录。') }}</small>
        </span>
        <div class="settings-actions">
          <el-button :disabled="isSaving" @click="emit('chooseDefaultExportDirectory')">{{ t('选择目录') }}</el-button>
        </div>
      </div>
    </article>

    <article class="settings-group settings-group--about">
      <header>
        <div>
          <h2>{{ t('关于 NoteX') }}</h2>
          <p>{{ t('所有数据仅保存在此设备。') }}</p>
        </div>
      </header>
      <div class="settings-row">
        <span
          ><strong>{{ t('应用版本') }}</strong></span
        ><code>{{ settings?.appVersion ?? '—' }}</code>
      </div>
      <div class="settings-row">
        <span
          ><strong>{{ t('本地数据结构版本') }}</strong></span
        ><code>V{{ settings?.schemaVersion ?? '—' }}</code>
      </div>
    </article>
  </section>
</template>

<style scoped lang="scss">
.settings-panel {
  display: grid;
  gap: var(--space-16);
}

.settings-group {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.settings-group > header {
  display: flex;
  gap: var(--space-12);
  padding: var(--space-16) var(--space-20);
  border-block-end: 1px solid var(--color-divider);
}

.settings-group > header > .el-icon {
  margin-block-start: 2px;
  color: var(--color-accent);
  font-size: 1.125rem;
}

.settings-group h2,
.settings-group p {
  margin: 0;
}

.settings-group h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

.settings-group p,
.settings-row small {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.settings-group p {
  margin-block-start: 4px;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-24);
  min-block-size: 72px;
  padding: var(--space-12) var(--space-20);
  border-block-end: 1px solid var(--color-divider);
}

.settings-row:last-child {
  border-block-end: 0;
}

.settings-row > span {
  display: grid;
  min-inline-size: 0;
  gap: 3px;
}

.settings-row strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.settings-row .el-select {
  inline-size: 168px;
  flex: 0 0 auto;
}

.settings-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

.settings-row code {
  color: var(--color-text-secondary);
  font-family: 'Geist Mono', 'SFMono-Regular', Consolas, monospace;
  font-size: 0.75rem;
}

@media (max-width: 680px) {
  .settings-row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-12);
  }
  .settings-row .el-select {
    inline-size: 100%;
  }
}
</style>
