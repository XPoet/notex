import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/es/components/message/style/index'
import 'element-plus/es/components/message-box/style/index'
import App from './App.vue'
import router from './router'
import './styles/element/dark.scss'
import './styles/global.scss'
import { locale } from './i18n'

document.documentElement.lang = locale.value

createApp(App).use(createPinia()).use(router).mount('#app')
