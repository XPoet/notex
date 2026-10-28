<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { InputInstance } from 'element-plus'
import { useSecurityStore } from '@/stores/security'

type PasswordAction = 'set' | 'change' | 'disable'

const securityStore = useSecurityStore()
const visible = ref(false)
const action = ref<PasswordAction>('set')
const currentPassword = ref('')
const newPassword = ref('')
const confirmation = ref('')
const validationError = ref('')
const currentInput = ref<InputInstance>()
const newInput = ref<InputInstance>()
const passwordEnabled = computed(() => securityStore.snapshot?.passwordEnabled ?? false)
const title = computed(() => {
  if (action.value === 'disable') return '关闭开启密码'
  return action.value === 'change' ? '修改开启密码' : '设置开启密码'
})

function clearPasswords(): void {
  currentPassword.value = ''
  newPassword.value = ''
  confirmation.value = ''
  validationError.value = ''
}

function open(action_: PasswordAction): void {
  action.value = action_
  clearPasswords()
  securityStore.clearError()
  visible.value = true
}

async function focusInput(): Promise<void> {
  await nextTick()
  const input = passwordEnabled.value ? currentInput.value : newInput.value
  input?.focus()
}

async function submit(): Promise<void> {
  if (securityStore.isSaving) return
  validationError.value = ''
  securityStore.clearError()
  if (passwordEnabled.value && !currentPassword.value) {
    validationError.value = '请输入当前密码。'
    return
  }
  if (action.value !== 'disable') {
    const length = Array.from(newPassword.value).length
    if (length < 4 || length > 20 || newPassword.value.trim().length === 0) {
      validationError.value = '密码需为 4～20 个字符，且不能全部为空白。'
      return
    }
    if (newPassword.value !== confirmation.value) {
      validationError.value = '两次输入的新密码不一致。'
      return
    }
  }
  try {
    await securityStore.configure({
      currentPassword: passwordEnabled.value ? currentPassword.value : undefined,
      newPassword: action.value === 'disable' ? null : newPassword.value,
    })
    visible.value = false
    clearPasswords()
    ElMessage.success(
      action.value === 'disable' ? '已关闭开启密码。' : '开启密码已保存，下次启动时生效。',
    )
  } catch {
    currentPassword.value = ''
    void focusInput()
  }
}

onBeforeUnmount(clearPasswords)
</script>

<template>
  <article class="password-settings">
    <header>
      <h2>安全</h2>
      <p>配置打开 NoteX 时使用的密码。</p>
    </header>
    <div class="password-row">
      <span>
        <strong>开启密码</strong>
        <small>{{
          passwordEnabled ? '已开启，每次启动需输入密码。' : '未设置，打开软件可直接使用。'
        }}</small>
      </span>
      <div class="password-actions">
        <template v-if="passwordEnabled">
          <el-button @click="open('change')">修改密码</el-button>
          <el-button @click="open('disable')">关闭密码</el-button>
        </template>
        <el-button v-else :disabled="!securityStore.snapshot" @click="open('set')"
          >设置密码</el-button
        >
      </div>
    </div>
  </article>

  <el-dialog
    v-model="visible"
    :title="title"
    width="420px"
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="!securityStore.isSaving"
    :show-close="!securityStore.isSaving"
    @opened="focusInput"
    @close="clearPasswords"
  >
    <form class="password-form" @submit.prevent="submit">
      <template v-if="passwordEnabled">
        <label for="current-startup-password">当前密码</label>
        <el-input
          id="current-startup-password"
          ref="currentInput"
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          show-password
          :disabled="securityStore.isSaving"
        />
      </template>
      <template v-if="action !== 'disable'">
        <label for="new-startup-password">{{ passwordEnabled ? '新密码' : '开启密码' }}</label>
        <el-input
          id="new-startup-password"
          ref="newInput"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          placeholder="4～20 个字符"
          show-password
          :disabled="securityStore.isSaving"
        />
        <label for="confirm-startup-password">确认密码</label>
        <el-input
          id="confirm-startup-password"
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          show-password
          :disabled="securityStore.isSaving"
        />
        <p class="password-hint">
          请牢记密码，忘记后无法通过软件找回。此功能控制启动访问，不加密本地笔记文件。
        </p>
      </template>
      <p v-else class="password-hint">关闭后，下次打开 NoteX 将直接进入工作区。</p>
      <p v-if="validationError || securityStore.error" class="password-error" role="alert">
        {{ validationError || securityStore.error?.message }}
      </p>
      <footer>
        <el-button :disabled="securityStore.isSaving" @click="visible = false">取消</el-button>
        <el-button type="primary" native-type="submit" :loading="securityStore.isSaving">
          {{ action === 'disable' ? '关闭密码' : '保存密码' }}
        </el-button>
      </footer>
    </form>
  </el-dialog>
</template>

<style scoped lang="scss">
.password-settings {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-10);
  background: var(--color-surface);
}

.password-settings header {
  padding: var(--space-16) var(--space-20);
  border-block-end: 1px solid var(--color-divider);
}

.password-settings h2,
.password-settings p {
  margin: 0;
}

.password-settings h2 {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

.password-settings p,
.password-row small {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
  line-height: 1.5;
}

.password-settings p {
  margin-block-start: 4px;
}

.password-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-24);
  min-block-size: 72px;
  padding: var(--space-12) var(--space-20);
}

.password-row > span {
  display: grid;
  gap: 3px;
}

.password-row strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.password-actions {
  display: flex;
  flex: 0 0 auto;
}

.password-form {
  display: grid;
  gap: var(--space-12);
}

.password-form label {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.password-hint,
.password-error {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
}

.password-hint {
  color: var(--color-text-secondary);
}

.password-error {
  color: var(--color-danger);
}

.password-form footer {
  display: flex;
  justify-content: flex-end;
  margin-block-start: var(--space-8);
}

@media (max-width: 680px) {
  .password-row {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-12);
  }
}
</style>
