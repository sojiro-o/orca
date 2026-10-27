import { parseHostedRemote } from './hosted-remote-url'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import { sourceRefsForTarget } from '../../shared/git-branch-cleanup-fetch'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { DEFAULT_BASE_REF_PROBES } from '../../shared/git-default-base-ref'
import { gitExecOptions, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

export async function getRemoteFileTarget(
  repoPath: string,
  options: LocalGitExecOptions
): Promise<{ remoteUrl: string; ref: string } | null> {
  const controller = new AbortController()
  const deadline = Date.now() + 5_000
  const timer = setTimeout(() => controller.abort(), 5_000)
  const run = async (argv: string[]): Promise<string> => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      return ''
    }
    try {
      const { stdout } = await waitForPromiseWithSignal(
        gitExecFileAsync(argv, {
          ...gitExecOptions(repoPath, options),
          signal: controller.signal,
          timeout: Math.max(1, deadline - Date.now()),
          maxBuffer: 1024 * 1024
        }),
        controller.signal
      )
      return stdout
    } catch {
      return ''
    }
  }
  try {
    const urls = parseGitRemoteFetchUrls(await run(['remote', '-v']))
    const mappings = new Map<string, string[]>()
    for (const record of (
      await run(['config', '--null', '--get-regexp', '^remote\\..*\\.fetch$'])
    ).split('\0')) {
      const separator = record.indexOf('\n')
      const remote = record.slice(0, separator).match(/^remote\.(.*)\.fetch$/)?.[1]
      if (separator === -1 || !remote) {
        continue
      }
      mappings.set(remote, [...(mappings.get(remote) ?? []), record.slice(separator + 1)])
    }
    const target = (remote: string, ref: string) => {
      const remoteUrl = urls.get(remote)
      return remoteUrl && parseHostedRemote(remoteUrl) ? { remoteUrl, ref } : null
    }
    const owners = (ref: string) =>
      [...mappings].flatMap(([remote, specs]) =>
        sourceRefsForTarget(specs, ref).map((source) => ({ remote, source }))
      )
    const mappedTarget = (ref: string, remote?: string) => {
      const matches = owners(ref)
      const match = matches.length === 1 ? matches[0] : undefined
      return match && (!remote || remote === match.remote) && match.source.startsWith('refs/heads/')
        ? target(match.remote, match.source.slice('refs/heads/'.length))
        : null
    }
    const sha = (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    const branch = (await run(['symbolic-ref', '--quiet', 'HEAD'])).trim()
    const destinations = [
      ...new Set(
        [...mappings.values()].flatMap((specs) =>
          specs.flatMap((spec) => {
            const destination = spec.replace(/^\+/, '').split(':')[1]
            return destination ? [destination.split('*')[0]] : []
          })
        )
      )
    ]
    const format =
      '--format=%(refname)%00%(symref)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)'
    const patterns = [
      ...new Set([
        ...destinations,
        ...[...urls.keys()].map((remote) => `refs/remotes/${remote}/HEAD`),
        ...DEFAULT_BASE_REF_PROBES.map(({ ref }) => ref),
        ...(branch ? [branch] : [])
      ])
    ]
    const refs = new Map(
      (await run(['for-each-ref', format, ...patterns]))
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((row) => {
          const [ref, ...fields] = row.split('\0')
          return [ref, fields] as const
        })
    )
    const [, upstreamRemote = '', upstreamSource = '', upstreamRef = ''] = refs.get(branch) ?? []
    const preference = [...new Set([upstreamRemote, 'origin', ...urls.keys()])]
    let fallback =
      upstreamRemote !== '.' && refs.has(upstreamRef) && upstreamSource.startsWith('refs/heads/')
        ? target(upstreamRemote, upstreamSource.slice('refs/heads/'.length))
        : null
    for (const remote of ['origin', ...preference.filter((name) => name !== 'origin')]) {
      if (fallback) {
        break
      }
      const symbolicTarget = refs.get(`refs/remotes/${remote}/HEAD`)?.[0]
      if (symbolicTarget && refs.has(symbolicTarget)) {
        fallback = mappedTarget(symbolicTarget, remote)
      }
      if (remote !== 'origin' || fallback) {
        continue
      }
      // Preserve legacy origin guesses only under its ordinary branch mapping.
      const ordinary = mappings.get(remote)?.filter((spec) => !spec.startsWith('^'))
      if (
        ordinary?.length !== 1 ||
        ordinary[0].replace(/^\+/, '') !== 'refs/heads/*:refs/remotes/origin/*'
      ) {
        continue
      }
      for (const { ref } of DEFAULT_BASE_REF_PROBES) {
        if (!refs.has(ref)) {
          continue
        }
        const destination = ref.replace('refs/heads/', 'refs/remotes/origin/')
        fallback = mappedTarget(destination, remote)
        if (fallback) {
          break
        }
      }
    }
    if (!sha || !destinations.length || controller.signal.aborted) {
      return fallback
    }
    const containing = await run([
      'for-each-ref',
      `--contains=${sha}`,
      '--format=%(refname)%00%(symref)',
      ...destinations
    ])
    const published = new Set(
      containing
        .trimEnd()
        .split('\n')
        .flatMap((row) => {
          const [ref, symbolic] = row.split('\0')
          if (!ref || symbolic) {
            return []
          }
          const matches = owners(ref)
          return matches.length === 1 && target(matches[0].remote, sha) ? [matches[0].remote] : []
        })
    )
    const remote = preference.find((name) => published.has(name))
    return remote ? target(remote, sha) : fallback
  } finally {
    clearTimeout(timer)
  }
}
