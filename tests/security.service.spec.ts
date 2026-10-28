import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import {
  configureStartupPassword,
  getAccessStatus,
  toAccessError,
  unlockApp,
} from '@/services/security'

describe('开启密码 Service', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('通过专用接口读取状态、解锁和更新密码', async () => {
    invoke.mockResolvedValue({ passwordEnabled: true, locked: false })
    await getAccessStatus()
    expect(invoke).toHaveBeenLastCalledWith('get_access_status', {})
    await unlockApp('正确密码123')
    expect(invoke).toHaveBeenLastCalledWith('unlock_app', { password: '正确密码123' })
    await configureStartupPassword({ currentPassword: '正确密码123', newPassword: null })
    expect(invoke).toHaveBeenLastCalledWith('configure_startup_password', {
      request: { currentPassword: '正确密码123', newPassword: null },
    })
  })

  it('保留密码错误与冷却提示，屏蔽未知错误内部信息', async () => {
    const error = { code: 'PASSWORD_INCORRECT', message: '密码不正确，请重新输入。' }
    invoke.mockRejectedValue(error)
    await expect(unlockApp('错误密码')).rejects.toEqual(error)
    expect(
      toAccessError({ code: 'PASSWORD_TOO_MANY_ATTEMPTS', message: '请等待 30 秒。' }),
    ).toEqual({
      code: 'PASSWORD_TOO_MANY_ATTEMPTS',
      message: '请等待 30 秒。',
    })
    expect(toAccessError(new Error('private SQL and password'))).toEqual({
      code: 'PASSWORD_READ_FAILED',
      message: '无法读取开启密码配置，请重试。',
    })
  })

  it('保留自动备份同步失败提示', async () => {
    const error = {
      code: 'PASSWORD_BACKUP_SYNC_FAILED',
      message: '无法同步自动备份的密码，请检查备份目录后重试。',
    }
    invoke.mockRejectedValue(error)
    await expect(configureStartupPassword({ newPassword: '1234' })).rejects.toEqual(error)
  })
})
