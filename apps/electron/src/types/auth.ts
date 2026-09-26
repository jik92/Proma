/**
 * 登录门禁类型与 IPC 通道
 *
 * 欧尼博平台登录态对接 moment-factory-platform 生产网关：
 * OAuth2 授权码 + PKCE，经内嵌 SSO 登录窗口完成，不接触用户密码。
 * 渲染进程在获得登录会话前不可使用应用（登录门禁）。
 */

/** 登录网关（生产）；可用 PROMA_AUTH_GATEWAY 覆盖（本地联调指向 http://localhost:4000） */
export const DEFAULT_AUTH_GATEWAY_URL = 'https://api.ounirobot.com'

/** 维修平台公共 OAuth 客户端（授权码 + PKCE，免 client_secret） */
export const AUTH_OAUTH_CLIENT_ID = 'moment-factory-im-client'

/** SSO 登录成功后注册在服务端的回调地址（客户端拦截该跳转取 code，不真正加载） */
export const AUTH_SSO_REDIRECT_URI = 'https://app.ounirobot.com/auth/callback'

/** 登录后从 /oauth/userinfo 获取的用户信息（已裁剪） */
export interface AuthUserInfo {
  /** 用户唯一标识（手机号） */
  sub: string
  /** 姓名 */
  fullName?: string
  /** 手机号 */
  mobileNo?: string
  /** 角色编码列表 */
  roles?: string[]
  /** 主角色显示名 */
  roleName?: string
  /** 租户 ID */
  tenantId?: string
  /** 租户名称 */
  tenantName?: string
}

/** 已登录会话（渲染进程可见，不包含令牌） */
export interface AuthSession {
  user: AuthUserInfo
  /** 登录时间（毫秒时间戳） */
  loggedInAt: number
  /** access_token 过期时间（毫秒时间戳） */
  expiresAt: number
}

/** 登录结果：失败时携带可读错误信息；用户关闭登录窗视为取消 */
export type AuthLoginResult =
  | { success: true; session: AuthSession }
  | { success: false; error: string; cancelled?: boolean }

/** 门禁状态：checking 表示启动时校验会话中 */
export type AuthGateStatus =
  | { status: 'checking' }
  | { status: 'logged-out' }
  | { status: 'logged-in'; session: AuthSession }

/** 登录 IPC 通道 */
export const AUTH_IPC_CHANNELS = {
  LOGIN: 'auth:login',
  GET_STATE: 'auth:get-state',
  LOGOUT: 'auth:logout',
} as const
