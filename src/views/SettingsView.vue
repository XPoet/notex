<script setup lang="ts">
import { onMounted, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import SettingsPanel from '@/features/settings/SettingsPanel.vue'
import StartupPasswordSettings from '@/features/settings/StartupPasswordSettings.vue'
import { chooseDefaultExportDirectory, openDataDirectory } from '@/services/settings'
import ManagementLayout from '@/layouts/ManagementLayout.vue'
import { useCategoriesStore } from '@/stores/categories'
import { useSettingsStore } from '@/stores/settings'
import { useTagsStore } from '@/stores/tags'
import type { SaveSettingsRequest } from '@/types/settings'

const categoriesStore = useCategoriesStore()
const tagsStore = useTagsStore()
const settingsStore = useSettingsStore()
const router = useRouter()
const isOpeningDirectory = shallowRef(false)

function requestFromCurrent(
  changes: Partial<SaveSettingsRequest>,
): SaveSettingsRequest | undefined {
  const settings = settingsStore.snapshot
  if (settings === undefined) return undefined
  const request: SaveSettingsRequest = {
    theme: changes.theme ?? settings.theme,
    noteSort: changes.noteSort ?? settings.noteSort,
    editorFontSize: changes.editorFontSize ?? settings.editorFontSize,
    showCategoryCounts: changes.showCategoryCounts ?? settings.showCategoryCounts,
  }
  if (changes.defaultExportDirectory !== undefined) {
    request.defaultExportDirectory = changes.defaultExportDirectory
  }
  return request
}

async function updateSettings(changes: Partial<SaveSettingsRequest>): Promise<void> {
  const request = requestFromCurrent(changes)
  if (request === undefined) return
  try {
    await settingsStore.save(request)
  } catch {
    ElMessage.error(settingsStore.error?.message ?? '保存设置失败。')
  }
}

async function chooseDirectory(): Promise<void> {
  try {
    const directory = await chooseDefaultExportDirectory()
    if (directory !== undefined) await updateSettings({ defaultExportDirectory: directory })
  } catch {
    ElMessage.error('无法选择默认导出目录。')
  }
}

async function openDirectory(): Promise<void> {
  isOpeningDirectory.value = true
  try {
    await openDataDirectory()
  } catch {
    ElMessage.error('无法打开数据目录。')
  } finally {
    isOpeningDirectory.value = false
  }
}

function createNote(categoryId?: string): void {
  void router.push({ name: 'workbench', query: { create: '1', category: categoryId } })
}

onMounted(() => {
  void Promise.all([settingsStore.load(), categoriesStore.load(), tagsStore.load()])
})
</script>

<template>
  <ManagementLayout
    title="设置"
    description="管理保存在此设备上的偏好与目录。"
    :categories="categoriesStore.categories"
    :tag-count="tagsStore.tags.length"
    @create="createNote"
  >
    <p v-if="settingsStore.error && !settingsStore.snapshot" class="settings-error" role="alert">
      {{ settingsStore.error.message }}
    </p>
    <SettingsPanel
      v-else
      :settings="settingsStore.snapshot"
      :is-saving="settingsStore.isSaving"
      :is-opening-directory="isOpeningDirectory"
      @update="updateSettings"
      @choose-default-export-directory="chooseDirectory"
      @open-data-directory="openDirectory"
    >
      <template #security>
        <StartupPasswordSettings />
      </template>
    </SettingsPanel>
  </ManagementLayout>
</template>

<style scoped lang="scss">
.settings-error {
  margin: 0;
  color: var(--color-danger);
}
</style>
