"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function AgentDashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[AgentDashboard] Error boundary:", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">Dashboard failed to load</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Something went wrong loading the agent dashboard. Please try again.
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
