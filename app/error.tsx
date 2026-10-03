"use client"

// ROOT error boundary — every segment that has no boundary of its own.
//
// Lane 89D (wave 89 production walkthrough). Measured on base 1e4fac17: the
// tree carried exactly four error.tsx files (app/dashboard, app/dashboard/agent,
// app/settings, app/crm/contacts/[contactId]) and NO root boundary, so a throw
// anywhere under /crm, /leads, /portal/**, /vendor/**, /lender/**, /title/**,
// /transaction/**, /compliance/**, /lifetime-customers, /referrals, /offers,
// /analytics, /academy, /workflows, /notifications, /approvals and the public
// pages rendered the App Router's default BLANK screen — the same "blank page"
// symptom app/dashboard/error.tsx was written to end for /dashboard/**.
//
// This mirrors that boundary (the survivor for the copy and the retry shape)
// rather than a new design. More specific boundaries still win for their own
// segments. It never bounces to /login: the user is still signed in.

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Root] Error boundary:", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">This page hit a snag</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Something went wrong loading this page. Try again, or head back to your dashboard.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">Try Again</Button>
        <Button asChild variant="ghost">
          <a href="/dashboard">Back to Dashboard</a>
        </Button>
      </div>
    </div>
  )
}
