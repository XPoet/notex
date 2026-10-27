// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url))
const versionFiles = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notex-release-'))
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'src-tauri'))
  mkdirSync(join(root, 'bin'))
  copyFileSync(script, join(root, 'scripts/release.mjs'))
  writeFileSync(join(root, 'package.json'), '{\n  "version": "0.0.7"\n}\n')
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), '{\n  "version": "0.0.7"\n}\n')
  writeFileSync(
    join(root, 'src-tauri/Cargo.toml'),
    '[package]\nname = "NoteX"\nversion = "0.0.7"\n\n[dependencies]\ntauri = "2"\n',
  )
  writeFileSync(
    join(root, 'src-tauri/Cargo.lock'),
    'version = 4\n\n[[package]]\nname = "NoteX"\nversion = "0.0.7"\n\n[[package]]\nname = "tauri"\nversion = "2.11.5"\n',
  )
  writeFileSync(join(root, '.gitignore'), 'build-invocation.txt\n')
  writeFileSync(
    join(root, 'bin/pnpm'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > build-invocation.txt\nexit "\${RELEASE_TEST_EXIT:-0}"\n`,
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Release Test',
    GIT_AUTHOR_EMAIL: 'release-test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test',
    GIT_COMMITTER_EMAIL: 'release-test@example.invalid',
  }
  function git(...args: string[]) {
    return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim()
  }
  git('init', '--initial-branch=main')
  git('add', '.')
  git('commit', '-m', 'initial')
  function run(args: string[] = [], exitCode = '0') {
    return spawnSync(process.execPath, ['scripts/release.mjs', ...args], {
      cwd: root,
      env: { ...env, RELEASE_TEST_EXIT: exitCode },
      encoding: 'utf8',
    })
  }
  return { root, git, run }
}

describe('版本发布命令', () => {
  it.each([
    [[], '0.0.8'],
    [['patch'], '0.0.8'],
    [['minor'], '0.1.0'],
    [['major'], '1.0.0'],
    [['1.2.3'], '1.2.3'],
  ])('发布 %j 后同步版本并仅提交四个版本文件', (args, version) => {
    const { root, git, run } = fixture()
    const result = run(args)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(git('log', '-1', '--format=%s')).toBe(`chore(release): v${version}`)
    expect(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n')).toEqual(
      [...versionFiles].sort(),
    )
    for (const path of versionFiles) {
      expect(readFileSync(join(root, path), 'utf8')).toContain(`"${version}"`)
    }
    expect(readFileSync(join(root, 'src-tauri/Cargo.lock'), 'utf8')).toContain(
      'name = "tauri"\nversion = "2.11.5"',
    )
    expect(readFileSync(join(root, 'build-invocation.txt'), 'utf8')).toBe('tauri:build:dmg\n')
    expect(git('status', '--porcelain')).toBe('')
    expect(git('tag', '--list')).toBe('')
  })

  it('预览不修改文件、不打包、不创建提交', () => {
    const { git, run } = fixture()
    const before = git('rev-parse', 'HEAD')
    const result = run(['minor', '--dry-run'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('0.0.7 → 0.1.0')
    expect(git('status', '--porcelain', '--ignored')).toBe('')
    expect(git('rev-parse', 'HEAD')).toBe(before)
  })

  it.each(['0.0.7', '0.0.6', '01.0.0', '1.0.0-beta.1', '--skip-check', 'invalid'])(
    '拒绝无效版本或参数 %s',
    (arg) => {
      const { git, run } = fixture()
      expect(run([arg]).status).toBe(1)
      expect(git('status', '--porcelain', '--ignored')).toBe('')
      expect(git('rev-list', '--count', 'HEAD')).toBe('1')
    },
  )

  it.each(['untracked', 'modified', 'staged'])('拒绝 %s 工作区并保留用户改动', (state) => {
    const { root, git, run } = fixture()
    const path = state === 'untracked' ? 'draft.txt' : '.gitignore'
    writeFileSync(join(root, path), 'user changes\n')
    if (state === 'staged') git('add', path)
    const before = git('status', '--porcelain')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('工作区存在未提交或未跟踪的文件')
    expect(git('status', '--porcelain')).toBe(before)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('0.0.7')
  })

  it('版本不一致时在写入和打包前停止', () => {
    const { root, git, run } = fixture()
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), '{\n  "version": "0.0.6"\n}\n')
    git('add', '.')
    git('commit', '-m', 'mismatched version')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('版本不一致')
    expect(git('status', '--porcelain', '--ignored')).toBe('')
  })

  it('检查或打包失败时保留版本改动，不暂存、不提交', () => {
    const { root, git, run } = fixture()
    const before = git('rev-parse', 'HEAD')
    const result = run([], '1')
    expect(result.status).toBe(1)
    expect(git('rev-parse', 'HEAD')).toBe(before)
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('0.0.8')
    expect(result.stderr).toContain('未完成的版本改动会保留')
  })

  it('打包修改了依赖锁文件时停止提交', () => {
    const { root, git, run } = fixture()
    writeFileSync(
      join(root, 'bin/pnpm'),
      "#!/bin/sh\nprintf '\\n# unexpected dependency change\\n' >> src-tauri/Cargo.lock\n",
      { mode: 0o755 },
    )
    git('add', '.')
    git('commit', '-m', 'simulate build changes')
    const before = git('rev-parse', 'HEAD')
    const result = run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('发生额外变化')
    expect(git('rev-parse', 'HEAD')).toBe(before)
    expect(git('diff', '--cached', '--name-only')).toBe('')
  })
})
