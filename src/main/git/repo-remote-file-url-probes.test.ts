import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsync } = vi.hoisted(() => ({ gitExecFileAsync: vi.fn() }))

vi.mock('./runner', () => ({ gitExecFileAsync }))

import { getRemoteFileUrl } from './repo'

describe('remote file URL probe failures', () => {
  beforeEach(() => {
    gitExecFileAsync.mockReset()
  })

  it('falls back to the upstream branch when the bounded reachability probe times out', async () => {
    gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'git@github.com:org/repo.git\n' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `${'a'.repeat(40)}\n` }
      }
      if (args.some((arg) => arg.startsWith('--contains='))) {
        throw new Error('git timed out')
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/feature/test\n' }
      }
      if (args.includes('--format=%(upstream)')) {
        return { stdout: 'refs/remotes/origin/feature/test\n' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    await expect(
      getRemoteFileUrl('/repo', 'src/a.ts', 10, 20, { wslDistro: 'Ubuntu' })
    ).resolves.toBe('https://github.com/org/repo/blob/feature%2Ftest/src/a.ts#L10-L20')

    for (const [, options] of gitExecFileAsync.mock.calls) {
      expect(options).toMatchObject({ cwd: '/repo', wslDistro: 'Ubuntu' })
    }
    expect(gitExecFileAsync).toHaveBeenCalledWith(
      [
        'for-each-ref',
        `--contains=${'a'.repeat(40)}`,
        '--count=1',
        '--format=%(refname)',
        'refs/remotes/origin/'
      ],
      expect.objectContaining({ timeout: 15_000, maxBuffer: 64 * 1024 })
    )
  })

  it('keeps WSL routing on the default fallback when HEAD probes fail', async () => {
    gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'git@github.com:org/repo.git\n' }
      }
      if (args.includes('--format=%(refname)%00%(symref)')) {
        return { stdout: 'refs/remotes/origin/main\0\n' }
      }
      throw new Error('HEAD unavailable')
    })

    await expect(
      getRemoteFileUrl('/repo', 'src/a.ts', 10, undefined, { wslDistro: 'Ubuntu' })
    ).resolves.toBe('https://github.com/org/repo/blob/main/src/a.ts#L10')

    for (const [, options] of gitExecFileAsync.mock.calls) {
      expect(options).toMatchObject({ cwd: '/repo', wslDistro: 'Ubuntu' })
    }
  })
})
