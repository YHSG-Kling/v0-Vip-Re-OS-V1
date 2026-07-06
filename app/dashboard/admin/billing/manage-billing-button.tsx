'use client'

import { useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { CreditCard, Loader2 } from 'lucide-react'
import { createBrokerageBillingPortalAction } from '@/app/actions/billing'
import { useToast } from '@/hooks/use-toast'

// Self-serve Stripe billing portal — manage card / invoices / cancellation. Parity
// with the vendor billing flow (one shared portal implementation).
export function ManageBillingButton() {
  const [pending, startTransition] = useTransition()
  const { toast } = useToast()
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => {
      const r = await createBrokerageBillingPortalAction()
      if (r.ok) window.location.href = r.url
      else toast({ title: 'Billing portal', description: r.error, variant: 'destructive' })
    })}>
      {pending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CreditCard className="h-4 w-4 mr-1.5" />}
      Manage billing
    </Button>
  )
}
