import { beforeEach } from 'vitest'
import { applyLanguage } from '@/i18n'

beforeEach(() => {
  if (typeof document !== 'undefined') applyLanguage('zh-CN')
})
