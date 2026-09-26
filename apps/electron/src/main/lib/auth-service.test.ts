import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as os from 'node:os'
import { join } from 'node:path'
import type { SsoWindowOpener } from './auth-service'

type AuthServiceModule = typeof import('./auth-service')

let auth: AuthServiceModule
let tempHome: string
let gatewayUrl: string
const originalHome = process.env.HOME
const originalPromaDev = process.env.PROMA_DEV
const originalGateway = process.env.PROMA_AUTH_GATEWAY

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {
    openExternal: async () => undefined,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

const gatewayState = {
  envelope: 'code' as 'code' | 'success',
  codeExchangeRequests: [] as Array<Record<string, string>>,
  refreshRequests: [] as Array<Record<string, string>>,
  validCodes: new Map<string, string>(), // code -> access token
  validRefresh: new Map<string, string>(), // refresh -> access
  rejectAccessTokens: new Set<string>(),
  rejectRefreshTokens: new Set<string>(),
  revokeCalls: 0,
}

const USER_INFO = {
  sub: '15357976983',
  fullName: '左孝雨',
  mobileNo: '15357976983',
  roles: ['ON_SITE_MAINTENANCE_ENGINEER'],
  rns: ['现场工程师'],
  tenantId: '1898647714773078016',
  tenantName: 'KUKA',
}

let server: ReturnType<typeof Bun.serve> | null = null

function envelope(data: unknown, status = 200): Response {
  const body = gatewayState.envelope === 'code'
    ? { code: status === 200 ? 0 : 1, data }
    : { success: status === 200, data }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function errorEnvelope(message: string, status = 401): Response {
  const body = gatewayState.envelope === 'code'
    ? { code: status, message }
    : { success: false, error: { code: 'UNAUTHORIZED', message } }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'proma-auth-sso-'))
  process.env.HOME = tempHome
  process.env.PROMA_DEV = '0'

  server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/oauth/token') {
        const body = (await request.json()) as Record<string, string>
        if (body.grant_type === 'authorization_code') {
          gatewayState.codeExchangeRequests.push(body)
          const access = gatewayState.validCodes.get(body.code ?? '')
          if (access) {
            return envelope({ access_token: access, refresh_token: 'refresh-a', token_type: 'bearer', expires_in: 7200 })
          }
          return errorEnvelope('授权码无效或已过期')
        }
        if (body.grant_type === 'refresh_token') {
          gatewayState.refreshRequests.push(body)
          if (gatewayState.rejectRefreshTokens.has(body.refresh_token ?? '')) {
            return errorEnvelope('refresh_token 无效')
          }
          const access = gatewayState.validRefresh.get(body.refresh_token ?? '') ?? 'access-b'
          return envelope({ access_token: access, refresh_token: 'refresh-b', token_type: 'bearer', expires_in: 7200 })
        }
        return errorEnvelope('不支持的授权类型', 400)
      }
      if (url.pathname === '/oauth/userinfo') {
        const bearer = request.headers.get('Authorization') ?? ''
        const token = bearer.replace(/^Bearer\s+/i, '')
        if (gatewayState.rejectAccessTokens.has(token)) {
          return errorEnvelope('Authorization 头格式无效，期望: Bearer <token>')
        }
        if (token === 'access-a' || token === 'access-b') {
          return envelope(USER_INFO)
        }
        return errorEnvelope('令牌无效')
      }
      if (url.pathname === '/oauth/revoke') {
        gatewayState.revokeCalls += 1
        return envelope({ revoked: true })
      }
      return new Response('not found', { status: 404 })
    },
  })
  gatewayUrl = `http://localhost:${server.port}`
  process.env.PROMA_AUTH_GATEWAY = gatewayUrl

  auth = await import('./auth-service')
})

beforeEach(() => {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  gatewayState.envelope = 'code'
  gatewayState.codeExchangeRequests = []
  gatewayState.refreshRequests = []
  gatewayState.validCodes = new Map()
  gatewayState.validRefresh = new Map()
  gatewayState.rejectAccessTokens = new Set()
  gatewayState.rejectRefreshTokens = new Set()
  gatewayState.revokeCalls = 0
})

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalPromaDev === undefined) delete process.env.PROMA_DEV
  else process.env.PROMA_DEV = originalPromaDev
  if (originalGateway === undefined) delete process.env.PROMA_AUTH_GATEWAY
  else process.env.PROMA_AUTH_GATEWAY = originalGateway
  server?.stop(true)
  rmSync(tempHome, { recursive: true, force: true })
})

function authStorePath(): string {
  return join(tempHome, '.proma', 'auth.json')
}

/** 直接写入一份持久化会话，模拟「上次登录后重启」场景 */
function seedStoredSession(accessToken: string, refreshToken: string, expiresAt: number): void {
  rmSync(join(tempHome, '.proma'), { recursive: true, force: true })
  const dir = join(tempHome, '.proma')
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(authStorePath(), JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt,
    user: {
      sub: USER_INFO.sub,
      fullName: USER_INFO.fullName,
      mobileNo: USER_INFO.mobileNo,
      roles: USER_INFO.roles,
      roleName: USER_INFO.rns[0],
      tenantId: USER_INFO.tenantId,
      tenantName: USER_INFO.tenantName,
    },
    loggedInAt: Date.now() - 1000,
  }))
}

/** 注入式 SSO 窗口：成功回调（可注入错误 state） */
function openerWithCallback(options?: { stateOverride?: string; omitCode?: boolean }): SsoWindowOpener {
  return (authorizeUrl, handlers) => {
    const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
    gatewayState.validCodes.set('code-ok', 'access-a')
    queueMicrotask(() => {
      const params = new URLSearchParams({ state: options?.stateOverride ?? state })
      if (!options?.omitCode) params.set('code', 'code-ok')
      handlers.onCallbackUrl(`https://app.ounirobot.com/auth/callback?${params.toString()}`)
    })
    return { close: () => {} }
  }
}

describe('PKCE 与 authorize URL', () => {
  test('Given 一组 PKCE 参数 When 校验 Then challenge 为 verifier 的 S256 且 authorize URL 含全部参数', () => {
    const pkce = auth.generatePkcePair()
    expect(createHash('sha256').update(pkce.verifier).digest('base64url')).toBe(pkce.challenge)
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.state).toMatch(/^[0-9a-f]{32}$/)

    const url = new URL(auth.buildAuthorizeUrl(pkce))
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('moment-factory-im-client')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.ounirobot.com/auth/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(pkce.state)
  })
})

describe('登录（授权码 + PKCE）', () => {
  test('Given SSO 窗口回调合法 code When login Then 换取令牌、拉取用户并持久化', async () => {
    const result = await auth.login(openerWithCallback())

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.session.user.fullName).toBe('左孝雨')
    expect(result.session.user.roleName).toBe('现场工程师')

    const exchange = gatewayState.codeExchangeRequests[0]
    expect(exchange?.grant_type).toBe('authorization_code')
    expect(exchange?.client_id).toBe('moment-factory-im-client')
    expect(exchange?.redirect_uri).toBe('https://app.ounirobot.com/auth/callback')
    expect(typeof exchange?.code_verifier).toBe('string')

    const stored = JSON.parse(readFileSync(authStorePath(), 'utf-8')) as { accessToken: string; refreshToken: string }
    expect(stored.accessToken).toBe('access-a')
    expect(stored.refreshToken).toBe('refresh-a')
  })

  test('Given 用户直接关闭登录窗口 When login Then 返回取消而非错误', async () => {
    const opener: SsoWindowOpener = (_url, handlers) => {
      queueMicrotask(() => handlers.onClosed())
      return { close: () => {} }
    }

    const result = await auth.login(opener)

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.cancelled).toBe(true)
    expect(existsSync(authStorePath())).toBe(false)
  })

  test('Given 回调 state 与发起时不一致 When login Then 拒绝且不请求令牌', async () => {
    const result = await auth.login(openerWithCallback({ stateOverride: 'tampered' }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('state')
    expect(gatewayState.codeExchangeRequests).toHaveLength(0)
  })

  test('Given 回调缺少 code When login Then 报参数不完整', async () => {
    const result = await auth.login(openerWithCallback({ omitCode: true }))

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('不完整')
  })

  test('Given 授权码已被使用过 When login Then 返回服务端错误信息', async () => {
    const result = await auth.login((url, handlers) => {
      const state = new URL(url).searchParams.get('state') ?? ''
      queueMicrotask(() => handlers.onCallbackUrl(`https://app.ounirobot.com/auth/callback?code=stale&state=${state}`))
      return { close: () => {} }
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('授权码无效')
  })
})

describe('门禁状态校验（getAuthState）', () => {
  test('Given 本地无会话 When getAuthState Then logged-out', async () => {
    const state = await auth.getAuthState()
    expect(state.status).toBe('logged-out')
  })

  test('Given 本地有效令牌 When getAuthState Then userinfo 复核通过', async () => {
    seedStoredSession('access-a', 'refresh-a', Date.now() + 3600_000)

    const state = await auth.getAuthState()

    expect(state.status).toBe('logged-in')
    if (state.status !== 'logged-in') return
    expect(state.session.user.fullName).toBe('左孝雨')
  })

  test('Given access 临期 When getAuthState Then 先 refresh 再复核', async () => {
    seedStoredSession('access-a', 'refresh-a', Date.now() + 10_000)

    const state = await auth.getAuthState()

    expect(state.status).toBe('logged-in')
    expect(gatewayState.refreshRequests).toHaveLength(1)
    const stored = JSON.parse(readFileSync(authStorePath(), 'utf-8')) as { accessToken: string }
    expect(stored.accessToken).toBe('access-b')
  })

  test('Given access 与 refresh 均被服务端拒绝 When getAuthState Then 清除会话回到 logged-out', async () => {
    seedStoredSession('access-a', 'refresh-a', Date.now() + 3600_000)
    gatewayState.rejectAccessTokens.add('access-a')
    gatewayState.rejectRefreshTokens.add('refresh-a')

    const state = await auth.getAuthState()

    expect(state.status).toBe('logged-out')
    expect(existsSync(authStorePath())).toBe(false)
  })

  test('Given 网关不可达但本地会话有效 When getAuthState Then 离线容忍保持登录', async () => {
    seedStoredSession('access-a', 'refresh-a', Date.now() + 3600_000)
    process.env.PROMA_AUTH_GATEWAY = 'http://localhost:1'

    const state = await auth.getAuthState()

    expect(state.status).toBe('logged-in')
    process.env.PROMA_AUTH_GATEWAY = gatewayUrl
  })
})

describe('登出（logout）', () => {
  test('Given 已登录 When logout Then 撤销 refresh_token 并清除本地会话', async () => {
    gatewayState.validCodes.set('code-ok', 'access-a')
    await auth.login(openerWithCallback())

    await auth.logout()

    expect(gatewayState.revokeCalls).toBe(1)
    expect(existsSync(authStorePath())).toBe(false)
    const state = await auth.getAuthState()
    expect(state.status).toBe('logged-out')
  })
})
