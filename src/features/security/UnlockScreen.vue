<script setup lang="ts">
import { t, localizeMessage } from '@/i18n'
import { nextTick, onMounted, ref, watch } from 'vue'
import type { InputInstance } from 'element-plus'
import logo from '@/assets/notex-icon.svg'

const props = defineProps<{
  busy: boolean
  error?: string
}>()

const emit = defineEmits<{
  unlock: [password: string]
}>()

const password = ref('')
const input = ref<InputInstance>()

async function focusInput(): Promise<void> {
  await nextTick()
  input.value?.focus()
}

function submit(): void {
  if (props.busy || password.value.length === 0) return
  const entered = password.value
  password.value = ''
  emit('unlock', entered)
}

onMounted(() => void focusInput())
watch(
  () => props.busy,
  (busy) => {
    if (!busy) void focusInput()
  },
)
</script>

<template>
  <section class="unlock-screen" aria-labelledby="unlock-title">
    <img :src="logo" alt="" class="unlock-logo" />
    <h1 id="unlock-title">{{ t('解锁 NoteX') }}</h1>
    <p class="unlock-description">{{ t('输入开启密码，继续使用你的本地笔记。') }}</p>
    <form class="unlock-form" @submit.prevent="submit">
      <label for="startup-password">{{ t('开启密码') }}</label>
      <el-input
        id="startup-password"
        ref="input"
        v-model="password"
        type="password"
        autocomplete="current-password"
        :placeholder="t('请输入开启密码')"
        show-password
        :disabled="busy"
        :aria-invalid="Boolean(error)"
        :aria-describedby="error ? 'unlock-error' : undefined"
      />
      <p v-if="error" id="unlock-error" class="unlock-error" role="alert">{{ localizeMessage(error) }}</p>
      <el-button type="primary" native-type="submit" :loading="busy" :disabled="!password || busy">{{
        t('解锁')
      }}</el-button>
    </form>
  </section>
</template>

<style scoped lang="scss">
.unlock-screen {
  inline-size: min(100%, 340px);
  text-align: center;
}

.unlock-logo {
  inline-size: 64px;
  block-size: 64px;
  margin-block-end: var(--space-20);
}

.unlock-screen h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xl);
}

.unlock-description {
  margin: var(--space-12) 0 var(--space-32);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.unlock-form {
  display: grid;
  gap: var(--space-12);
  text-align: start;
}

.unlock-form label {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.unlock-form .el-button {
  margin-block-start: var(--space-8);
}

.unlock-error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}
</style>
