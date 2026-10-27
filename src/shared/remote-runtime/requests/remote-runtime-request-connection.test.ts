import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode } from '../../pairing'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../e2ee-crypto'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'
import { remoteRuntimeClientCapabilities } from '../../remote-runtime-client-capabilities'
import * as gitRunner from '../../../main/git/runner'
import { getRemoteFileUrl } from '../../../main/git/repo'

type TestServer = {
  wss: WebSocketServer
  pairing: PairedRuntimeConnection
  requests: unknown[]
  auths: unknown[]
  connectionCount: () => number
}

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
})

describe('RemoteRuntimeRequestConnection', () => {
  it('reuses one encrypted WebSocket for multiple one-shot RPCs', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeRequestConnection(server.pairing)

    const first = await connection.request('status.get', undefined, 1000)
    const second = await connection.request('terminal.send', { terminal: 't1', text: 'ab' }, 1000)

    expect(first).toMatchObject({
      ok: true,
      result: { method: 'status.get' },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(second).toMatchObject({
      ok: true,
      result: { method: 'terminal.send' },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(server.connectionCount()).toBe(1)
    expect(server.auths).toContainEqual(
      expect.objectContaining({
        clientCapabilities: remoteRuntimeClientCapabilities()
      })
    )
    expect(server.requests).toMatchObject([
      { method: 'status.get' },
      { method: 'terminal.send', params: { terminal: 't1', text: 'ab' } }
    ])

    connection.close()
  })

  it('returns the prepared URL over RPC before 15s when optional Git admission spends the 5s budget', async () => {
    const metadata = [
      'origin\thttps://github.com/org/repo.git (fetch)',
      'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0',
      'a'.repeat(40),
      'refs/heads/local',
      'refs/heads/local\0\0origin\0refs/heads/review/topic\0refs/remotes/origin/topic\nrefs/remotes/origin/topic\0\0\0\0'
    ]
    const routing = { wslDistro: 'Ubuntu', admissionTier: 'interactive' } as const
    const exec = vi
      .spyOn(gitRunner, 'gitExecFileAsync')
      .mockImplementation(async (_args, options) => {
        expect(options).toMatchObject(routing)
        expect(options?.timeout).toBeLessThanOrEqual(5_000)
        if (metadata.length) {
          return { stdout: metadata.shift() ?? '', stderr: '' }
        }
        // Admission/preflight can wait without settling; the action deadline must still end the await.
        return new Promise(() => {})
      })
    const server = await createServer(() => getRemoteFileUrl('/repo', 'a.ts', 10, 20, routing))
    const connection = new RemoteRuntimeRequestConnection(server.pairing)
    const start = Date.now()
    try {
      await expect(connection.request('git.remoteFileUrl', {}, 15_000)).resolves.toMatchObject({
        ok: true,
        result: 'https://github.com/org/repo/blob/review%2Ftopic/a.ts#L10-L20'
      })
      expect(Date.now() - start).toBeGreaterThanOrEqual(5_000)
      expect(Date.now() - start).toBeLessThan(15_000)
      expect(exec.mock.calls).toHaveLength(6)
      expect(exec.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
    } finally {
      connection.close()
      exec.mockRestore()
    }
  })

  it('aborts one request without closing the cached connection', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeRequestConnection(server.pairing)
    const controller = new AbortController()
    const pending = connection.request('test.hang', undefined, 60_000, controller.signal)
    await vi.waitFor(() =>
      expect(server.requests).toContainEqual(expect.objectContaining({ method: 'test.hang' }))
    )

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(
      (connection as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0)
    await expect(connection.request('status.get', undefined, 1000)).resolves.toMatchObject({
      ok: true,
      result: { method: 'status.get' }
    })
    expect(server.connectionCount()).toBe(1)

    connection.close()
  })
})

async function createServer(reply?: () => Promise<unknown>): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: unknown[] = []
  const auths: unknown[] = []
  let connectionCount = 0
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)

  wss.on('connection', (ws) => {
    connectionCount += 1
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { type: string; publicKeyB64: string }
        const clientPublicKey = publicKeyFromBase64(hello.publicKeyB64)
        sharedKey = deriveSharedKey(serverKeyPair.secretKey, clientPublicKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        return
      }
      if (!authenticated) {
        const auth = JSON.parse(plaintext) as { type: string; deviceToken: string }
        auths.push(auth)
        expect(auth).toEqual({
          type: 'e2ee_auth',
          deviceToken: 'device-token',
          clientCapabilities: remoteRuntimeClientCapabilities()
        })
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request = JSON.parse(plaintext) as {
        id: string
        method: string
        params?: unknown
      }
      requests.push(request)
      if (request.method === 'test.hang') {
        return
      }
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result: reply ? await reply() : { method: request.method },
        _meta: { runtimeId: 'runtime-test' }
      })
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }

  return {
    wss,
    pairing: pairedRuntimeConnectionFromOffer(pairing),
    requests,
    auths,
    connectionCount: () => connectionCount
  }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
