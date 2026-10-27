import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const files = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function log(message) {
  process.stdout.write(`${message}\n`)
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function replaceOnce(content, pattern, replacement, path) {
  const matches = [...content.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))]
  if (matches.length !== 1) {
    throw new Error(`${path} 的版本字段必须唯一。`)
  }
  return content.replace(pattern, replacement)
}

function packageSection(content, path) {
  const pattern = path.endsWith('.lock')
    ? /\[\[package\]\]\r?\nname = "NoteX"\r?\n[\s\S]*?(?=\r?\n\[\[package\]\]|$)/
    : /^\[package\]\r?\n[\s\S]*?(?=^\[|(?![\s\S]))/m
  const section = content.match(pattern)?.[0]
  if (!section) {
    throw new Error(`${path} 缺少 NoteX 包配置。`)
  }
  return { pattern, section }
}

export function readVersion(content, path) {
  if (path.endsWith('.json')) {
    return JSON.parse(content).version
  }
  const { section } = packageSection(content, path)
  return section.match(/^version = "([^"]+)"\r?$/m)?.[1]
}

export function updateVersion(content, path, version) {
  if (path.endsWith('.json')) {
    return replaceOnce(content, /^(  "version": ")[^"]+("[,]?\r?$)/m, `$1${version}$2`, path)
  }
  const { pattern, section } = packageSection(content, path)
  const updated = replaceOnce(section, /^(version = ")[^"]+("\r?$)/m, `$1${version}$2`, path)
  return replaceOnce(content, pattern, () => updated, path)
}

export function nextVersion(current, target) {
  if (['patch', 'minor', 'major'].includes(target)) {
    const [major, minor, patch] = current.split('.').map(BigInt)
    if (target === 'major') return `${major + 1n}.0.0`
    if (target === 'minor') return `${major}.${minor + 1n}.0`
    return `${major}.${minor}.${patch + 1n}`
  }
  if (!versionPattern.test(target)) {
    throw new Error('版本参数必须是 patch、minor、major 或正式版本号（例如 0.0.8）。')
  }
  const before = current.split('.').map(BigInt)
  const after = target.split('.').map(BigInt)
  const difference = after.findIndex((part, index) => part !== before[index])
  if (difference < 0 || after[difference] < before[difference]) {
    throw new Error(`新版本 ${target} 必须高于当前版本 ${current}。`)
  }
  return target
}

function release() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    log('用法：pnpm release [patch|minor|major|版本号] [--dry-run]（默认 patch）')
    return
  }
  const targets = args.filter((arg) => arg !== '--dry-run')
  if (targets.length > 1 || targets.some((arg) => arg.startsWith('-'))) {
    throw new Error('用法：pnpm release [patch|minor|major|版本号] [--dry-run]')
  }
  if (resolve(git(['rev-parse', '--show-toplevel'])) !== root) {
    throw new Error('发布脚本必须位于 NoteX Git 仓库根目录下。')
  }
  git(['symbolic-ref', '--quiet', 'HEAD'])
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('工作区存在未提交或未跟踪的文件，请先提交当前改动再发布。')
  }

  const contents = files.map((path) => readFileSync(resolve(root, path), 'utf8'))
  const current = readVersion(contents[0], files[0])
  if (typeof current !== 'string' || !versionPattern.test(current)) {
    throw new Error('当前版本必须是正式版本号（例如 0.0.7）。')
  }
  files.forEach((path, index) => {
    if (readVersion(contents[index], path) !== current) {
      throw new Error(`${path} 与 package.json 的版本不一致，请先修正。`)
    }
  })
  const version = nextVersion(current, targets[0] ?? 'patch')
  const updated = files.map((path, index) => updateVersion(contents[index], path, version))
  const message = `chore(release): v${version}`
  log(`发布版本：${current} → ${version}`)
  log(`版本文件：${files.join('、')}`)
  log('检查与打包：pnpm tauri:build:dmg（含完整前端与 Rust 检查）')
  log(`Git 提交：${message}`)
  if (args.includes('--dry-run')) return

  files.forEach((path, index) => writeFileSync(resolve(root, path), updated[index]))
  execFileSync('pnpm', ['tauri:build:dmg'], { cwd: root, stdio: 'inherit' })
  files.forEach((path, index) => {
    if (readFileSync(resolve(root, path), 'utf8') !== updated[index]) {
      throw new Error(`${path} 在检查或打包期间发生额外变化，已停止提交。`)
    }
  })
  const changed = git(['diff', 'HEAD', '--name-only']).split('\n')
  if (changed.some((path) => !files.includes(path))) {
    throw new Error('检查或打包期间修改了版本文件以外的受管文件，已停止提交。')
  }
  execFileSync('git', ['add', '--', ...files], { cwd: root, stdio: 'inherit' })
  execFileSync('git', ['commit', '-m', message, '--', ...files], {
    cwd: root,
    stdio: 'inherit',
  })
  log(`发布完成：v${version}，提交 ${git(['rev-parse', '--short', 'HEAD'])}`)
  log('DMG 位于 src-tauri/target/release/bundle/dmg/；未创建标签或推送远程。')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    release()
  } catch (error) {
    process.stderr.write(`发布失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('未完成的版本改动会保留，请检查 git status 后处理；修正后可重新发布。\n')
    process.exitCode = 1
  }
}
