<script setup lang="ts">
import { storeToRefs } from 'pinia'
import AppBootstrap from './app/AppBootstrap.vue'
import { useAppStore } from './stores/app'
import { useApplicationClose } from './composables/useApplicationClose'
import { elementLocales, locale } from './i18n'

useApplicationClose()

const appStore = useAppStore()
const { status } = storeToRefs(appStore)
</script>

<template>
  <el-config-provider :locale="elementLocales[locale]">
    <AppBootstrap v-if="status !== 'ready'" />
    <RouterView v-else />
  </el-config-provider>
</template>
