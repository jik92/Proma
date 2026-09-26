/**
 * LoginView - 登录页
 *
 * 欧尼博平台登录门禁的全屏登录界面。
 * 点击登录按钮后由主进程弹出 SSO 登录窗口（moment-factory-platform
 * 授权码 + PKCE 流程），本页不接触用户密码。
 */

import * as React from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ouniboMarkWhite from '@/assets/onboarding/ounibo-mark-white.png'
import type { AuthSession } from '@/types/auth'

interface LoginViewProps {
  /** 登录成功回调 */
  onLoggedIn: (session: AuthSession) => void
}

export function LoginView({ onLoggedIn }: LoginViewProps): React.ReactElement {
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleLogin = async (): Promise<void> => {
    if (submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI.authLogin()
      if (result.success) {
        onLoggedIn(result.session)
      } else {
        setError(result.error)
        setSubmitting(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请重试')
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-background">
      <div
        className="w-[360px] max-w-[calc(100vw-48px)] rounded-2xl border border-border/60 bg-card p-8 shadow-sm"
        aria-label="登录欧尼博平台"
      >
        <div className="flex flex-col items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-[#2868F8]">
            <img src={ouniboMarkWhite} alt="欧尼博平台" className="size-9" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold text-foreground">欧尼博平台</h1>
            <p className="mt-1 text-xs text-muted-foreground">请使用企业账号登录后继续使用</p>
          </div>
        </div>

        <div className="mt-8">
          {error && (
            <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
              {error}
            </p>
          )}
          <Button type="button" className="w-full gap-2" onClick={handleLogin} disabled={submitting}>
            {submitting
              ? <Loader2 size={15} className="animate-spin" />
              : <LogIn size={15} />}
            {submitting ? '等待登录完成…' : '使用企业账号登录'}
          </Button>
          {submitting && (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              已打开登录窗口，请在其页面完成登录；关闭该窗口将取消
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
