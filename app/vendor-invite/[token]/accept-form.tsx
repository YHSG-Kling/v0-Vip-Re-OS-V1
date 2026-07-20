"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { CheckCircle2, FileBadge, Loader2, X } from "lucide-react"
import { acceptVendorInviteAction } from "@/app/actions/vendor-invite"

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [accepted, setAccepted] = useState<{ redirectTo: string } | null>(null)

  function handleAccept() {
    setError(null)
    startTransition(async () => {
      const r = await acceptVendorInviteAction(token)
      if (!r.ok) { setError(r.error ?? "Failed to accept invitation"); return }
      // Surface the W-9 step (owner round 43) before landing in the portal —
      // the brokerage must 1099-report payments, which needs a W-9 on file.
      setAccepted({ redirectTo: r.redirectTo ?? "/portal/vendor" })
    })
  }

  if (accepted) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-2 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> Account linked — you're in.
        </p>
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium flex items-center gap-2">
            <FileBadge className="h-4 w-4" /> One setup step: put your W-9 on file
          </p>
          <p className="text-xs mt-1">
            Your brokerage partner reports payments to the IRS (Form 1099) — that needs your
            signed W-9. Payments aren't blocked, but every payout and invoice will carry a
            warning until it's on file.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/vendor/documents">
            <Button><FileBadge className="h-4 w-4 mr-2" />Upload my W-9 now</Button>
          </Link>
          <Button variant="ghost" onClick={() => router.push(accepted.redirectTo)}>
            Skip for now — go to my jobs
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button onClick={handleAccept} disabled={isPending}>
          {isPending
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Linking your account…</>
            : <><CheckCircle2 className="h-4 w-4 mr-2" />Accept and continue to my jobs</>}
        </Button>
        <Button variant="ghost" onClick={() => router.push("/")} disabled={isPending}>
          <X className="h-4 w-4 mr-1" /> Decline
        </Button>
      </div>
      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</p>
      )}
    </div>
  )
}
