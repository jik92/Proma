/**
 * 登录门禁 Atom
 *
 * 登录态由主进程 auth-service 持有（令牌加密落盘），
 * 渲染进程仅保存门禁状态快照；未登录时 App 显示登录页。
 */

import { atom } from 'jotai'
import type { AuthGateStatus, AuthSession } from '../../types'

/** 门禁状态：checking（启动校验中）/ logged-out / logged-in */
export const authGateAtom = atom<AuthGateStatus>({ status: 'checking' })

/** 当前登录会话；未登录时为 null */
export const authSessionAtom = atom<AuthSession | null>((get) => {
  const gate = get(authGateAtom)
  return gate.status === 'logged-in' ? gate.session : null
})
