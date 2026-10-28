import { readonly, shallowRef } from 'vue'
import en from 'element-plus/es/locale/lang/en'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { cacheLanguage, getInitialLanguage, getSystemLanguage } from './locale'
import type { AppLanguage } from './locale'
import { messages } from './messages'

const currentLanguage = shallowRef<AppLanguage>(getInitialLanguage())
export const locale = readonly(currentLanguage)
export const elementLocales = { en, 'zh-CN': zhCn, 'zh-TW': zhTw }
export type MessageKey = keyof typeof messages

export function applyLanguage(language: AppLanguage | null): void {
  currentLanguage.value = language ?? getSystemLanguage()
  document.documentElement.lang = currentLanguage.value
  cacheLanguage(language)
}

export function t(key: MessageKey, parameters: Record<string, string | number> = {}): string {
  const language = currentLanguage.value
  const message = language === 'zh-CN' ? key : messages[key][language === 'en' ? 0 : 1]
  return message.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
    parameters[name] === undefined ? placeholder : String(parameters[name]),
  )
}

function isMessageKey(message: string): message is MessageKey {
  return Object.hasOwn(messages, message)
}

export function localizeMessage(message: string): string
export function localizeMessage(message: string | undefined): string | undefined
export function localizeMessage(message: string | undefined): string | undefined {
  return message !== undefined && isMessageKey(message) ? t(message) : message
}
