// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  expectedAssets,
  prepareRelease,
  publishRelease,
  readReleaseVersion,
  uploadInstallers,
} from '../scripts/github-release.mjs'

const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const snapshotSha = 'c'.repeat(40)
const version = '0.0.10'
const versionPaths = [
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notex-github-release-'))
  mkdirSync(join(root, 'src-tauri'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`)
  writeFileSync(
    join(root, 'src-tauri/tauri.conf.json'),
    `${JSON.stringify({ version }, null, 2)}\n`,
  )
  writeFileSync(
    join(root, 'src-tauri/Cargo.toml'),
    `[package]\nname = "NoteX"\nversion = "${version}"\n\n[dependencies]\nother = "1"\n`,
  )
  writeFileSync(
    join(root, 'src-tauri/Cargo.lock'),
    `version = 4\n\n[[package]]\nname = "NoteX"\nversion = "${version}"\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n`,
  )
  const release = {
    id: 123,
    tag_name: `v${version}`,
    target_commitish: snapshotSha,
    body: `<!-- notex-release-source: ${sha} -->\n\n<!-- notex-downloads:start -->\n安装包正在构建或校验\n<!-- notex-downloads:end -->\n\n## What's Changed\nRelease notes`,
    draft: true,
    html_url: `https://github.com/XPoet/notex/releases/tag/v${version}`,
  }
  const assets = expectedAssets(version).map((name) => ({
    name,
    size: 100,
    state: 'uploaded',
    digest: `sha256:${'1'.repeat(64)}`,
  }))
  const initialFiles = Object.fromEntries(
    versionPaths.map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  )
  initialFiles['src/feature.txt'] = 'original application code'
  const date = '2026-10-20T01:00:00Z'
  const commits = new Map([
    [
      sha,
      {
        sha,
        message: 'merged develop',
        tree: { sha: 'source-tree' },
        parents: [],
        committer: { date },
        files: initialFiles,
      },
    ],
    [
      snapshotSha,
      {
        sha: snapshotSha,
        message: `chore(release): v${version}\n\nNoteX-Release-Source: ${sha}`,
        tree: { sha: 'snapshot-tree' },
        parents: [{ sha }],
        committer: { date },
        files: initialFiles,
      },
    ],
  ])
  const trees = new Map([
    ['source-tree', initialFiles],
    ['snapshot-tree', initialFiles],
  ])
  const refs = new Map([
    ['heads/main', sha],
    [`tags/v${version}`, snapshotSha],
  ])
  const releases = []
  function advanceMain(newVersion = version, changes = {}) {
    const parent = refs.get('heads/main')
    const files = { ...initialFiles, ...changes }
    for (const path of versionPaths)
      files[path] = files[path].replace(`"${version}"`, `"${newVersion}"`)
    const commitSha = createHash('sha1').update(JSON.stringify({ parent, files })).digest('hex')
    const treeSha = `${commitSha}-tree`
    trees.set(treeSha, files)
    commits.set(commitSha, {
      sha: commitSha,
      message: 'another main commit',
      tree: { sha: treeSha },
      parents: [{ sha: parent }],
      committer: { date },
      files,
    })
    refs.set('heads/main', commitSha)
    return commitSha
  }
  const github = {
    rest: {
      git: {
        getRef: vi.fn().mockImplementation(async ({ ref }) => {
          if (!refs.has(ref)) throw Object.assign(new Error('Not found'), { status: 404 })
          return { data: { object: { type: 'commit', sha: refs.get(ref) } } }
        }),
        listMatchingRefs: vi.fn().mockImplementation(async ({ ref }) => ({
          data: [...refs]
            .filter(([name]) => name.startsWith(ref))
            .map(([name, value]) => ({
              ref: `refs/${name}`,
              object: { type: 'commit', sha: value },
            })),
        })),
        getCommit: vi.fn().mockImplementation(async ({ commit_sha }) => {
          const commit = commits.get(commit_sha)
          if (!commit) throw new Error('Unknown commit')
          return { data: commit }
        }),
        createTree: vi.fn().mockImplementation(async ({ base_tree, tree }) => {
          const files = { ...trees.get(base_tree) }
          for (const entry of tree) files[entry.path] = entry.content
          const treeSha = createHash('sha1').update(JSON.stringify(files)).digest('hex')
          trees.set(treeSha, files)
          return { data: { sha: treeSha } }
        }),
        createCommit: vi.fn().mockImplementation(async (args) => {
          const commitSha = createHash('sha1').update(JSON.stringify(args)).digest('hex')
          commits.set(commitSha, {
            sha: commitSha,
            message: args.message,
            tree: { sha: args.tree },
            parents: args.parents.map((parent) => ({ sha: parent })),
            committer: args.committer,
            files: trees.get(args.tree),
          })
          return { data: { sha: commitSha } }
        }),
        createRef: vi.fn().mockImplementation(async ({ ref, sha: value }) => {
          const key = ref.replace('refs/', '')
          if (refs.has(key)) throw Object.assign(new Error('Already exists'), { status: 422 })
          refs.set(key, value)
          for (const draft of releases) {
            if (draft.draft && `tags/${draft.tag_name}` === key) {
              draft.tag_name = `untagged-${draft.id}`
            }
          }
          return { data: { object: { type: 'commit', sha: value } } }
        }),
        updateRef: vi.fn().mockImplementation(async ({ ref, sha: value, force }) => {
          if (
            force ||
            !commits.get(value)?.parents.some((parent) => parent.sha === refs.get(ref))
          ) {
            throw Object.assign(new Error('Not a fast forward'), { status: 422 })
          }
          refs.set(ref, value)
          return { data: { object: { type: 'commit', sha: value } } }
        }),
      },
      repos: {
        compareCommits: vi.fn().mockResolvedValue({ data: { status: 'behind' } }),
        listReleases: vi.fn().mockResolvedValue({ data: releases }),
        createRelease: vi.fn().mockImplementation(async (args) => {
          const created = { ...release, ...args, id: 123 + releases.length }
          releases.push(created)
          Object.assign(release, created)
          return { data: created }
        }),
        getRelease: vi.fn().mockImplementation(async ({ release_id }) => ({
          data: releases.find((item) => item.id === release_id) ?? release,
        })),
        getContent: vi.fn().mockImplementation(async ({ path, ref }) => ({
          data: {
            encoding: 'base64',
            content: Buffer.from(commits.get(ref).files[path]).toString('base64'),
          },
        })),
        listReleaseAssets: vi.fn().mockResolvedValue({ data: assets }),
        uploadReleaseAsset: vi.fn().mockImplementation(async ({ name, data }) => ({
          data: {
            name,
            state: 'uploaded',
            size: data.length,
            digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
          },
        })),
        updateRelease: vi.fn().mockImplementation(async (args) => {
          const current = releases.find((item) => item.id === args.release_id) ?? release
          Object.assign(current, args)
          if (release.id === current.id) Object.assign(release, current)
          return { data: current }
        }),
      },
    },
    paginate: vi.fn(async (method, args) => (await method(args)).data),
  }
  const context = {
    repo: { owner: 'XPoet', repo: 'notex' },
    serverUrl: 'https://github.com',
    payload: {
      pull_request: {
        merged: true,
        merge_commit_sha: sha,
        base: { ref: 'main' },
        head: { ref: 'develop', repo: { full_name: 'XPoet/notex' } },
      },
    },
  }
  const core = { setOutput: vi.fn(), info: vi.fn() }
  const fetchUrl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  return {
    root,
    release,
    releases,
    assets,
    github,
    context,
    core,
    fetchUrl,
    wait: vi.fn().mockResolvedValue(undefined),
    releaseId: '123',
    commitSha: snapshotSha,
    refs,
    commits,
    trees,
    advanceMain,
  }
}

describe('GitHub 自动发布', () => {
  it('发布清单只包含 Windows 和 Apple Silicon 的三个安装包', () => {
    expect(expectedAssets(version)).toEqual([
      `NoteX_${version}_windows_x64-setup.exe`,
      `NoteX_${version}_windows_x64.msi`,
      `NoteX_${version}_macos_aarch64.dmg`,
    ])
  })

  it('使用四个版本文件的共同版本，不修改源文件', () => {
    const { root } = fixture()
    const before = readFileSync(join(root, 'package.json'), 'utf8')
    expect(readReleaseVersion(root)).toBe(version)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  })

  it.each(['src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'])(
    '%s 版本不一致时，在写入 GitHub 之前停止',
    async (path) => {
      const args = fixture()
      const file = join(args.root, path)
      writeFileSync(file, readFileSync(file, 'utf8').replace(version, '0.0.9'))
      await expect(prepareRelease(args)).rejects.toThrow('版本不一致')
      expect(args.github.rest.git.getRef).not.toHaveBeenCalled()
      expect(args.github.rest.repos.createRelease).not.toHaveBeenCalled()
    },
  )

  it.each(['1.0.0-beta.1', '01.0.0', '', null])('拒绝非正式版本 %s', (value) => {
    const { root } = fixture()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: value }))
    expect(() => readReleaseVersion(root)).toThrow('正式版本号')
  })

  it.each(['closed', 'other-head', 'other-base', 'fork', 'missing-sha'])(
    '拒绝不符合发布条件的 PR：%s',
    async (scenario) => {
      const args = fixture()
      const pr = args.context.payload.pull_request
      if (scenario === 'closed') pr.merged = false
      if (scenario === 'other-head') pr.head.ref = 'feature'
      if (scenario === 'other-base') pr.base.ref = 'develop'
      if (scenario === 'fork') pr.head.repo.full_name = 'other/notex'
      if (scenario === 'missing-sha') pr.merge_commit_sha = ''
      await expect(prepareRelease(args)).rejects.toThrow('只允许发布')
      expect(args.github.rest.git.getRef).not.toHaveBeenCalled()
    },
  )

  it('首次合并自动递增 patch，并将四个版本文件提交回 main', async () => {
    const args = fixture()
    await prepareRelease(args)
    const releasedSha = args.refs.get('tags/v0.0.11')
    const snapshot = args.commits.get(releasedSha)
    expect(args.github.rest.repos.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        tag_name: 'v0.0.11',
        draft: true,
        generate_release_notes: true,
        body: expect.stringContaining('当前版本尚未公开发布'),
      }),
    )
    expect(snapshot.parents).toEqual([{ sha }])
    expect(snapshot.files['package.json']).toContain('"version": "0.0.11"')
    expect(snapshot.files['src-tauri/tauri.conf.json']).toContain('"version": "0.0.11"')
    expect(snapshot.files['src-tauri/Cargo.toml']).toContain('version = "0.0.11"')
    expect(snapshot.files['src-tauri/Cargo.lock']).toContain('name = "NoteX"\nversion = "0.0.11"')
    expect(snapshot.files['src-tauri/Cargo.lock']).toContain('name = "other"\nversion = "1.0.0"')
    expect(snapshot.files['src/feature.txt']).toBe('original application code')
    expect(
      args.github.rest.git.createTree.mock.calls[0][0].tree.map((entry) => entry.path),
    ).toEqual(versionPaths)
    expect(args.refs.get('heads/main')).toBe(releasedSha)
    expect(args.refs.get('tags/v' + version)).toBe(snapshotSha)
    expect(args.core.setOutput).toHaveBeenCalledWith('commit_sha', releasedSha)
    expect(args.core.setOutput).toHaveBeenCalledWith('should_build', 'true')
    expect(readFileSync(join(args.root, 'package.json'), 'utf8')).toContain('"version": "0.0.10"')
    expect(args.release.body).not.toContain('/releases/download/')
  })

  it('按照最高的仓库、main、标签和草稿版本分配下一版本', async () => {
    const args = fixture()
    args.refs.set('tags/v0.0.99', otherSha)
    args.releases.push({ tag_name: 'v0.1.4', body: 'another release', draft: true })
    args.advanceMain('0.0.20')
    await prepareRelease(args)
    expect(args.core.setOutput).toHaveBeenCalledWith('tag_name', 'v0.1.5')
  })

  it('失败后重跑复用同一合并的版本和草稿', async () => {
    const args = fixture()
    args.releases.push(args.release)
    await prepareRelease(args)
    expect(args.github.rest.git.createRef).not.toHaveBeenCalled()
    expect(args.github.rest.git.createCommit).not.toHaveBeenCalled()
    expect(args.github.rest.repos.createRelease).not.toHaveBeenCalled()
    expect(args.core.setOutput).toHaveBeenCalledWith('release_id', '123')
    expect(args.core.setOutput).toHaveBeenCalledWith('commit_sha', snapshotSha)
  })

  it('成功准备后重跑不再次递增，仍构建同一版本快照', async () => {
    const args = fixture()
    await prepareRelease(args)
    const first = args.refs.get('tags/v0.0.11')
    await prepareRelease(args)
    expect(args.github.rest.repos.createRelease).toHaveBeenCalledOnce()
    expect(args.github.rest.git.createCommit).toHaveBeenCalledOnce()
    expect(args.refs.get('tags/v0.0.11')).toBe(first)
    expect(args.refs.has('tags/v0.0.12')).toBe(false)
  })

  it('创建标签导致草稿变为 untagged 后重新绑定，后续上传和发布校验通过', async () => {
    const args = fixture()
    await prepareRelease(args)
    const commitSha = args.refs.get('tags/v0.0.11')
    expect(args.github.rest.repos.updateRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        release_id: args.release.id,
        tag_name: 'v0.0.11',
        target_commitish: commitSha,
      }),
    )
    expect(args.release.tag_name).toBe('v0.0.11')
    for (const path of versionPaths)
      writeFileSync(join(args.root, path), args.commits.get(commitSha).files[path])
    for (const [index, asset] of args.assets.entries()) asset.name = expectedAssets('0.0.11')[index]
    await uploadInstallers({ ...args, commitSha, target: 'aarch64-apple-darwin' })
    await publishRelease({ ...args, commitSha })
    expect(args.release.draft).toBe(false)
  })

  it('草稿重新绑定失败后，重跑复用原版本并验证快照后恢复标签', async () => {
    const args = fixture()
    args.github.rest.repos.updateRelease.mockRejectedValueOnce(new Error('Temporary failure'))
    await expect(prepareRelease(args)).rejects.toThrow('Temporary failure')
    expect(args.releases[0].tag_name).toBe(`untagged-${args.release.id}`)
    const reservedSha = args.refs.get('tags/v0.0.11')
    await prepareRelease(args)
    expect(args.release.tag_name).toBe('v0.0.11')
    expect(args.refs.get('heads/main')).toBe(reservedSha)
    expect(args.github.rest.repos.createRelease).toHaveBeenCalledOnce()
    expect(args.github.rest.git.createCommit).toHaveBeenCalledOnce()
    expect(args.refs.has('tags/v0.0.12')).toBe(false)
  })

  it.each(['target', 'source'])('恢复 untagged 草稿时拒绝被修改的 %s', async (scenario) => {
    const args = fixture()
    Object.assign(args.release, {
      tag_name: 'untagged-abc123',
      name: `NoteX v${version}`,
    })
    args.releases.push(args.release)
    if (scenario === 'target') args.release.target_commitish = otherSha
    if (scenario === 'source') args.commits.get(snapshotSha).parents = [{ sha: otherSha }]
    await expect(prepareRelease(args)).rejects.toThrow(
      scenario === 'target' ? '目标提交被修改' : '版本快照不一致',
    )
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
    expect(args.github.rest.git.updateRef).not.toHaveBeenCalled()
  })

  it('创建草稿时目标已是版本快照，服务端提前创建标签也可继续', async () => {
    const args = fixture()
    args.github.rest.repos.createRelease.mockImplementation(async (data) => {
      Object.assign(args.release, data)
      args.releases.push(args.release)
      args.refs.set('tags/' + data.tag_name, data.target_commitish)
      return { data: args.release }
    })
    await prepareRelease(args)
    const target = args.github.rest.repos.createRelease.mock.calls[0][0].target_commitish
    expect(target).not.toBe(sha)
    expect(args.commits.get(target).files['package.json']).toContain('"version": "0.0.11"')
    expect(args.refs.get('heads/main')).toBe(target)
    expect(args.github.rest.git.createRef).not.toHaveBeenCalled()
  })

  it('连续两次合并自动从 0.0.10 递增到 0.0.11、0.0.12', async () => {
    const args = fixture()
    await prepareRelease(args)
    const first = args.refs.get('tags/v0.0.11')
    const secondMerge = args.advanceMain('0.0.11', { 'src/feature.txt': 'next feature' })
    args.context.payload.pull_request.merge_commit_sha = secondMerge
    for (const path of versionPaths)
      writeFileSync(join(args.root, path), args.commits.get(secondMerge).files[path])
    await prepareRelease(args)
    const second = args.commits.get(args.refs.get('tags/v0.0.12'))
    expect(second.parents).toEqual([{ sha: secondMerge }])
    expect(second.files['package.json']).toContain('"version": "0.0.12"')
    expect(second.files['src/feature.txt']).toBe('next feature')
    expect(args.refs.get('tags/v0.0.11')).toBe(first)
    expect(args.releases.map((item) => item.tag_name)).toEqual(['v0.0.11', 'v0.0.12'])
    expect(args.core.setOutput).toHaveBeenCalledWith('tag_name', 'v0.0.12')
  })

  it('创建草稿后标签写入失败，重跑不再次递增版本', async () => {
    const args = fixture()
    args.github.rest.git.createRef.mockRejectedValueOnce(
      Object.assign(new Error('Temporary failure'), { status: 503 }),
    )
    await expect(prepareRelease(args)).rejects.toThrow('Temporary failure')
    const reservedSha = args.release.target_commitish
    await prepareRelease(args)
    expect(args.github.rest.repos.createRelease).toHaveBeenCalledOnce()
    expect(args.release.tag_name).toBe('v0.0.11')
    expect(args.refs.get('tags/v0.0.11')).toBe(reservedSha)
    expect(args.refs.has('tags/v0.0.12')).toBe(false)
  })

  it('版本标签写入后 main 更新失败，重跑继续同步相同版本', async () => {
    const args = fixture()
    args.github.rest.git.updateRef.mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    )
    await expect(prepareRelease(args)).rejects.toThrow('写入 main 失败')
    const reservedSha = args.refs.get('tags/v0.0.11')
    await prepareRelease(args)
    expect(args.github.rest.git.createCommit).toHaveBeenCalledOnce()
    expect(args.github.rest.repos.createRelease).toHaveBeenCalledOnce()
    expect(args.refs.get('heads/main')).toBe(reservedSha)
    expect(args.core.setOutput).toHaveBeenCalledWith('tag_name', 'v0.0.11')
  })

  it('已有标签的提交正确时，不依赖 GitHub 忽略的 target_commitish 字段', async () => {
    const args = fixture()
    args.release.target_commitish = 'develop'
    args.releases.push(args.release)
    await prepareRelease(args)
    await publishRelease(args)
    expect(args.github.rest.repos.updateRelease).toHaveBeenCalledOnce()
  })

  it('已公开发布的相同合并跳过递增、构建和 main 写入', async () => {
    const args = fixture()
    args.release.draft = false
    args.releases.push(args.release)
    await prepareRelease(args)
    expect(args.core.setOutput).toHaveBeenCalledWith('should_build', 'false')
    expect(args.github.rest.repos.createRelease).not.toHaveBeenCalled()
    expect(args.github.rest.git.updateRef).not.toHaveBeenCalled()
  })

  it('拒绝复用来自其他合并的版本快照', async () => {
    const args = fixture()
    args.releases.push(args.release)
    args.commits.get(snapshotSha).parents = [{ sha: otherSha }]
    await expect(prepareRelease(args)).rejects.toThrow('版本快照不一致')
    expect(args.github.rest.git.updateRef).not.toHaveBeenCalled()
  })

  it('草稿尚未创建标签时，拒绝覆盖被修改的目标提交', async () => {
    const args = fixture()
    args.refs.delete('tags/v' + version)
    args.release.target_commitish = otherSha
    args.releases.push(args.release)
    await expect(prepareRelease(args)).rejects.toThrow('目标提交被修改')
    expect(args.github.rest.git.createRef).not.toHaveBeenCalled()
  })

  it('main 已有较新的开发提交时，仅同步版本并保留代码', async () => {
    const args = fixture()
    const advanced = args.advanceMain('0.0.12', { 'src/feature.txt': 'new user code' })
    await prepareRelease(args)
    const snapshot = args.commits.get(args.refs.get('tags/v0.0.13'))
    const main = args.commits.get(args.refs.get('heads/main'))
    expect(snapshot.parents).toEqual([{ sha }])
    expect(snapshot.files['src/feature.txt']).toBe('original application code')
    expect(main.parents).toEqual([{ sha: advanced }])
    expect(main.files['src/feature.txt']).toBe('new user code')
    expect(main.files['package.json']).toContain('"version": "0.0.13"')
    expect(args.github.rest.git.updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    )
  })

  it('版本写入期间 main 再次前进时，重新读取并只提交版本文件', async () => {
    const args = fixture()
    args.github.rest.git.updateRef.mockImplementationOnce(async () => {
      args.advanceMain(version, { 'src/feature.txt': 'concurrent user code' })
      throw Object.assign(new Error('Not a fast forward'), { status: 422 })
    })
    await prepareRelease(args)
    const main = args.commits.get(args.refs.get('heads/main'))
    expect(main.files['src/feature.txt']).toBe('concurrent user code')
    expect(main.files['package.json']).toContain('"version": "0.0.11"')
    expect(args.github.rest.git.updateRef).toHaveBeenCalledTimes(2)
    expect(args.github.rest.git.updateRef.mock.calls.every(([call]) => call.force === false)).toBe(
      true,
    )
  })

  it('旧版本重跑不会降低 main 已有版本', async () => {
    const args = fixture()
    args.releases.push(args.release)
    const advanced = args.advanceMain('0.0.12')
    await prepareRelease(args)
    expect(args.refs.get('heads/main')).toBe(advanced)
    expect(args.github.rest.git.updateRef).not.toHaveBeenCalled()
    expect(args.core.setOutput).toHaveBeenCalledWith('tag_name', 'v' + version)
  })

  it('分支保护拒绝版本提交时停止，不强制覆盖分支', async () => {
    const args = fixture()
    args.github.rest.git.updateRef.mockRejectedValue(
      Object.assign(new Error('Protected branch'), { status: 422 }),
    )
    await expect(prepareRelease(args)).rejects.toThrow('main 拒绝自动版本提交')
    expect(args.github.rest.git.updateRef).toHaveBeenCalledOnce()
    expect(args.core.setOutput).not.toHaveBeenCalled()
  })

  it('同一合并存在多个 Release 标记时停止', async () => {
    const args = fixture()
    args.releases.push(args.release, { ...args.release, id: 456, tag_name: 'v0.0.11' })
    await expect(prepareRelease(args)).rejects.toThrow('多个 Release')
    expect(args.github.rest.git.createCommit).not.toHaveBeenCalled()
  })

  it('较新合并已分配版本时，跳过已被包含的旧合并事件', async () => {
    const args = fixture()
    args.releases.push({
      tag_name: 'v0.0.12',
      body: '<!-- notex-release-source: ' + otherSha + ' -->',
      draft: true,
    })
    args.github.rest.repos.compareCommits.mockResolvedValue({ data: { status: 'ahead' } })
    await prepareRelease(args)
    expect(args.core.setOutput).toHaveBeenCalledWith('should_build', 'false')
    expect(args.github.rest.repos.createRelease).not.toHaveBeenCalled()
    expect(args.github.rest.git.updateRef).not.toHaveBeenCalled()
  })

  it('发布历史已分叉时停止分配版本', async () => {
    const args = fixture()
    args.releases.push({
      tag_name: 'v0.0.12',
      body: '<!-- notex-release-source: ' + otherSha + ' -->',
      draft: false,
    })
    args.github.rest.repos.compareCommits.mockResolvedValue({ data: { status: 'diverged' } })
    await expect(prepareRelease(args)).rejects.toThrow('发布历史分叉')
    expect(args.github.rest.repos.createRelease).not.toHaveBeenCalled()
  })

  it('GitHub 查询失败时保留错误，不当作尚未发布处理', async () => {
    const args = fixture()
    args.github.rest.git.getRef.mockRejectedValue(new Error('GitHub unavailable'))
    await expect(prepareRelease(args)).rejects.toThrow('GitHub unavailable')
    expect(args.github.rest.git.createRef).not.toHaveBeenCalled()
  })

  it.each([
    [
      'x86_64-pc-windows-msvc',
      [
        ['nsis', 'test-setup.exe'],
        ['msi', 'test.msi'],
      ],
      [0, 1],
    ],
    ['aarch64-apple-darwin', [['dmg', 'test.dmg']], [2]],
  ])('上传 %s 的安装包，并验证上传摘要', async (target, bundles, indexes) => {
    const args = fixture()
    args.assets.length = 0
    for (const [bundle, file] of bundles) {
      const directory = join(args.root, 'src-tauri/target', target, 'release/bundle', bundle)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, file), 'installer fixture')
    }
    await uploadInstallers({ ...args, target })
    const uploadedNames = args.github.rest.repos.uploadReleaseAsset.mock.calls.map(
      ([asset]) => asset.name,
    )
    expect(uploadedNames).toEqual(indexes.map((index) => expectedAssets(version)[index]))
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
  })

  it('拒绝上传 macOS Intel 安装包', async () => {
    const args = fixture()
    await expect(uploadInstallers({ ...args, target: 'x86_64-apple-darwin' })).rejects.toThrow(
      '不支持的安装包构建目标',
    )
    expect(args.github.rest.repos.getRelease).not.toHaveBeenCalled()
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
  })

  it('完整附件存在时直接复用，不读取新构建或重新上传', async () => {
    const args = fixture()
    await uploadInstallers({ ...args, target: 'x86_64-pc-windows-msvc' })
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
  })

  it('部分上传后重试时仅补传缺失的安装包', async () => {
    const args = fixture()
    args.assets.splice(1, 1)
    const target = 'x86_64-pc-windows-msvc'
    const directory = join(args.root, 'src-tauri/target', target, 'release/bundle/msi')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'test.msi'), 'installer fixture')
    await uploadInstallers({ ...args, target })
    expect(args.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledOnce()
    expect(args.github.rest.repos.uploadReleaseAsset).toHaveBeenCalledWith(
      expect.objectContaining({ name: expectedAssets(version)[1] }),
    )
  })

  it('不完整的已有附件阻止重试，不替换附件', async () => {
    const args = fixture()
    args.assets[0].state = 'starter'
    await expect(uploadInstallers({ ...args, target: 'x86_64-pc-windows-msvc' })).rejects.toThrow(
      '已存在但不完整',
    )
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
  })

  it('拒绝向已公开的 Release 上传', async () => {
    const args = fixture()
    args.release.draft = false
    await expect(uploadInstallers({ ...args, target: 'aarch64-apple-darwin' })).rejects.toThrow(
      '已公开发布',
    )
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
  })

  it.each(['missing', 'duplicate', 'empty', 'digest-mismatch'])(
    '构建文件 %s 时停止上传流程',
    async (scenario) => {
      const args = fixture()
      args.assets.length = 0
      const target = 'aarch64-apple-darwin'
      const directory = join(args.root, 'src-tauri/target', target, 'release/bundle/dmg')
      mkdirSync(directory, { recursive: true })
      if (scenario !== 'missing')
        writeFileSync(join(directory, 'test.dmg'), scenario === 'empty' ? '' : 'installer fixture')
      if (scenario === 'duplicate') writeFileSync(join(directory, 'test-2.dmg'), 'another fixture')
      if (scenario === 'digest-mismatch')
        args.github.rest.repos.uploadReleaseAsset.mockResolvedValue({
          data: { state: 'uploaded', digest: `sha256:${'0'.repeat(64)}` },
        })
      await expect(uploadInstallers({ ...args, target })).rejects.toThrow()
      expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
    },
  )

  it.each(expectedAssets(version))('缺少 %s 时保持草稿，不上传校验文件或发布', async (name) => {
    const args = fixture()
    args.assets.splice(
      args.assets.findIndex((asset) => asset.name === name),
      1,
    )
    await expect(publishRelease(args)).rejects.toThrow('保持草稿状态')
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
  })

  it.each(['empty', 'unfinished', 'no-digest'])(
    '任一安装包 %s 时保持草稿，不上传校验文件或发布',
    async (scenario) => {
      const args = fixture()
      if (scenario === 'empty') args.assets[0].size = 0
      if (scenario === 'unfinished') args.assets[0].state = 'starter'
      if (scenario === 'no-digest') args.assets[0].digest = null
      await expect(publishRelease(args)).rejects.toThrow('保持草稿状态')
      expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
      expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
    },
  )

  it('三个安装包齐全后生成校验文件，再公开发布', async () => {
    const args = fixture()
    await publishRelease(args)
    const upload = args.github.rest.repos.uploadReleaseAsset
    const publish = args.github.rest.repos.updateRelease
    const data = expectedAssets(version)
      .map((name) => `${'1'.repeat(64)}  ${name}\n`)
      .join('')
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'SHA256SUMS.txt', data: Buffer.from(data) }),
    )
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ draft: false, prerelease: false, make_latest: 'legacy' }),
    )
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0])
    expect(args.release.draft).toBe(false)
    expect(args.release.body).toContain("## What's Changed\nRelease notes")
    expect(args.release.body).not.toContain('安装包正在构建')
    expect(args.release.body).not.toContain('macOS Intel')
    for (const name of expectedAssets(version)) {
      expect(args.release.body).toContain(name)
    }
    for (const name of [...expectedAssets(version), 'SHA256SUMS.txt']) {
      expect(args.fetchUrl).toHaveBeenCalledWith(
        `https://github.com/XPoet/notex/releases/download/v${version}/${name}`,
        expect.objectContaining({ method: 'HEAD', redirect: 'follow' }),
      )
    }
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      args.fetchUrl.mock.invocationCallOrder[0],
    )
  })

  it('公开链接返回 404 时不报告发布成功，重跑只检查链接', async () => {
    const args = fixture()
    args.fetchUrl.mockResolvedValue({ ok: false, status: 404 })
    await expect(publishRelease(args)).rejects.toThrow('HTTP 404')
    expect(args.release.draft).toBe(false)
    expect(args.core.info).not.toHaveBeenCalledWith(expect.stringContaining('已发布 v'))
    args.fetchUrl.mockResolvedValue({ ok: true, status: 200 })
    await publishRelease(args)
    expect(args.github.rest.repos.updateRelease).toHaveBeenCalledOnce()
    expect(args.fetchUrl).toHaveBeenCalledTimes(8)
    expect(args.wait).toHaveBeenCalledTimes(3)
  })

  it('公开下载地址短暂返回 404 时重试，成功后继续检查其他安装包', async () => {
    const args = fixture()
    args.fetchUrl.mockResolvedValueOnce({ ok: false, status: 404 })
    await publishRelease(args)
    expect(args.fetchUrl).toHaveBeenCalledTimes(5)
    expect(args.wait).toHaveBeenCalledWith(3000)
  })

  it('GitHub 未将草稿公开时停止，不检查下载链接', async () => {
    const args = fixture()
    args.github.rest.repos.updateRelease.mockResolvedValue({ data: args.release })
    await expect(publishRelease(args)).rejects.toThrow('仍为草稿')
    expect(args.fetchUrl).not.toHaveBeenCalled()
  })

  it('重试发布时复用校验内容相同的 SHA256SUMS.txt', async () => {
    const args = fixture()
    const data = expectedAssets(version)
      .map((name) => `${'1'.repeat(64)}  ${name}\n`)
      .join('')
    args.assets.push({
      name: 'SHA256SUMS.txt',
      state: 'uploaded',
      size: data.length,
      digest: `sha256:${createHash('sha256').update(data).digest('hex')}`,
    })
    await publishRelease(args)
    expect(args.github.rest.repos.uploadReleaseAsset).not.toHaveBeenCalled()
    expect(args.github.rest.repos.updateRelease).toHaveBeenCalledOnce()
  })

  it('已有校验文件与安装包不一致时停止发布', async () => {
    const args = fixture()
    args.assets.push({
      name: 'SHA256SUMS.txt',
      state: 'uploaded',
      size: 1,
      digest: `sha256:${'0'.repeat(64)}`,
    })
    await expect(publishRelease(args)).rejects.toThrow('与安装包不一致')
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
  })

  it('校验文件上传失败时不公开发布', async () => {
    const args = fixture()
    args.github.rest.repos.uploadReleaseAsset.mockRejectedValue(new Error('Upload failed'))
    await expect(publishRelease(args)).rejects.toThrow('Upload failed')
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
  })

  it('发布前标签被移动时停止发布', async () => {
    const args = fixture()
    args.github.rest.git.getRef.mockResolvedValue({
      data: { object: { type: 'commit', sha: otherSha } },
    })
    await expect(publishRelease(args)).rejects.toThrow('与本次发布提交不一致')
    expect(args.github.rest.repos.updateRelease).not.toHaveBeenCalled()
  })
})
