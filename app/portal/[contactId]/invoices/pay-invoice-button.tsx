"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { CreditCard, Loader2 } from "lucide-react"
import { startVendorInvoiceCheckout } from "@/app/actions/vendor-payments"

/**
 * Pay-online button — only rendered when the vendor's Stripe Connect onboarding is
 * complete. Starts a Stripe Checkout session (destination charge on the VENDOR's
 * account) and redirects; the return URL verifies the session against Stripe before
 * anything is marked paid.
 */
export function PayInvoiceButton({
  contactId,
  invoiceId,
  amountLabel,
  vendorName,
}: {
  contactId: string
  invoiceId: string
  amountLabel: string
  vendorName: string
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handlePay() {
    setError(null)
    startTransition(async () => {
      const res = await startVendorInvoiceCheckout({ contactId, invoiceId })
      if (res.success && res.url) {
        window.location.href = res.url
      } else {
        setError(res.error ?? "Could not start checkout")
      }
    })
  }

  return (
    <div className="space-y-2">
      <Button onClick={handlePay} disabled={isPending} className="w-full sm:w-auto">
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <CreditCard className="h-4 w-4 mr-2" />
        )}
        Pay {amountLabel} online
      </Button>
      <p className="text-xs text-muted-foreground">
        Secure payment via Stripe — paid directly to {vendorName}.
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
