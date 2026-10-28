<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { InfoFilled } from '@element-plus/icons-vue'
import { computed, shallowRef, watch } from 'vue'
import ExportDirectoryPicker from './ExportDirectoryPicker.vue'
import ExportScopeOption from './ExportScopeOption.vue'
import ExportStatusPanel from './ExportStatusPanel.vue'
import { useExportStore } from '@/stores/export'
import { useSettingsStore } from '@/stores/settings'
import type { ExportScope, ExportScopeOption as ExportScopeOptionType } from '@/types/export'

const props = defineProps<{
  modelValue: boolean
  scopeOptions: ExportScopeOptionType[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const exportStore = useExportStore()
const settingsStore = useSettingsStore()
const selectedScope = shallowRef<ExportScope>()
const canClose = computed(() => exportStore.status !== 'exporting' && exportStore.status !== 'choosing')
const isConfigLocked = computed(() => exportStore.status === 'exporting' || exportStore.status === 'choosing')
const canStart = computed(() => selectedScope.value !== undefined && exportStore.targetDirectory !== undefined)

watch(
  () => props.modelValue,
  async (visible) => {
    if (visible) {
      selectedScope.value = props.scopeOptions[0]?.scope
      exportStore.reset()
      if (settingsStore.snapshot === undefined) {
        await settingsStore.load()
      }
      if (!props.modelValue || exportStore.status !== 'idle') {
        return
      }
      if (settingsStore.snapshot?.defaultExportDirectory !== undefined) {
        exportStore.setDefaultDirectory(settingsStore.snapshot.defaultExportDirectory)
      }
    }
  },
  { immediate: true },
)

watch(
  () => props.scopeOptions,
  (options) => {
    if (props.modelValue && exportStore.status !== 'exporting') {
      selectedScope.value = options[0]?.scope
    }
  },
)

function selectScope(scope: ExportScope): void {
  selectedScope.value = scope
}

function close(): void {
  if (canClose.value) {
    emit('update:modelValue', false)
  }
}

function startExport(): void {
  const scope = selectedScope.value
  if (scope !== undefined) {
    void exportStore.start(scope)
  }
}

function chooseDirectory(): void {
  void exportStore.chooseDirectory()
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('导出 Markdown')"
    class="export-dialog"
    width="min(1024px, calc(100vw - 32px))"
    :close-on-click-modal="canClose"
    :close-on-press-escape="canClose"
    :show-close="canClose"
    @update:model-value="close"
  >
    <div class="export-dialog-content">
      <section class="export-config" :aria-label="t('导出配置')">
        <div class="export-section">
          <h2 class="export-section-title">{{ t('导出范围') }}</h2>
          <div class="export-scope-list">
            <ExportScopeOption
              v-for="option in scopeOptions"
              :key="`${option.scope.kind}:${option.scope.id}`"
              :option="option"
              :selected="selectedScope?.kind === option.scope.kind && selectedScope.id === option.scope.id"
              :disabled="isConfigLocked"
              @select="selectScope"
            />
          </div>
        </div>

        <div class="export-section">
          <h2 class="export-section-title">{{ t('导出目录') }}</h2>
          <ExportDirectoryPicker
            :directory="exportStore.targetDirectory"
            :is-choosing="exportStore.status === 'choosing'"
            :disabled="isConfigLocked"
            @choose="chooseDirectory"
          />
          <p class="export-directory-notice" role="note">
            <el-icon><InfoFilled /></el-icon
            >{{ t('所有图片统一写入导出目录根目录下的 assets 文件夹，Markdown 使用相对路径引用。') }}
          </p>
        </div>
      </section>

      <aside class="export-feedback" :aria-label="t('导出状态反馈')">
        <h2 class="export-section-title">{{ t('状态反馈') }}</h2>
        <ExportStatusPanel
          :status="exportStore.status"
          :progress="exportStore.progress"
          :result="exportStore.result"
          :error="exportStore.error"
          :is-opening-directory="exportStore.isOpeningDirectory"
          @choose-directory="chooseDirectory"
          @open-directory="exportStore.openDirectory"
        />

        <el-scrollbar v-if="exportStore.result?.issues.length" class="export-issues" max-height="180px">
          <ul class="export-issues-list">
            <li v-for="issue in exportStore.result.issues" :key="`${issue.code}:${issue.noteId ?? issue.title}`">
              <strong>{{ issue.title }}</strong
              >：{{ localizeMessage(issue.message) }}
            </li>
          </ul>
        </el-scrollbar>
      </aside>
    </div>

    <template #footer>
      <el-button
        v-if="exportStore.status === 'exporting'"
        :loading="exportStore.isCancelling"
        @click="exportStore.cancel"
        >{{ t('取消导出') }}</el-button
      >
      <template v-else-if="exportStore.status === 'completed'">
        <el-button type="primary" @click="close">{{ t('完成') }}</el-button>
      </template>
      <template v-else-if="exportStore.status === 'failed'">
        <el-button @click="close">{{ t('关闭') }}</el-button>
      </template>
      <template v-else>
        <el-button @click="close">{{ t('取消') }}</el-button>
        <el-button type="primary" :disabled="!canStart || isConfigLocked" @click="startExport">{{
          t('开始导出')
        }}</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<style scoped lang="scss">
.export-dialog-content {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.9fr);
  gap: 38px;
}

.export-config {
  display: grid;
  align-content: start;
  gap: 30px;
  min-inline-size: 0;
}

.export-feedback {
  display: grid;
  align-content: start;
  gap: var(--space-16);
  min-inline-size: 0;
  padding-inline-start: 38px;
  border-inline-start: 1px solid var(--color-border);
}

.export-section {
  display: grid;
  gap: var(--space-16);
}

.export-section-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 1rem;
  font-weight: 650;
}

.export-scope-list {
  display: grid;
  gap: var(--space-8);
}

.export-directory-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-8);
  margin: 0;
  padding: var(--space-12) var(--space-16);
  border-radius: var(--radius-8);
  background: color-mix(in srgb, #5b7a95 12%, var(--color-surface));
  color: #496c88;
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.export-directory-notice .el-icon {
  flex: 0 0 auto;
  margin-block-start: 3px;
}

.export-issues {
  border: 1px solid color-mix(in srgb, #b8892d 36%, var(--color-border));
  border-radius: var(--radius-8);
  background: color-mix(in srgb, #b8892d 8%, var(--color-surface));
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.export-issues-list {
  display: grid;
  gap: var(--space-8);
  margin: 0;
  padding: var(--space-12) var(--space-16);
}

@media (max-width: 760px) {
  .export-dialog-content {
    grid-template-columns: minmax(0, 1fr);
  }

  .export-feedback {
    padding-block-start: var(--space-20);
    padding-inline-start: 0;
    border-block-start: 1px solid var(--color-border);
    border-inline-start: 0;
  }
}
</style>
