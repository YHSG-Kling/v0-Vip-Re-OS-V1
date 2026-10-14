'use client'

// Persistent "terms have changed, please re-accept" banner — the re-prompt gate
// for platform_tos_acceptances (readerless-write-census: tos_version/email were
// written at signup and nothing ever checked them again against a later version
// bump). Same slot/pattern as ImpersonationBanner. Silent for a user who has
// already accepted the current version, or who isn't signed in.
import { useEffect, useState, useTransition } from 'react'
import { ShieldAlert } from 'lucide-react'
import { checkCurrentUserTosStatusAction, acceptCurrentTosAsCurrentUserAction } from '@/app/actions/public/tos-acceptance'

export function TosReacceptanceBanner() {
  const [needsAcceptance, setNeedsAcceptance] = useState(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [pending, startTransition] = useTransition()

  async function refresh() {
    try {
      const result = await checkCurrentUserTosStatusAction()
      if (result.ok) {
        setNeedsAcceptance(result.needsAcceptance)
        setCurrentVersion(result.currentVersion)
      }
    } catch { /* signed out */ }
  }

  useEffect(() => { refresh() }, [])

  if (!needsAcceptance) return null

  const accept = () =>
    startTransition(async () => { await acceptCurrentTosAsCurrentUserAction(); await refresh() })

  return (
    <div className="flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-amber-950">
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span className="flex-1 truncate">
        Our Terms of Service have been updated{currentVersion ? ` (${currentVersion})` : ''}. Please review and re-accept to continue.
      </span>
      <button
        onClick={accept}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded bg-amber-950 px-2.5 py-1 text-xs font-semibold text-amber-50 hover:bg-amber-900 disabled:opacity-60"
      >
        {pending ? 'Accepting…' : 'I accept'}
      </button>
    </div>
  )
}
