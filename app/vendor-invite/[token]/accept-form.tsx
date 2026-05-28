"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CheckCircle2, Loader2, X } from "lucide-react"
import { acceptVendorInviteAction } from "@/app/actions/vendor-invite"

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function handleAccept() {
    setError(null)
    startTransition(async () => {
      const r = await acceptVendorInviteAction(token)
      if (!r.ok) { setError(r.error ?? "Failed to accept invitation"); return }
      router.push(r.redirectTo ?? "/portal/vendor")
    })
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
