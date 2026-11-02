export interface ContentStatistics {
  words: number
  characters: number
  lines: number
}

function isWhitespace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

export function countContent(content: string): ContentStatistics {
  let words = 0
  let characters = 0
  let lines = 1
  let inLatinWord = false
  let previousCarriageReturn = false
  for (let index = 0; index < content.length; index += 1) {
    const code = content.codePointAt(index) ?? 0
    if (code > 0xffff) index += 1
    const isCjk = code >= 0x3400 && code <= 0x9fff
    const isLatinWord =
      (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95
    if (isCjk || (isLatinWord && !inLatinWord)) words += 1
    inLatinWord = isLatinWord
    if (!isWhitespace(code)) characters += 1
    if (code === 13 || (code === 10 && !previousCarriageReturn)) lines += 1
    previousCarriageReturn = code === 13
  }
  return { words, characters, lines }
}
