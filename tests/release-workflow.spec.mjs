// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)
const scripts = [...workflow.matchAll(/^ {10}script: \|\n((?: {12}.*\n)+)/gm)].map((match) =>
  match[1].replace(/^ {12}/gm, ''),
)

describe('发布工作流的原生脚本入口', () => {
  it('main 推送使用同一发布流程，并跳过自动版本提交', () => {
    expect(workflow).toMatch(/on:\n  push:\n    branches: \[main\]/)
    expect(workflow).not.toMatch(/^  pull_request:/m)
    expect(workflow).toContain("github.event.head_commit.author.name == 'github-actions[bot]'")
    expect(workflow).toContain("startsWith(github.event.head_commit.message, 'chore(release): v')")
    expect(workflow).toContain('ref: ${{ github.sha }}')
    expect(workflow).toContain('          pnpm format:check\n          pnpm lint\n          pnpm test\n')
  })

  it('仅构建 Windows x64 和 macOS Apple Silicon 安装包', () => {
    const targets = [...workflow.matchAll(/^ {12}target: (.+)$/gm)].map((match) => match[1])
    expect(targets).toEqual(['x86_64-pc-windows-msvc', 'aarch64-apple-darwin'])
  })

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
