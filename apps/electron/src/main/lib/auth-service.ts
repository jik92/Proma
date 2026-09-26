/**
 * 登录门禁服务
 *
 * 对接 moment-factory-platform 网关的 OAuth2 授权码 + PKCE 流程：
 * 1. 打开内嵌 SSO 登录窗口加载 /oauth/authorize（302 到 SSO 登录页）
 * 2. 用户在登录页完成认证后，服务端重定向到注册的 web 回调地址
 * 3. 主进程拦截该重定向取 code（浏览器不真正加载回调页），用 code_verifier 换取令牌
 * 4. GET /oauth/userinfo 获取用户信息并持久化会话
 * 登出走 POST /oauth/revoke 撤销 refresh_token。
 *
 * 令牌持久化在配置目录 auth.json，access/refresh 使用 Electron safeStorage
 * 加密（不可用时回退明文，与渠道密钥存储策略一致）。
 * 网关不可达时保留本地会话（离线容忍），仅在服务端明确拒绝时判定登出。
 */

import { BrowserWindow, safeStorage } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { getConfigDir } from './config-paths'
import {
  AUTH_OAUTH_CLIENT_ID,
  AUTH_SSO_REDIRECT_URI,
  DEFAULT_AUTH_GATEWAY_URL,
} from '../../types'
import type {
  AuthGateStatus,
  AuthLoginResult,
  AuthSession,
  AuthUserInfo,
} from '../../types'

/** 请求统一超时 */
const AUTH_REQUEST_TIMEOUT_MS = 15_000

/** access_token 剩余寿命低于该值时提前刷新 */
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000

/** 令牌存储文件结构（auth.json） */
interface AuthTokenStore {
  accessToken: string
  refreshToken: string
  /** access_token 过期时间（毫秒时间戳） */
  expiresAt: number
  /** 用户信息缓存（userinfo 校验失败时可回退展示） */
  user: AuthUserInfo
  loggedInAt: number
}

/** 网关返回的用户信息原始结构（已裁剪所需字段） */
interface RawUserInfo {
  sub?: string
  fullName?: string
  mobileNo?: string
  roles?: string[]
  rns?: string[]
  tenantId?: string
  tenantName?: string
}

export function getAuthGatewayUrl(): string {
  return process.env.PROMA_AUTH_GATEWAY ?? DEFAULT_AUTH_GATEWAY_URL
}

// ===== PKCE =====

/** 生成 PKCE code_verifier（43-128 字符 base64url） */
function generateCodeVerifier(): string {
  return randomBytes(48).toString('base64url')
}

/** S256 code_challenge */
function computeCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** 生成一组 authorize 参数（verifier + challenge + state） */
export function generatePkcePair(): { verifier: string; challenge: string; state: string } {
  const verifier = generateCodeVerifier()
  return { verifier, challenge: computeCodeChallenge(verifier), state: randomBytes(16).toString('hex') }
}

/** 组装 authorize URL（302 到 SSO 登录页） */
export function buildAuthorizeUrl(pkce: { challenge: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: AUTH_OAUTH_CLIENT_ID,
    redirect_uri: AUTH_SSO_REDIRECT_URI,
    response_type: 'code',
    scope: 'read',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.state,
  })
  return `${getAuthGatewayUrl()}/oauth/authorize?${params.toString()}`
}

// ===== 令牌持久化 =====

function getAuthStorePath(): string {
  return join(getConfigDir(), 'auth.json')
}

function encryptToken(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) return plain
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptToken(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable()) return encrypted
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch (error) {
    console.error('[登录] 解密令牌失败:', error)
    throw new Error('解密登录令牌失败')
  }
}

function readTokenStore(): AuthTokenStore | null {
  const path = getAuthStorePath()
  if (!existsSync(path)) return null
  const parsed = readJsonFileSafe<AuthTokenStore>(path)
  if (!parsed || !parsed.accessToken || !parsed.refreshToken || !parsed.user) return null
  return parsed
}

function writeTokenStore(store: AuthTokenStore): void {
  writeJsonFileAtomic(getAuthStorePath(), {
    accessToken: encryptToken(store.accessToken),
    refreshToken: encryptToken(store.refreshToken),
    expiresAt: store.expiresAt,
    user: store.user,
    loggedInAt: store.loggedInAt,
  })
}

function clearTokenStore(): void {
  const path = getAuthStorePath()
  if (existsSync(path)) rmSync(path)
}

function toSession(store: AuthTokenStore): AuthSession {
  return {
    user: store.user,
    loggedInAt: store.loggedInAt,
    expiresAt: store.expiresAt,
  }
}

// ===== 网关请求 =====

/** 网关响应信封：直连 IAM 为 {success,data}，经网关为 {code:0,data}；错误为 {success:false,error} */
interface GatewayEnvelope {
  success?: boolean
  code?: number
  data?: unknown
  error?: { message?: string; code?: string }
  message?: string
}

/** 解析网关信封，成功返回 data，失败返回可读错误信息 */
function parseEnvelope(payload: GatewayEnvelope, fallbackError: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const isSuccess = payload.success === true || payload.code === 0
  if (isSuccess && payload.data && typeof payload.data === 'object') {
    return { ok: true, data: payload.data as Record<string, unknown> }
  }
  const message = payload.error?.message ?? payload.message ?? fallbackError
  return { ok: false, error: message }
}

function toAuthUserInfo(raw: RawUserInfo): AuthUserInfo {
  return {
    sub: raw.sub ?? '',
    fullName: raw.fullName,
    mobileNo: raw.mobileNo,
    roles: raw.roles,
    roleName: raw.rns?.[0],
    tenantId: raw.tenantId,
    tenantName: raw.tenantName,
  }
}

async function gatewayFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${getAuthGatewayUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS),
  })
}

/** 网络类错误信息归一 */
function formatNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `无法连接登录服务（${getAuthGatewayUrl()}）：${message}`
}

/** 用 access_token 调 userinfo；网络失败抛出，鉴权失败返回 null */
async function fetchUserInfo(accessToken: string): Promise<AuthUserInfo | null> {
  const response = await gatewayFetch('/oauth/userinfo', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (response.status === 401) return null
  const payload = await response.json() as GatewayEnvelope
  const parsed = parseEnvelope(payload, '获取用户信息失败')
  if (!parsed.ok) throw new Error(parsed.error)
  return toAuthUserInfo(parsed.data as RawUserInfo)
}

/** OAuth token 端点请求体 */
async function requestToken(body: Record<string, string>): Promise<
  { ok: true; accessToken: string; refreshToken: string; expiresIn: number } | { ok: false; error: string }
> {
  let response: Response
  try {
    response = await gatewayFetch('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, error: formatNetworkError(error) }
  }

  const payload = await response.json().catch(() => ({}) as GatewayEnvelope)
  const parsed = parseEnvelope(payload, response.ok ? '登录服务返回异常' : `登录失败（HTTP ${response.status}）`)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  const accessToken = typeof parsed.data.access_token === 'string' ? parsed.data.access_token : ''
  const refreshToken = typeof parsed.data.refresh_token === 'string' ? parsed.data.refresh_token : ''
  const expiresIn = typeof parsed.data.expires_in === 'number' ? parsed.data.expires_in : 0
  if (!accessToken || !refreshToken) return { ok: false, error: '登录服务响应缺少令牌' }
  return { ok: true, accessToken, refreshToken, expiresIn }
}

// ===== SSO 登录窗口（可注入以便测试） =====

/** SSO 登录窗口控制器 */
export interface SsoWindowController {
  /** 主动关闭登录窗口（取消登录） */
  close: () => void
}

/** 打开 SSO 登录窗口的依赖注入点 */
export type SsoWindowOpener = (
  authorizeUrl: string,
  handlers: {
    /** 拦截到回调跳转（携带 code/state 的完整 URL） */
    onCallbackUrl: (url: string) => void
    /** 用户关闭了登录窗口 */
    onClosed: () => void
  },
) => SsoWindowController

/** 默认实现：内嵌 BrowserWindow，拦截注册回调地址的跳转 */
const defaultSsoWindowOpener: SsoWindowOpener = (authorizeUrl, handlers) => {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    title: '登录欧尼博平台',
    autoHideMenuBar: true,
    resizable: true,
    show: true,
    webPreferences: {
      // SSO 页面为外部站点，不需要 node/preload；独立 partition 避免污染应用会话
      partition: 'persist:ounibo-sso',
    },
  })

  const interceptCallback = (event: Electron.Event, url: string): void => {
    if (!url.startsWith(AUTH_SSO_REDIRECT_URI)) return
    event.preventDefault()
    handlers.onCallbackUrl(url)
    win.destroy()
  }
  win.webContents.on('will-navigate', interceptCallback)
  win.webContents.on('will-redirect', interceptCallback)
  win.on('closed', () => handlers.onClosed())
  void win.loadURL(authorizeUrl)

  return { close: () => win.destroy() }
}

/** 从回调 URL 解析 code/state；结构不符返回 null */
function parseCallbackUrl(url: string): { code: string; state: string } | null {
  try {
    const parsed = new URL(url)
    const code = parsed.searchParams.get('code')
    const state = parsed.searchParams.get('state')
    if (!code || !state) return null
    return { code, state }
  } catch {
    return null
  }
}

/**
 * 登录：授权码 + PKCE。
 * 打开 SSO 登录窗口 → 拦截回调 → 换取令牌 → 拉取用户信息 → 持久化会话。
 */
export async function login(opener: SsoWindowOpener = defaultSsoWindowOpener): Promise<AuthLoginResult> {
  const pkce = generatePkcePair()

  const callbackPromise = new Promise<{ kind: 'callback'; url: string } | { kind: 'closed' }>((resolve) => {
    const controller = opener(buildAuthorizeUrl(pkce), {
      onCallbackUrl: (url) => resolve({ kind: 'callback', url }),
      onClosed: () => resolve({ kind: 'closed' }),
    })
    void controller
  })

  const outcome = await callbackPromise
  if (outcome.kind === 'closed') {
    return { success: false, error: '已取消登录', cancelled: true }
  }

  const callback = parseCallbackUrl(outcome.url)
  if (!callback) {
    return { success: false, error: '登录回调参数不完整' }
  }
  if (callback.state !== pkce.state) {
    return { success: false, error: '登录回调 state 校验失败，请重试' }
  }

  const token = await requestToken({
    grant_type: 'authorization_code',
    client_id: AUTH_OAUTH_CLIENT_ID,
    code: callback.code,
    code_verifier: pkce.verifier,
    redirect_uri: AUTH_SSO_REDIRECT_URI,
  })
  if (!token.ok) return { success: false, error: token.error }

  let user: AuthUserInfo
  try {
    const fetched = await fetchUserInfo(token.accessToken)
    if (fetched === null) return { success: false, error: '登录成功但获取用户信息被拒绝' }
    user = fetched
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }

  const session: AuthSession = {
    user,
    loggedInAt: Date.now(),
    expiresAt: Date.now() + token.expiresIn * 1000,
  }
  writeTokenStore({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: session.expiresAt,
    user,
    loggedInAt: session.loggedInAt,
  })
  console.log(`[登录] 用户 ${user.fullName ?? user.sub} 登录成功`)
  return { success: true, session }
}

/**
 * 登出：撤销 refresh_token 并清除本地会话（无论撤销是否成功都清除）
 */
export async function logout(): Promise<void> {
  const store = readTokenStore()
  if (store) {
    try {
      await gatewayFetch('/oauth/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: store.refreshToken }),
      })
    } catch (error) {
      console.warn('[登录] 撤销令牌失败（仍将清除本地会话）:', error)
    }
  }
  clearTokenStore()
  console.log('[登录] 已登出')
}

/**
 * 获取门禁状态：
 * - 无本地会话 → logged-out
 * - access 未过期 → 用 userinfo 复核（网络失败容忍，返回缓存会话）
 * - access 过期 → 尝试 refresh；失败且 userinfo 也拒绝 → 清除会话
 */
export async function getAuthState(): Promise<AuthGateStatus> {
  let store = readTokenStore()
  if (!store) return { status: 'logged-out' }

  // 提前刷新临期令牌
  if (store.expiresAt - ACCESS_TOKEN_REFRESH_SKEW_MS <= Date.now()) {
    const refreshed = await requestToken({
      grant_type: 'refresh_token',
      client_id: AUTH_OAUTH_CLIENT_ID,
      refresh_token: store.refreshToken,
    })
    if (refreshed.ok) {
      store = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        user: store.user,
        loggedInAt: store.loggedInAt,
      }
      writeTokenStore(store)
      console.log('[登录] 已刷新访问令牌')
    }
  }

  try {
    const user = await fetchUserInfo(store.accessToken)
    if (user === null) {
      // access 被拒绝：再尝试一次 refresh，仍失败则判定登出
      const retry = await requestToken({
        grant_type: 'refresh_token',
        client_id: AUTH_OAUTH_CLIENT_ID,
        refresh_token: store.refreshToken,
      })
      if (retry.ok) {
        const retryUser = await fetchUserInfo(retry.accessToken)
        if (retryUser !== null) {
          const next: AuthTokenStore = {
            accessToken: retry.accessToken,
            refreshToken: retry.refreshToken,
            expiresAt: Date.now() + retry.expiresIn * 1000,
            user: retryUser ?? store.user,
            loggedInAt: store.loggedInAt,
          }
          writeTokenStore(next)
          return { status: 'logged-in', session: toSession(next) }
        }
      }
      clearTokenStore()
      return { status: 'logged-out' }
    }
    // 复核成功，回写最新用户信息
    const updated: AuthTokenStore = { ...store, user }
    writeTokenStore(updated)
    return { status: 'logged-in', session: toSession(updated) }
  } catch (error) {
    // 网关不可达：离线容忍，保留本地会话
    console.warn('[登录] 校验会话时无法连接登录服务，保留本地会话:', error)
    return { status: 'logged-in', session: toSession(store) }
  }
}
