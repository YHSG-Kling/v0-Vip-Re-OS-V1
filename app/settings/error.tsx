"use client"

// Subtree error boundary for the whole /settings/** tree. Without it, a throw in
// any settings page renders a BLANK WHITE SCREEN in the App Router. This keeps the
// settings shell and shows an in-place retry card instead.

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Settings] Error boundary:", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center px-4">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">This settings page hit a snag</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Something went wrong loading this settings section — you&rsquo;re still signed in. Try again,
        or return to Settings.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">Try Again</Button>
        <Button asChild variant="ghost">
          <a href="/settings">Back to Settings</a>
        </Button>
      </div>
    </div>
  )
}
