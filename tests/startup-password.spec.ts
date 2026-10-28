import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { ElButton, ElDialog, ElInput } from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import StartupPasswordSettings from '@/features/settings/StartupPasswordSettings.vue'
import UnlockScreen from '@/features/security/UnlockScreen.vue'
import { useSecurityStore } from '@/stores/security'

const { configureStartupPassword } = vi.hoisted(() => ({ configureStartupPassword: vi.fn() }))
vi.mock('@/services/security', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/security')>()),
  configureStartupPassword,
}))

function mountSettings(enabled = false): ReturnType<typeof mount> {
  useSecurityStore().snapshot = { passwordEnabled: enabled, locked: false }
  return mount(StartupPasswordSettings, {
    global: { components: { ElButton, ElDialog, ElInput }, stubs: { Teleport: true } },
  })
}

describe('开启密码界面', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    configureStartupPassword.mockReset()
  })

  it('解锁可回车提交，提交后立即清空输入且忙碌时不重复提交', async () => {
    const wrapper = mount(UnlockScreen, {
      props: { busy: false },
      global: { components: { ElButton, ElInput } },
    })
    await wrapper.get('input').setValue('开启密码123')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('unlock')).toEqual([['开启密码123']])
    expect(wrapper.get('input').element.value).toBe('')
    await wrapper.setProps({ busy: true, error: '密码不正确，请重新输入。' })
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('unlock')).toHaveLength(1)
    expect(wrapper.get('[role="alert"]').text()).toContain('密码不正确')
    wrapper.unmount()
  })

  it('校验确认密码，保存成功后更新状态并清空表单', async () => {
    const wrapper = mountSettings()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    await wrapper.get('#new-startup-password').setValue('开启密码123')
    await wrapper.get('#confirm-startup-password').setValue('不同密码123')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('不一致')
    expect(configureStartupPassword).not.toHaveBeenCalled()

    configureStartupPassword.mockResolvedValue({ passwordEnabled: true, locked: false })
    await wrapper.get('#confirm-startup-password').setValue('开启密码123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(configureStartupPassword).toHaveBeenCalledWith({
      currentPassword: undefined,
      newPassword: '开启密码123',
    })
    expect(useSecurityStore().snapshot?.passwordEnabled).toBe(true)
    expect(wrapper.text()).toContain('每次启动需输入密码')
    expect(wrapper.findAll('input').every((input) => input.element.value === '')).toBe(true)
    wrapper.unmount()
  })

  it.each([
    { password: '123', length: 3, valid: false },
    { password: '1234', length: 4, valid: true },
    { password: '🔒'.repeat(20), length: 20, valid: true },
    { password: '1'.repeat(21), length: 21, valid: false },
  ])('校验 $length 位新密码的长度边界', async ({ password, valid }) => {
    const wrapper = mountSettings()
    configureStartupPassword.mockResolvedValue({ passwordEnabled: true, locked: false })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.get('#new-startup-password').attributes('placeholder')).toBe('4～20 个字符')
    await wrapper.get('#new-startup-password').setValue(password)
    await wrapper.get('#confirm-startup-password').setValue(password)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    if (valid) {
      expect(configureStartupPassword).toHaveBeenCalledWith({
        currentPassword: undefined,
        newPassword: password,
      })
    } else {
      expect(configureStartupPassword).not.toHaveBeenCalled()
      expect(wrapper.get('[role="alert"]').text()).toContain('4～20 个字符')
    }
    wrapper.unmount()
  })

  it('关闭密码必须验证当前密码，失败时保留原状态', async () => {
    const wrapper = mountSettings(true)
    await wrapper.findAll('button')[1]?.trigger('click')
    await flushPromises()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('请输入当前密码')
    expect(configureStartupPassword).not.toHaveBeenCalled()

    configureStartupPassword.mockRejectedValueOnce({
      code: 'PASSWORD_INCORRECT',
      message: '密码不正确，请重新输入。',
    })
    await wrapper.get('#current-startup-password').setValue('错误密码123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(useSecurityStore().snapshot?.passwordEnabled).toBe(true)
    expect(wrapper.get('[role="alert"]').text()).toContain('密码不正确')
    expect(wrapper.get<HTMLInputElement>('#current-startup-password').element.value).toBe('')

    configureStartupPassword.mockResolvedValue({ passwordEnabled: false, locked: false })
    await wrapper.get('#current-startup-password').setValue('正确密码123')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(configureStartupPassword).toHaveBeenLastCalledWith({
      currentPassword: '正确密码123',
      newPassword: null,
    })
    expect(wrapper.text()).toContain('未设置')
    wrapper.unmount()
  })
})
