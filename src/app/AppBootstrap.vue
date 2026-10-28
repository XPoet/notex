<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { nextTick, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { showMainWindow } from '@/services/window'
import { useAppStore } from '@/stores/app'
import { useSecurityStore } from '@/stores/security'
import UnlockScreen from '@/features/security/UnlockScreen.vue'

const appStore = useAppStore()
const securityStore = useSecurityStore()
const { error, status } = storeToRefs(appStore)

async function showWindowAfterFirstPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve)
    })
  })

  await showMainWindow()
}

async function initialize(): Promise<void> {
  await appStore.bootstrap()
  await nextTick()
  await showWindowAfterFirstPaint()
}

async function unlock(password: string): Promise<void> {
  try {
    await appStore.unlock(password)
  } catch {
    // 密码错误保留解锁界面，由安全 Store 提供提示。
  }
}

onMounted(() => {
  void initialize()
})
</script>

<template>
  <main class="app-bootstrap" aria-live="polite">
    <UnlockScreen
      v-if="status === 'locked'"
      :busy="securityStore.isUnlocking"
      :error="securityStore.error?.message"
      @unlock="unlock"
    />
    <section v-else-if="status === 'failed'" class="diagnostic-panel">
      <p class="eyebrow">{{ t('启动诊断') }}</p>
      <h1 class="diagnostic-title">{{ t('无法初始化本地数据') }}</h1>
      <p class="diagnostic-message">{{ localizeMessage(error?.message) }}</p>
      <el-button type="primary" @click="initialize">{{ t('重试') }}</el-button>
    </section>

    <section v-else class="loading-panel">
      <span class="loading-icon" aria-hidden="true"></span>
      <p class="loading-label">{{ t('正在准备本地工作区…') }}</p>
    </section>
  </main>
</template>

<style scoped lang="scss">
.app-bootstrap {
  display: grid;
  min-block-size: 100vh;
  place-items: center;
  padding: var(--space-24);
  background: var(--color-canvas);
}

.diagnostic-panel {
  inline-size: min(100%, 440px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
  box-shadow: var(--shadow-floating);
  padding: var(--space-32);
}

.loading-panel {
  display: grid;
  justify-items: center;
  gap: var(--space-12);
}

.eyebrow {
  margin: 0 0 var(--space-8);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.diagnostic-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xl);
}

.diagnostic-message,
.loading-label {
  margin: var(--space-12) 0 var(--space-20);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.loading-label {
  margin: 0;
  font-size: 14px;
}

.loading-icon {
  inline-size: 28px;
  block-size: 28px;
  border: 3px solid color-mix(in srgb, var(--color-accent) 18%, transparent);
  border-block-start-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
