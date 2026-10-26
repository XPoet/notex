<script setup lang="ts">
import { computed } from 'vue'
import { createSearchPattern } from '@/features/search/highlight'

const props = defineProps<{
  text: string
  query?: string
}>()

interface TextPart {
  text: string
  matched: boolean
}

const parts = computed<TextPart[]>(() => {
  const pattern = createSearchPattern(props.query ?? '')
  if (pattern === undefined) return [{ text: props.text, matched: false }]

  const result: TextPart[] = []
  let position = 0
  for (const match of props.text.matchAll(pattern)) {
    if (match.index > position) {
      result.push({ text: props.text.slice(position, match.index), matched: false })
    }
    result.push({ text: match[0], matched: true })
    position = match.index + match[0].length
  }
  if (position < props.text.length) {
    result.push({ text: props.text.slice(position), matched: false })
  }
  return result
})
</script>

<template>
  <template v-for="(part, index) in parts" :key="index">
    <mark v-if="part.matched" class="search-highlight">{{ part.text }}</mark>
    <template v-else>{{ part.text }}</template>
  </template>
</template>

<style scoped lang="scss">
.search-highlight {
  border-radius: 2px;
  background: color-mix(in srgb, var(--color-accent) 35%, var(--color-canvas));
  color: var(--color-text-primary);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--color-accent) 65%, transparent);
}
</style>
