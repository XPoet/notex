export function createSearchPattern(query: string): RegExp | undefined {
  const terms = [...new Set(query.split(/\s+/u).filter((term) => term !== ''))].sort(
    (left, right) => right.length - left.length,
  )
  if (terms.length === 0) return undefined

  return new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'giu',
  )
}
