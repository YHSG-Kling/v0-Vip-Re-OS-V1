"use client"

// Subtree error boundary for the whole /dashboard/** tree. Without this, any
// server- or client-component throw in a dashboard page (Twin Studio, Financials,
// Settings, …) renders a BLANK WHITE SCREEN in the App Router — the "blank page"
// symptom from the walkthrough. This converts that into an in-shell retry card so
// the user is never staring at nothing, and never wrongly bounced to /login.
// (More specific boundaries like app/dashboard/agent/error.tsx still win for their
// own segments.)

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Dashboard] Error boundary:", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">This page hit a snag</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Something went wrong loading this section — you&rsquo;re still signed in. Try again, or head
        back to your dashboard.
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
