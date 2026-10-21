import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import {
  ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
  ANTIGRAVITY_USAGE_TIMEOUT_MS,
  ANTIGRAVITY_VERSION_TIMEOUT_MS
} from './antigravity-usage-command'
import {
  fetchAntigravityRateLimits,
  resetAntigravityUsageSupportForTests
} from './antigravity-usage-fetcher'

const USAGE = JSON.stringify({
  status: 'SUCCESS',
  conversation_id: '',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.4,
              reset_time: '2026-10-28T00:00:00Z'
            }
          ]
        }
      ]
    }
  }
})
const MODEL_TURN = JSON.stringify({ status: 'ERROR', conversation_id: 'synthetic', num_turns: 1 })
const tempRoots: string[] = []

beforeEach(() => resetAntigravityUsageSupportForTests())
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function guestHarness(
  options: {
    distro?: string | null
    version?: string
    versionStderr?: string
    versionExit?: number
    usage?: string
    usageStderr?: string
    usageExit?: number
    banner?: string
    bannerStderr?: string
    missingCli?: boolean
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orca agy wsl-'))
  tempRoots.push(root)
  const tools = join(root, 'tools')
  const cliBin = join(root, '.local', 'bin')
  mkdirSync(tools)
  mkdirSync(cliBin, { recursive: true })
  const executable = (path: string, body: string) =>
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  for (const tool of ['awk', 'basename', 'cut', 'id', 'tr']) {
    symlinkSync(`/usr/bin/${tool}`, join(tools, tool))
  }
  executable(join(tools, 'getent'), 'printf "fixture:x:1:1::%s:%s/bash\\n" "$HOME" "$PATH"')
  // The fake login shell adds ~/.local/bin without reading any real shell startup files.
  executable(
    join(tools, 'bash'),
    [
      '[ "$1" = -ilc ] || exit 91',
      'printf "%s\\n" "$ORCA_TEST_BANNER"',
      'printf "%s\\n" "$ORCA_TEST_BANNER_STDERR" >&2',
      'export PATH="$HOME/.local/bin:$PATH"',
      'exec /bin/sh -c "$2"'
    ].join('\n')
  )
  const trace = join(root, 'calls')
  writeFileSync(trace, '')
  if (!options.missingCli) {
    executable(
      join(cliBin, 'agy'),
      [
        'printf "%s|%s\\n" "$*" "${AGY_CLI_DISABLE_AUTO_UPDATE-unset}" >> "$ORCA_TEST_TRACE"',
        'if [ "$1" = --version ]; then',
        '  printf "%s\\n" "$ORCA_TEST_VERSION"',
        '  printf "%s\\n" "$ORCA_TEST_VERSION_STDERR" >&2',
        '  exit "$ORCA_TEST_VERSION_EXIT"',
        'fi',
        'printf "%s\\n" "$ORCA_TEST_USAGE"',
        'printf "%s\\n" "$ORCA_TEST_USAGE_STDERR" >&2',
        'exit "$ORCA_TEST_USAGE_EXIT"'
      ].join('\n')
    )
  }
  const guestEnv: NodeJS.ProcessEnv = {
    HOME: root,
    PATH: tools,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'false',
    ORCA_TEST_TRACE: trace,
    ORCA_TEST_VERSION: options.version ?? 'agy version 1.1.11',
    ORCA_TEST_VERSION_STDERR: options.versionStderr ?? '',
    ORCA_TEST_VERSION_EXIT: String(options.versionExit ?? 0),
    ORCA_TEST_USAGE: options.usage ?? USAGE,
    ORCA_TEST_USAGE_STDERR: options.usageStderr ?? '',
    ORCA_TEST_USAGE_EXIT: String(options.usageExit ?? 0),
    ORCA_TEST_BANNER: options.banner ?? 'Welcome to Ubuntu 26.04\nagy version 9.9.9',
    ORCA_TEST_BANNER_STDERR: options.bannerStderr ?? ''
  }
  const specs: ProcessSpec[] = []
  const runGuest = async (spec: ProcessSpec): Promise<ProcessResult> => {
    specs.push(spec)
    const args = spec.args ?? []
    const execIndex = args.indexOf('--exec')
    if (spec.program !== 'wsl.exe' || execIndex === -1 || args[execIndex + 1] !== 'sh') {
      throw new Error('Expected an explicit WSL shell invocation')
    }
    return runProcess({
      ...spec,
      program: '/bin/sh',
      args: args.slice(execIndex + 2),
      cwd: root,
      env: guestEnv
    })
  }
  const runCommand = vi.fn(runGuest)
  const resolveCommand = vi.fn().mockResolvedValue(null)
  const isWslDistroRunning = vi.fn(async () => true)
  const signal = new AbortController().signal
  return {
    specs,
    signal,
    resolveCommand,
    isWslDistroRunning,
    runCommand,
    runGuest,
    calls: () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
    fetch: () =>
      fetchAntigravityRateLimits({
        platform: 'win32',
        target: { runtime: 'wsl', wslDistro: options.distro ?? null },
        isWslDistroRunning,
        resolveCommand,
        resolveEnvironment: async () => ({
          PATH: 'C:\\Windows',
          AGY_CLI_DISABLE_AUTO_UPDATE: 'false'
        }),
        runCommand,
        signal
      })
  }
}

describe.skipIf(process.platform === 'win32')('Antigravity through the WSL login shell', () => {
  it.each(['Ubuntu-26.04', null])(
    'reads guest-only agy in distro %s with probe guards',
    async (distro) => {
      const h = guestHarness({ distro })

      expect(await h.fetch()).toMatchObject({
        status: 'ok',
        weekly: { usedPercent: 60, windowMinutes: 10_080 },
        usageMetadata: { credentialSource: 'antigravity-cli' }
      })
      expect(h.resolveCommand).not.toHaveBeenCalled()
      expect(h.isWslDistroRunning).toHaveBeenCalledWith(distro)
      expect(h.calls()).toEqual([
        '--version|true',
        '-p /usage --output-format json --print-timeout 20s|true'
      ])
      expect(h.specs.map((spec) => spec.timeoutMs)).toEqual([
        ANTIGRAVITY_VERSION_TIMEOUT_MS,
        ANTIGRAVITY_USAGE_TIMEOUT_MS
      ])
      for (const spec of h.specs) {
        const prefix = distro ? ['-d', distro, '--exec', 'sh', '-c'] : ['--exec', 'sh', '-c']
        expect(spec.args?.slice(0, prefix.length)).toEqual(prefix)
        expect(spec).toMatchObject({
          cwd: resolveWslInteropSpawnCwd(),
          maxOutputBytes: ANTIGRAVITY_USAGE_MAX_OUTPUT_BYTES,
          signal: h.signal
        })
      }
    }
  )

  it('does not let a newer banner bypass the minimum guest CLI version', async () => {
    const h = guestHarness({ version: 'agy version 1.1.10' })

    expect(await h.fetch()).toMatchObject({ status: 'unavailable' })
    expect(h.calls()).toEqual(['--version|true'])
  })

  it('rejects banner versions on stdout and stderr when the CLI version is empty', async () => {
    const h = guestHarness({ version: '', bannerStderr: 'agy version 9.9.9' })

    const response = await h.fetch()
    expect(response.error).toContain('version could not be read')
    expect(h.calls()).toEqual(['--version|true'])
  })

  it('accepts the guest CLI version printed to stderr inside the capture fence', async () => {
    const h = guestHarness({ version: '', versionStderr: 'agy version 1.1.11' })

    expect((await h.fetch()).status).toBe('ok')
    expect(h.calls()).toHaveLength(2)
  })

  it('does not read quota after the guest version command fails', async () => {
    const h = guestHarness({ versionExit: 7 })

    expect((await h.fetch()).error).toContain('version could not be read')
    expect(h.calls()).toEqual(['--version|true'])
  })

  it('does not read quota after a timed-out version probe returned version text', async () => {
    const h = guestHarness()
    h.runCommand.mockImplementationOnce(async (spec) => ({
      ...(await h.runGuest(spec)),
      timedOut: true
    }))

    expect((await h.fetch()).error).toContain('version could not be read')
    expect(h.calls()).toEqual(['--version|true'])
  })

  it('does not treat startup quota or model-turn JSON as CLI output', async () => {
    const h = guestHarness({ banner: `${USAGE}\n${MODEL_TURN}`, usage: '' })

    expect(await h.fetch()).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'parse' }
    })
    expect(await h.fetch()).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'parse' }
    })
    expect(h.calls()).toHaveLength(4)
  })

  it('reports a timed-out quota probe even if it captured quota before timing out', async () => {
    const h = guestHarness()
    h.runCommand.mockImplementationOnce(h.runGuest).mockImplementationOnce(async (spec) => ({
      ...(await h.runGuest(spec)),
      timedOut: true
    }))

    const response = await h.fetch()
    expect(response).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(response.error).toContain('did not answer in time')
    expect(h.calls()).toHaveLength(2)
  })

  it('classifies sign-in guidance from guest stderr', async () => {
    const h = guestHarness({
      usage: '',
      usageStderr: 'Not authenticated. Run agy login.',
      usageExit: 1
    })

    expect(await h.fetch()).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  })

  it('latches an actual guest model turn and prevents any further probes', async () => {
    const h = guestHarness({ usage: MODEL_TURN })

    expect((await h.fetch()).error).toContain('answers `/usage` as a prompt')
    expect((await h.fetch()).error).toContain('answers `/usage` as a prompt')
    expect(h.calls()).toHaveLength(2)
    expect(h.specs).toHaveLength(2)
  })

  it('reports a missing guest CLI without falling back to the Windows account', async () => {
    const h = guestHarness({ missingCli: true })

    expect(await h.fetch()).toMatchObject({
      status: 'unavailable',
      usageMetadata: { failureKind: 'cli-unavailable' }
    })
    expect(h.calls()).toEqual([])
    expect(h.resolveCommand).not.toHaveBeenCalled()
  })
})

it('never enters a stopped or unconfirmed WSL distro', async () => {
  const runCommand = vi.fn<typeof runProcess>()
  const resolveCommand = vi.fn().mockResolvedValue('/host/agy')
  const resolveEnvironment = vi.fn().mockResolvedValue({})
  const response = await fetchAntigravityRateLimits({
    platform: 'win32',
    target: { runtime: 'wsl', wslDistro: 'Stopped' },
    isWslDistroRunning: async () => false,
    runCommand,
    resolveCommand,
    resolveEnvironment
  })

  expect(response).toMatchObject({ status: 'unavailable' })
  expect(response.error).toContain('stopped or unavailable')
  expect(runCommand).not.toHaveBeenCalled()
  expect(resolveEnvironment).not.toHaveBeenCalled()
  expect(resolveCommand).not.toHaveBeenCalled()
})

it('rejects version text without an opening capture fence', async () => {
  const runCommand = vi.fn<typeof runProcess>().mockResolvedValue({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: 'agy version 9.9.9',
    stderr: 'agy version 9.9.9'
  })
  const response = await fetchAntigravityRateLimits({
    platform: 'win32',
    target: { runtime: 'wsl', wslDistro: 'Ubuntu-26.04' },
    isWslDistroRunning: async () => true,
    resolveEnvironment: async () => ({}),
    runCommand
  })

  expect(response).toMatchObject({ status: 'unavailable' })
  expect(response.error).toContain('version could not be read')
  expect(runCommand).toHaveBeenCalledTimes(1)
})
