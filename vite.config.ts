import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { codeInspectorPlugin } from 'code-inspector-plugin'

const elementPlusStyles = [
  'base',
  'button',
  'dialog',
  'empty',
  'icon',
  'image-viewer',
  'input',
  'message',
  'message-box',
  'option',
  'popover',
  'scrollbar',
  'select',
  'splitter',
  'splitter-panel',
  'table',
  'table-column',
  'tag',
  'tree',
]

export default defineConfig({
  optimizeDeps: {
    // 组件插件在转换模板时才生成这些导入；提前优化可避免冷启动时多次刷新。
    include: ['element-plus/es', ...elementPlusStyles.map((name) => `element-plus/es/components/${name}/style/index`)],
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: '@use "@/styles/element/index.scss" as *;',
      },
    },
  },
  plugins: [
    vue(),
    AutoImport({
      dts: false,
      resolvers: [ElementPlusResolver({ importStyle: 'sass' })],
    }),
    Components({
      resolvers: [ElementPlusResolver({ importStyle: 'sass' })],
    }),
    codeInspectorPlugin({
      bundler: 'vite',
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
})
