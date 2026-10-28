import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { files as versionFiles, nextVersion, readVersion, updateVersion } from './release.mjs'

function sourceFiles(root = process.cwd()) {
  return versionFiles.map((path) => readFileSync(resolve(root, path), 'utf8'))
}

function commonVersion(contents) {
  const version = readVersion(contents[0], versionFiles[0])
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json 必须使用正式版本号，例如 0.0.10。')
  }
  for (const [index, path] of versionFiles.entries()) {
    if (readVersion(contents[index], path) !== version) {
      throw new Error(`${path} 与 package.json 的版本不一致。`)
    }
  }
  return version
}

export function readReleaseVersion(root) {
  return commonVersion(sourceFiles(root))
}

function compareVersions(left, right) {
  const before = left.split('.').map(BigInt)
  const after = right.split('.').map(BigInt)
  const index = before.findIndex((part, position) => part !== after[position])
  return index < 0 ? 0 : before[index] > after[index] ? 1 : -1
}

function tagVersion(tag) {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag) ? tag.slice(1) : null
}

function reservedReleaseVersion(release) {
  const version = tagVersion(release.tag_name)
  if (version) return version
  if (release.draft && /^untagged-[a-f0-9]+$/.test(release.tag_name)) {
    return tagVersion(release.name?.replace(/^NoteX /, ''))
  }
  return null
}

export function expectedAssets(version) {
  return [
    `NoteX_${version}_windows_x64-setup.exe`,
    `NoteX_${version}_windows_x64.msi`,
    `NoteX_${version}_macos_aarch64.dmg`,
  ]
}

function releaseCommit(context) {
  if (context.eventName === 'push') {
    if (context.payload.ref !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(context.sha ?? '')) {
      throw new Error('只允许发布推送到 main 的有效提交。')
    }
    return context.sha
  }
  const pr = context.payload.pull_request
  if (
    !pr?.merged ||
    pr.base.ref !== 'main' ||
    pr.head.ref !== 'develop' ||
    pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
    !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? '')
  ) {
    throw new Error('只允许发布本仓库 develop 合并到 main 后的提交。')
  }
  return pr.merge_commit_sha
}

async function getTag(github, repo, tag) {
  try {
    return (await github.rest.git.getRef({ ...repo, ref: `tags/${tag}` })).data
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

function checkTag(ref, tag, sha) {
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== sha)) {
    throw new Error(`${tag} 与本次发布提交不一致，停止发布。`)
  }
}

function sourceMarker(sha) {
  return `<!-- notex-release-source: ${sha} -->`
}

function checkRelease(release, tag, sourceSha) {
  if (release.tag_name !== tag || !release.body?.includes(sourceMarker(sourceSha))) {
    throw new Error(`${tag} 与本次合并来源不一致，停止发布。`)
  }
}

function commitMessage(version, sourceSha) {
  return `chore(release): v${version}\n\nNoteX-Release-Source: ${sourceSha}`
}

async function mainState(github, repo, sourceSha, contents) {
  const { data: ref } = await github.rest.git.getRef({ ...repo, ref: 'heads/main' })
  const sha = ref.object.sha
  const files =
    sha === sourceSha
      ? contents
      : await Promise.all(
          versionFiles.map(async (path) => {
            const { data } = await github.rest.repos.getContent({ ...repo, path, ref: sha })
            if (data.encoding !== 'base64' || typeof data.content !== 'string') {
              throw new Error(`无法读取 main 中的 ${path}。`)
            }
            return Buffer.from(data.content, 'base64').toString('utf8')
          }),
        )
  return { sha, files, version: commonVersion(files) }
}

async function versionCommit(github, repo, parent, contents, version, sourceSha) {
  const { data: base } = await github.rest.git.getCommit({ ...repo, commit_sha: parent })
  const { data: tree } = await github.rest.git.createTree({
    ...repo,
    base_tree: base.tree.sha,
    tree: versionFiles.map((path, index) => ({
      path,
      mode: '100644',
      type: 'blob',
      content: updateVersion(contents[index], path, version),
    })),
  })
  const identity = {
    name: 'github-actions[bot]',
    email: '41898282+github-actions[bot]@users.noreply.github.com',
    date: base.committer.date,
  }
  const { data: commit } = await github.rest.git.createCommit({
    ...repo,
    message: commitMessage(version, sourceSha),
    tree: tree.sha,
    parents: [parent],
    author: identity,
    committer: identity,
  })
  return commit.sha
}

async function syncMainVersion({ github, repo, core, state, version, sourceSha, snapshotSha, contents }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (compareVersions(state.version, version) >= 0) return
    const sha =
      state.sha === sourceSha
        ? snapshotSha
        : await versionCommit(github, repo, state.sha, state.files, version, sourceSha)
    try {
      await github.rest.git.updateRef({ ...repo, ref: 'heads/main', sha, force: false })
      core.info(`main 已同步自动版本 ${version}。`)
      return
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === 2) {
        throw new Error('自动版本提交写入 main 失败，请检查 Actions 写入权限和 main 分支保护规则。', { cause: error })
      }
      const current = await mainState(github, repo, sourceSha, contents)
      if (current.sha === state.sha) {
        throw new Error('main 拒绝自动版本提交，请允许发布机器人写入版本文件后重跑工作流。', {
          cause: error,
        })
      }
      state = current
    }
  }
}

function downloadsTable(version, context) {
  const assets = expectedAssets(version)
  const base = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/releases/download/v${version}`
  return [
    '从下表或页面底部的 **Assets** 下载安装包，无需自行编译。',
    '',
    '| 平台 | 下载 |',
    '| --- | --- |',
    `| Windows x64 | [安装程序 EXE](${base}/${assets[0]}) · [MSI](${base}/${assets[1]}) |`,
    `| macOS Apple Silicon（M 系列） | [DMG](${base}/${assets[2]}) |`,
  ].join('\n')
}

const downloadsStart = '<!-- notex-downloads:start -->'
const downloadsEnd = '<!-- notex-downloads:end -->'

function releaseBody(sourceSha) {
  return [
    sourceMarker(sourceSha),
    '',
    downloadsStart,
    '安装包正在构建或校验，当前版本尚未公开发布。请等待 Actions 全部成功，Draft 标记消失后再下载。',
    downloadsEnd,
    '',
    'macOS：打开 DMG，将 NoteX 拖入“应用程序”。当前采用 ad-hoc 签名，未经 Apple 公证；首次打开被阻止时，可在系统设置 → 隐私与安全性中确认来源后选择“仍要打开”。',
    'Windows：运行 EXE 或 MSI 安装。当前未配置代码签名证书，系统可能显示未知发布者或 SmartScreen 提示。首次安装可能需要联网安装 WebView2 Runtime。',
    '',
    '`SHA256SUMS.txt` 提供所有安装包的 SHA-256 校验值。GitHub 自动生成的 Source code 文件是源码，不是安装包。',
    '',
  ].join('\n')
}

function publishedReleaseBody(release, version, context) {
  const start = release.body.indexOf(downloadsStart)
  const end = release.body.indexOf(downloadsEnd, start)
  if (start < 0 || end < start) throw new Error('草稿缺少下载状态标记，停止发布。')
  return release.body.slice(0, start) + downloadsTable(version, context) + release.body.slice(end + downloadsEnd.length)
}

async function verifyDownloads(version, context, fetchUrl, core, wait) {
  const base = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/releases/download/v${version}`
  for (const name of [...expectedAssets(version), 'SHA256SUMS.txt']) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetchUrl(`${base}/${name}`, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) break
      if (attempt === 3) throw new Error(`${name} 的公开下载链接返回 HTTP ${response.status}。`)
      await wait(3000)
    }
    core.info(`公开下载链接已验证：${name}。`)
  }
}

export async function prepareRelease({ github, context, core, root }) {
  const sourceSha = releaseCommit(context)
  const contents = sourceFiles(root)
  const currentVersion = commonVersion(contents)
  const repo = context.repo
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 })
  const matches = releases.filter((item) => item.body?.includes(sourceMarker(sourceSha)))
  if (matches.length > 1) throw new Error('本次合并存在多个 Release 记录，请检查仓库后重跑。')
  let release = matches[0]
  if (!release) {
    const recorded = releases
      .filter(
        (item) => reservedReleaseVersion(item) && /<!-- notex-release-source: [a-f0-9]{40} -->/.test(item.body ?? ''),
      )
      .sort((left, right) => compareVersions(reservedReleaseVersion(right), reservedReleaseVersion(left)))[0]
    if (recorded) {
      const head = recorded.body.match(/<!-- notex-release-source: ([a-f0-9]{40}) -->/)[1]
      const { data: comparison } = await github.rest.repos.compareCommits({
        ...repo,
        base: sourceSha,
        head,
      })
      if (['ahead', 'identical'].includes(comparison.status)) {
        core.info(`本次合并已包含在 ${recorded.tag_name} 对应的更新中，跳过过期发布。`)
        core.setOutput('should_build', 'false')
        return
      }
      if (comparison.status !== 'behind') throw new Error('本次合并与已有发布历史分叉，停止自动分配版本。')
    }
  }
  const state = release && !release.draft ? null : await mainState(github, repo, sourceSha, contents)
  let version = release ? reservedReleaseVersion(release) : null
  let sha
  if (release && !version) throw new Error('已有 Release 使用了无效的正式版本标签。')
  if (!release) {
    const { data: refs } = await github.rest.git.listMatchingRefs({ ...repo, ref: 'tags/v' })
    const versions = [
      currentVersion,
      state.version,
      ...releases.map(reservedReleaseVersion),
      ...refs.map((item) => tagVersion(item.ref.replace('refs/tags/', ''))),
    ].filter((item) => item !== null)
    const baseline = versions.reduce((highest, item) => (compareVersions(item, highest) > 0 ? item : highest))
    version = nextVersion(baseline, 'patch')
    sha = await versionCommit(github, repo, sourceSha, contents, version, sourceSha)
    release = (
      await github.rest.repos.createRelease({
        ...repo,
        tag_name: `v${version}`,
        target_commitish: sha,
        name: `NoteX v${version}`,
        body: releaseBody(sourceSha),
        draft: true,
        prerelease: false,
        generate_release_notes: true,
      })
    ).data
  }
  const tag = `v${version}`
  const needsTagBinding = release.draft && release.tag_name !== tag
  checkRelease(needsTagBinding ? { ...release, tag_name: tag } : release, tag, sourceSha)
  const ref = await getTag(github, repo, tag)
  if (ref) {
    if (ref.object.type !== 'commit') throw new Error(`${tag} 不是自动发布的提交标签。`)
    sha = ref.object.sha
    const { data: snapshot } = await github.rest.git.getCommit({ ...repo, commit_sha: sha })
    if (
      snapshot.parents.length !== 1 ||
      snapshot.parents[0].sha !== sourceSha ||
      snapshot.message !== commitMessage(version, sourceSha)
    ) {
      throw new Error(`${tag} 与本次合并的版本快照不一致，停止发布。`)
    }
  } else {
    if (!release.draft) throw new Error(`${tag} 已发布但缺少版本标签，请检查仓库。`)
    sha ??= await versionCommit(github, repo, sourceSha, contents, version, sourceSha)
    if (![sourceSha, sha].includes(release.target_commitish))
      throw new Error('草稿 Release 的目标提交被修改，停止发布。')
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha })
  }
  if (!ref || needsTagBinding) {
    if (needsTagBinding && release.target_commitish !== sha)
      throw new Error('草稿 Release 的目标提交被修改，停止发布。')
    // 创建标签后 GitHub 可能将先前的草稿改为 untagged-*，显式重新绑定正式标签。
    release = (
      await github.rest.repos.updateRelease({
        ...repo,
        release_id: release.id,
        tag_name: tag,
        target_commitish: sha,
      })
    ).data
    checkRelease(release, tag, sourceSha)
  }
  if (release.draft)
    await syncMainVersion({
      github,
      repo,
      core,
      state,
      version,
      sourceSha,
      snapshotSha: sha,
      contents,
    })
  else core.info(`${tag} 已发布，跳过重复构建和上传。`)
  core.setOutput('release_id', String(release.id))
  core.setOutput('tag_name', tag)
  core.setOutput('commit_sha', sha)
  core.setOutput('should_build', String(release.draft))
}

export async function uploadInstallers({ github, context, core, releaseId, commitSha, target, root }) {
  const sourceSha = releaseCommit(context)
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new Error('缺少有效的发布提交。')
  const version = readReleaseVersion(root)
  const names = expectedAssets(version)
  const targets = {
    'x86_64-pc-windows-msvc': [
      ['nsis', '-setup.exe', names[0]],
      ['msi', '.msi', names[1]],
    ],
    'aarch64-apple-darwin': [['dmg', '.dmg', names[2]]],
  }
  const installers = targets[target]
  if (!Object.hasOwn(targets, target)) throw new Error('不支持的安装包构建目标。')
  const id = Number(releaseId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('缺少有效的 Release ID。')
  const repo = context.repo
  const { data: release } = await github.rest.repos.getRelease({ ...repo, release_id: id })
  const tag = `v${version}`
  const ref = await getTag(github, repo, tag)
  if (!ref) throw new Error(`${tag} 缺少版本标签，停止上传。`)
  checkTag(ref, tag, commitSha)
  checkRelease(release, tag, sourceSha)
  if (!release.draft) throw new Error('Release 已公开发布，禁止继续上传安装包。')
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: id,
    per_page: 100,
  })
  for (const [bundle, extension, name] of installers) {
    const existing = assets.find((item) => item.name === name)
    if (existing) {
      if (existing.state !== 'uploaded' || existing.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(existing.digest ?? '')) {
        throw new Error(`${name} 已存在但不完整，请修复后合并新的 PR 自动发布新版本。`)
      }
      core.info(`复用已上传的 ${name}。`)
      continue
    }
    const directory = resolve(root ?? process.cwd(), 'src-tauri/target', target, 'release/bundle', bundle)
    const files = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(extension),
    )
    if (files.length !== 1) throw new Error(`${bundle} 必须恰好生成一个 ${extension} 安装包。`)
    const data = readFileSync(resolve(directory, files[0].name))
    if (data.length === 0) throw new Error(`${name} 是空文件，停止上传。`)
    const { data: uploaded } = await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: id,
      name,
      data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': data.length },
    })
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (uploaded.state !== 'uploaded' || uploaded.digest !== digest) {
      throw new Error(`${name} 上传后的 SHA-256 校验失败，停止发布。`)
    }
  }
}

export async function publishRelease({
  github,
  context,
  core,
  releaseId,
  commitSha,
  root,
  fetchUrl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const sourceSha = releaseCommit(context)
  if (!/^[a-f0-9]{40}$/.test(commitSha ?? '')) throw new Error('缺少有效的发布提交。')
  const version = readReleaseVersion(root)
  const tag = `v${version}`
  const id = Number(releaseId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('缺少有效的 Release ID。')
  const repo = context.repo
  const { data: release } = await github.rest.repos.getRelease({ ...repo, release_id: id })
  const ref = await getTag(github, repo, tag)
  if (!ref) throw new Error(`${tag} 缺少版本标签，停止发布。`)
  checkTag(ref, tag, commitSha)
  checkRelease(release, tag, sourceSha)
  if (!release.draft) {
    await verifyDownloads(version, context, fetchUrl, core, wait)
    core.info(`${tag} 已发布，公开下载链接检查通过。`)
    return
  }
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, {
    ...repo,
    release_id: id,
    per_page: 100,
  })
  const checksums = expectedAssets(version).map((name) => {
    const asset = assets.find((item) => item.name === name)
    if (!asset || asset.state !== 'uploaded' || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`安装包 ${name} 缺失、未上传完成或缺少 SHA-256 校验值，保持草稿状态。`)
    }
    return `${asset.digest.slice(7)}  ${name}\n`
  })
  const data = Buffer.from(checksums.join(''))
  const body = publishedReleaseBody(release, version, context)
  const checksum = assets.find((item) => item.name === 'SHA256SUMS.txt')
  if (checksum) {
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (checksum.state !== 'uploaded' || checksum.digest !== digest) {
      throw new Error('草稿中的 SHA256SUMS.txt 与安装包不一致，停止发布。')
    }
  } else {
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: id,
      name: 'SHA256SUMS.txt',
      data,
      headers: { 'content-type': 'text/plain', 'content-length': data.length },
    })
  }
  const { data: published } = await github.rest.repos.updateRelease({
    ...repo,
    release_id: id,
    draft: false,
    prerelease: false,
    make_latest: 'legacy',
    body,
  })
  checkRelease(published, tag, sourceSha)
  if (published.draft) throw new Error(`${tag} 仍为草稿，停止下载验收。`)
  await verifyDownloads(version, context, fetchUrl, core, wait)
  core.info(`已发布 ${tag}：${release.html_url}`)
}
