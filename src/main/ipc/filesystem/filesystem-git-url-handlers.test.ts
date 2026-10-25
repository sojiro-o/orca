import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  gitExecFileAsync: vi.fn(),
  awaitWindowsHostGitEnvironmentReady: vi.fn(),
  resolveRegisteredWorktreePath: vi.fn(),
  getLocalGitOptionsForRegisteredWorktree: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../git/runner', () => ({
  gitExecFileAsync: mocks.gitExecFileAsync,
  awaitWindowsHostGitEnvironmentReady: mocks.awaitWindowsHostGitEnvironmentReady
}))
vi.mock('../registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: mocks.resolveRegisteredWorktreePath
}))
vi.mock('../local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: mocks.getLocalGitOptionsForRegisteredWorktree
}))

import { registerFilesystemGitUrlHandlers } from './filesystem-git-url-handlers'

describe('git:remoteFileUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('preserves explicit WSL routing for a Linux-form worktree path and a line range', async () => {
    const worktreePath = '/workspace/feature'
    const sha = '0123456789abcdef0123456789abcdef01234567'
    mocks.resolveRegisteredWorktreePath.mockResolvedValue(worktreePath)
    mocks.getLocalGitOptionsForRegisteredWorktree.mockReturnValue({ wslDistro: 'Ubuntu' })
    mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'git@github.com:acme/repo.git\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `${sha}\n`, stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/feature\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })
    const context = { store: {} }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This registrar reads only store, which both mocked path/options resolvers accept.
    registerFilesystemGitUrlHandlers(context as FilesystemHandlerContext)
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'git:remoteFileUrl'
    )?.[1]
    expect(handler).toBeTypeOf('function')

    await expect(
      handler(null, { worktreePath, relativePath: 'src/a.ts', line: 3, endLine: 8 })
    ).resolves.toBe(`https://github.com/acme/repo/blob/${sha}/src/a.ts#L3-L8`)

    expect(mocks.getLocalGitOptionsForRegisteredWorktree).toHaveBeenCalledWith(
      context.store,
      worktreePath,
      worktreePath
    )
    expect(mocks.awaitWindowsHostGitEnvironmentReady).toHaveBeenCalledWith({
      cwd: worktreePath,
      wslDistro: 'Ubuntu'
    })
    for (const [, options] of mocks.gitExecFileAsync.mock.calls) {
      expect(options).toMatchObject({ cwd: worktreePath, wslDistro: 'Ubuntu' })
    }
  })
})
