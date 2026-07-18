'use client'

// Shown on the platform-staff home when the CALLER's HR profile has employment
// agreement text but no acknowledgment yet. The acknowledge action is strictly
// self-row (no target parameter) and audited.

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { FileSignature, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { acknowledgeMyAgreementAction } from '@/app/actions/superadmin/platform-staff'

export function AgreementAckBanner({ agreementText }: { agreementText: string }) {
  const [open, setOpen] = useState(false)
  const [acknowledgedAt, setAcknowledgedAt] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()

  function acknowledge() {
    startTransition(async () => {
      const r = await acknowledgeMyAgreementAction()
      if (r.ok && r.acknowledgedAt) { setAcknowledgedAt(r.acknowledgedAt); toast({ title: 'Agreement acknowledged' }) }
      else if (!r.ok) toast({ title: 'Error', description: r.error, variant: 'destructive' })
    })
  }

  if (acknowledgedAt) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
        Employment agreement acknowledged {new Date(acknowledgedAt).toLocaleString()}. Thank you.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <FileSignature className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900">Your employment agreement needs your acknowledgment</p>
          <p className="text-xs text-amber-800 mt-0.5">
            HR has placed an employment agreement on your staff profile. Please read it, then acknowledge — the timestamp is recorded.
          </p>
          <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-amber-900 underline" onClick={() => setOpen((o) => !o)}>
            {open ? <>Hide agreement <ChevronUp className="h-3 w-3" /></> : <>Read the agreement <ChevronDown className="h-3 w-3" /></>}
          </button>
          {open && (
            <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-amber-200 bg-white p-3 text-xs text-slate-800 font-sans">{agreementText}</pre>
          )}
        </div>
        <Button size="sm" disabled={pending} onClick={acknowledge} className="shrink-0">
          {pending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}I acknowledge
        </Button>
      </div>
    </div>
  )
}
