/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyLanguage, elementLocales, locale, localizeMessage, t } from '@/i18n'
import { messages } from '@/i18n/messages'
import { getInitialLanguage, LANGUAGE_STORAGE_KEY, resolveSystemLanguage } from '@/i18n/locale'
import type { AppLanguage } from '@/i18n/locale'
import SettingsPanel from '@/features/settings/SettingsPanel.vue'
import NoteListItem from '@/features/notes/NoteListItem.vue'

const languageCases: Array<[string | undefined, AppLanguage]> = [
  ['zh', 'zh-CN'],
  ['zh-CN', 'zh-CN'],
  ['zh-SG', 'zh-CN'],
  ['zh-Hans', 'zh-CN'],
  ['zh-Hans-TW', 'zh-CN'],
  ['zh-TW', 'zh-TW'],
  ['zh-HK', 'zh-TW'],
  ['zh-MO', 'zh-TW'],
  ['zh-Hant', 'zh-TW'],
  ['zh-Hant-CN', 'zh-TW'],
  ['ZH_hant_HK', 'zh-TW'],
  ['en-US', 'en'],
  ['en-GB', 'en'],
  ['ja-JP', 'en'],
  ['fr-FR', 'en'],
  ['', 'en'],
  [undefined, 'en'],
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('界面语言', () => {
  it.each(languageCases)('系统语种 %s 默认选择 %s', (systemLanguage, expected) => {
    expect(resolveSystemLanguage(systemLanguage)).toBe(expected)
  })

  it('使用已保存的选择；缓存无效时重新匹配系统语种', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-TW')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    expect(getInitialLanguage()).toBe('en')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'system')
    expect(getInitialLanguage()).toBe('zh-TW')
    localStorage.setItem(LANGUAGE_STORAGE_KEY, '')
    expect(getInitialLanguage()).toBe('zh-TW')
  })

  it('缓存不可读写时仍可切换语言并使用系统默认值', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-Hans-CN')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable')
    })
    expect(getInitialLanguage()).toBe('zh-CN')
    expect(() => applyLanguage('en')).not.toThrow()
    expect(locale.value).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('三种语言都保留完整的插值参数', () => {
    const placeholders = (message: string): string[] =>
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
    for (const [source, translations] of Object.entries(messages)) {
      for (const translation of translations) {
        expect(translation.trim(), source).not.toBe('')
        expect(placeholders(translation), source).toEqual(placeholders(source))
      }
    }
    applyLanguage('en')
    expect(t('笔记已移至“{value1}”。', { value1: '我的分类 {value2} <test>' })).toBe(
      'Note moved to “我的分类 {value2} <test>”.',
    )
  })

  it('错误提示与 Element Plus 内置文案使用所选语言', () => {
    applyLanguage('en')
    expect(localizeMessage('密码不正确，请重新输入。')).toBe('Incorrect password. Please try again.')
    expect(elementLocales[locale.value].name).toBe('en')
    applyLanguage('zh-TW')
    expect(localizeMessage('无法读取本地设置。')).toBe('無法讀取本機設定。')
    expect(elementLocales[locale.value].name).toBe('zh-tw')
    expect(localizeMessage(undefined)).toBeUndefined()
    expect(localizeMessage('Unknown message')).toBe('Unknown message')
  })

  it('语言框仅提供三种语种，切换后界面立即重新翻译', async () => {
    const wrapper = mount(SettingsPanel, {
      props: { isSaving: false, isOpeningDirectory: false },
      global: {
        stubs: {
          ElButton: { template: '<button><slot /></button>' },
          ElSelect: {
            props: ['modelValue'],
            template: `<select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)"><slot /></select>`,
          },
          ElOption: {
            props: ['label', 'value'],
            template: '<option :value="value">{{ label }}</option>',
          },
        },
      },
    })
    expect(
      wrapper
        .get('select[aria-label="界面语言"]')
        .findAll('option')
        .map((option) => option.text()),
    ).toEqual(['简体中文', '繁體中文', 'English'])
    await wrapper.get('select[aria-label="界面语言"]').setValue('en')
    expect(wrapper.emitted('update')?.[0]).toEqual([{ language: 'en' }])
    applyLanguage('en')
    await nextTick()
    expect(wrapper.text()).toContain('Appearance and editor')
    expect(wrapper.get<HTMLSelectElement>('select[aria-label="Language"]').element.value).toBe('en')
    applyLanguage('zh-TW')
    await nextTick()
    expect(wrapper.text()).toContain('外觀與編輯')
    expect(wrapper.text()).toContain('本機目錄與匯出')
    wrapper.unmount()
  })

  it('切换语言不会翻译用户的笔记标题和正文', async () => {
    const wrapper = mount(NoteListItem, {
      props: {
        selected: false,
        note: {
          id: 'note',
          title: '保存',
          contentPreview: '我的笔记 My note 我的筆記',
          tagNames: [],
          isPinned: false,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      },
    })
    applyLanguage('en')
    await nextTick()
    expect(wrapper.text()).toContain('保存')
    expect(wrapper.text()).toContain('我的笔记 My note 我的筆記')
    expect(wrapper.attributes('title')).toBe('Drag to a category in the sidebar to move this note')
    wrapper.unmount()
  })
})

describe('Vue 加载前的语言恢复', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')
  const script = html.match(/<script id="startup-language">([\s\S]*?)<\/script>/)?.[1] ?? ''

  function startup(systemLanguage: string | undefined, saved: string | null): { language: string; label: string } {
    const root = { lang: '' }
    const label = { textContent: '' }
    runInNewContext(script, {
      navigator: { language: systemLanguage },
      localStorage: { getItem: () => saved },
      document: { documentElement: root, querySelector: () => label },
    })
    return { language: root.lang, label: label.textContent }
  }

  it.each(languageCases)('启动占位页在系统语种 %s 下与正式界面使用同一默认值', (systemLanguage, expected) => {
    const result = startup(systemLanguage, null)
    expect(result.language).toBe(expected)
    applyLanguage(expected)
    expect(result.label).toBe(t('正在准备本地工作区…'))
  })

  it.each<AppLanguage>(['zh-CN', 'zh-TW', 'en'])('启动与解锁前恢复手动选择的 %s', (language) => {
    expect(startup('ja-JP', language).language).toBe(language)
  })
})
