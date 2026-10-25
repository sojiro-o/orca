import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRemoteFileUrl } from './repo'
import { gitExecFileAsync } from './runner'

describe('getRemoteFileUrl', () => {
  let root: string
  let repo: string
  let worktree: string

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await gitExecFileAsync(args, { cwd })
    return stdout.trim()
  }

  async function commitFeature(): Promise<string> {
    await writeFile(join(worktree, 'feature.ts'), 'export const feature = true\n')
    await git(worktree, 'add', 'feature.ts')
    await git(worktree, 'commit', '--quiet', '-m', 'feature')
    return git(worktree, 'rev-parse', 'HEAD')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-remote-file-url-'))
    repo = join(root, 'repo')
    worktree = join(root, 'feature')
    await mkdir(repo)
    await git(root, 'init', '--bare', '--quiet', 'remote.git')
    await git(repo, 'init', '--quiet')
    await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    await git(repo, 'config', 'user.name', 'Orca Test')
    await git(repo, 'config', 'user.email', 'test@example.invalid')
    await git(repo, 'config', 'commit.gpgSign', 'false')
    await git(repo, 'config', 'branch.autoSetupMerge', 'false')
    await git(repo, 'config', 'core.hooksPath', join(root, 'no-hooks'))
    await git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'main')
    await git(repo, 'remote', 'add', 'origin', 'https://github.com/org/repo.git')
    await git(repo, 'remote', 'set-url', '--push', 'origin', join(root, 'remote.git'))
    await git(repo, 'push', '--quiet', '--set-upstream', 'origin', 'main')
    await git(repo, 'worktree', 'add', '--quiet', '-b', 'feature/example', worktree)
    await commitFeature()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('links a pushed worktree commit and selected lines even when the file is absent on main', async () => {
    await git(worktree, 'push', '--quiet', '--set-upstream', 'origin', 'feature/example')
    const sha = await git(worktree, 'rev-parse', 'HEAD')

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10, 20)).resolves.toBe(
      `https://github.com/org/repo/blob/${sha}/feature.ts#L10-L20`
    )
  })

  it('uses a permalink when HEAD is an ancestor of a remote-tracking tip', async () => {
    const sha = await git(worktree, 'rev-parse', 'HEAD')
    await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'later')
    await git(worktree, 'push', '--quiet', 'origin', 'feature/example')
    await git(worktree, 'reset', '--hard', sha)

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      `https://github.com/org/repo/blob/${sha}/feature.ts#L10`
    )
  })

  it('uses the current branch for an unpushed commit with an upstream on origin', async () => {
    await git(worktree, 'push', '--quiet', '--set-upstream', 'origin', 'feature/example')
    await git(worktree, 'commit', '--quiet', '--allow-empty', '-m', 'unpushed')

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      'https://github.com/org/repo/blob/feature%2Fexample/feature.ts#L10'
    )
  })

  it('uses the origin upstream branch name when it differs from the local branch', async () => {
    await git(worktree, 'branch', '--set-upstream-to=origin/main')

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      'https://github.com/org/repo/blob/main/feature.ts#L10'
    )
  })

  it('falls back to the default branch when the current branch has no upstream', async () => {
    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      'https://github.com/org/repo/blob/main/feature.ts#L10'
    )
  })

  it.each(['upstream', 'origin-other'])(
    'does not use a commit or upstream belonging only to %s',
    async (remote) => {
      await git(repo, 'remote', 'add', remote, 'https://github.com/org/other.git')
      await git(worktree, 'update-ref', `refs/remotes/${remote}/feature/example`, 'HEAD')
      await git(worktree, 'branch', `--set-upstream-to=${remote}/feature/example`)

      await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
        'https://github.com/org/repo/blob/main/feature.ts#L10'
      )
    }
  )

  it('links a detached HEAD when its commit is on origin', async () => {
    await git(worktree, 'push', '--quiet', 'origin', 'feature/example')
    await git(worktree, 'checkout', '--quiet', '--detach')
    const sha = await git(worktree, 'rev-parse', 'HEAD')

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      `https://github.com/org/repo/blob/${sha}/feature.ts#L10`
    )
  })

  it('falls back to the default branch for an unpushed detached HEAD', async () => {
    await git(worktree, 'checkout', '--quiet', '--detach')

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      'https://github.com/org/repo/blob/main/feature.ts#L10'
    )
  })

  it('preserves a configured remote default branch when falling back', async () => {
    await git(repo, 'update-ref', 'refs/remotes/origin/release/stable', 'main')
    await git(
      repo,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/release/stable'
    )

    await expect(getRemoteFileUrl(worktree, 'feature.ts', 10)).resolves.toBe(
      'https://github.com/org/repo/blob/release%2Fstable/feature.ts#L10'
    )
  })

  it('returns null for a folder workspace without Git', async () => {
    await expect(getRemoteFileUrl(root, 'feature.ts', 10)).resolves.toBeNull()
  })

  it('returns null for an unborn HEAD with no default ref', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty)
    await git(empty, 'init', '--quiet')
    await git(empty, 'remote', 'add', 'origin', 'https://github.com/org/repo.git')

    await expect(getRemoteFileUrl(empty, 'feature.ts', 10)).resolves.toBeNull()
  })
})
