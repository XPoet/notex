import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const elementPlusStylePath = resolve(process.cwd(), 'src/styles/_element-plus.scss')
const elementPlusStyles = readFileSync(elementPlusStylePath, 'utf8')
const entryPath = resolve(process.cwd(), 'src/main.ts')
const entrySource = readFileSync(entryPath, 'utf8')
const elementThemePath = resolve(process.cwd(), 'src/styles/element/index.scss')
const elementThemeSource = readFileSync(elementThemePath, 'utf8')
const elementDarkThemePath = resolve(process.cwd(), 'src/styles/element/dark.scss')
const elementDarkThemeSource = readFileSync(elementDarkThemePath, 'utf8')
const viteConfigPath = resolve(process.cwd(), 'vite.config.ts')
const viteConfigSource = readFileSync(viteConfigPath, 'utf8')

describe('Element Plus 编程式服务样式', () => {
  it('加载确认框和提示消息的按需 Sass 样式，并提供可见的遮罩与输入框样式', () => {
    expect(entrySource).toContain("import 'element-plus/es/components/message-box/style/index'")
    expect(entrySource).toContain("import 'element-plus/es/components/message/style/index'")
    expect(elementPlusStyles).toContain('.el-overlay-message-box')
    expect(elementPlusStyles).toContain('.el-message-box__input .el-input__wrapper')
  })

  it('通过 Sass 变量生成 Element Plus 主题样式', () => {
    expect(elementThemeSource).toContain("@forward 'element-plus/theme-chalk/src/common/var.scss' with")
    expect(elementThemeSource).toContain("'primary':")
    expect(elementThemeSource).toContain('$font-family:')
    expect(elementDarkThemeSource).toContain("@forward 'element-plus/theme-chalk/src/dark/var.scss' with")
    expect(elementDarkThemeSource).toContain("@use 'element-plus/theme-chalk/src/dark/css-vars.scss';")
    expect(entrySource).toContain("import './styles/element/dark.scss'")
    expect(viteConfigSource).toContain("importStyle: 'sass'")
    expect(viteConfigSource).toContain('additionalData: \'@use "@/styles/element/index.scss" as *;\'')
  })
})
