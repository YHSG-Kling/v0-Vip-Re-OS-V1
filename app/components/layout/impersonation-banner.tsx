'use client'

// Persistent "you are acting as {tenant}" banner. Renders on every page whenever the
// signed-in platform-staff member has an active impersonation session, with a one-click
// Exit. Non-staff users never see it (the action returns { active:false }).
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, LogOut } from 'lucide-react'
import { getActiveImpersonationAction, exitTenantAction, type ActiveImpersonation } from '@/app/actions/superadmin/impersonation'

export function ImpersonationBanner() {
  const router = useRouter()
  const [state, setState] = useState<ActiveImpersonation>({ active: false })
  const [pending, startTransition] = useTransition()

  async function refresh() {
    try { setState(await getActiveImpersonationAction()) } catch { /* not staff / signed out */ }
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000) // reflect auto-expiry
    return () => clearInterval(t)
  }, [])

  if (!state.active) return null

  const exit = () =>
    startTransition(async () => { await exitTenantAction(); await refresh(); router.refresh() })

  const expires = state.expiresAt ? new Date(state.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null

  return (
    <div className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <Eye className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">
        {/* User-granular sessions name the target USER; tenant-wide sessions name the brokerage. */}
        {state.targetUserName ? (
          <>Acting as <strong>{state.targetUserName}</strong> at <strong>{state.targetBrokerageName ?? 'tenant'}</strong></>
        ) : (
          <>Acting as <strong>{state.targetBrokerageName ?? 'tenant'}</strong></>
        )}
        {state.mode === 'read_only' && <span className="ml-1 rounded bg-amber-700/20 px-1.5 py-0.5 text-[11px]">read-only</span>}
        {expires && <span className="ml-2 text-amber-900/80">· session ends {expires}</span>}
      </span>
      <button
        onClick={exit}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded bg-amber-950 px-2.5 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-900 disabled:opacity-60"
      >
        <LogOut className="h-3.5 w-3.5" /> {pending ? 'Exiting…' : 'Exit tenant'}
      </button>
    </div>
  )
}
