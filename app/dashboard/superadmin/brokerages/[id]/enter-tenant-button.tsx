'use client'

// "Enter tenant" — begins an audited impersonation session, then lands the staff member
// in the tenant's dashboard. From there getAgentContext resolves the target tenant on
// every server surface until they Exit (banner) or the session auto-expires.
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { LogIn } from 'lucide-react'
import { enterTenantAction } from '@/app/actions/superadmin/impersonation'

export function EnterTenantButton({ brokerageId }: { brokerageId: string }) {
  const router = useRouter()
  const [err, setErr] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const enter = () =>
    startTransition(async () => {
      setErr(null)
      const r = await enterTenantAction({ brokerageId, mode: 'full', reason: 'god-console enter' })
      if (!r.ok) { setErr(r.error ?? 'Failed to enter tenant'); return }
      router.push('/dashboard')
    })

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" disabled={pending} onClick={enter} className="gap-1.5">
        <LogIn className="h-4 w-4" /> {pending ? 'Entering…' : 'Enter tenant'}
      </Button>
      {err && <span className="text-xs text-red-600">{err}</span>}
    </div>
  )
}
