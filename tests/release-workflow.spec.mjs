// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n')
const scripts = [...workflow.matchAll(/^ {10}script: \|\n((?: {12}.*\n)+)/gm)].map((match) =>
  match[1].replace(/^ {12}/gm, ''),
)

describe('发布工作流的原生脚本入口', () => {
  it('覆盖准备、上传和公开发布三个入口', () => {
    expect(scripts).toHaveLength(3)
  })

  it.each(['prepareRelease', 'uploadInstallers', 'publishRelease'])(
    '%s 在当前平台及含特殊字符的工作区中加载 ESM 并传递发布参数',
    (name) => {
      const root = mkdtempSync(join(tmpdir(), 'notex release #%-'))
      mkdirSync(join(root, 'scripts'))
      writeFileSync(
        join(root, 'scripts/github-release.mjs'),
        ['prepareRelease', 'uploadInstallers', 'publishRelease']
          .map(
            (entry) =>
              `export async function ${entry}({ core, releaseId, commitSha, target }) { core.calls.push({ name: '${entry}', releaseId, commitSha, target }) }`,
          )
          .join('\n'),
      )
      const script = scripts.find((source) => source.includes(`const { ${name} }`))
      expect(script).toBeDefined()
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `const github = {}; const context = {}; const core = { calls: [] };\n${script}\nprocess.stdout.write(JSON.stringify(core.calls))`,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: root,
            RELEASE_ID: '123',
            RELEASE_COMMIT: 'a'.repeat(40),
            RELEASE_TARGET: 'x86_64-pc-windows-msvc',
          },
        },
      )
      const call = { name }
      if (name !== 'prepareRelease') {
        call.releaseId = '123'
        call.commitSha = 'a'.repeat(40)
      }
      if (name === 'uploadInstallers') call.target = 'x86_64-pc-windows-msvc'
      expect(JSON.parse(output)).toEqual([call])
    },
  )
})
