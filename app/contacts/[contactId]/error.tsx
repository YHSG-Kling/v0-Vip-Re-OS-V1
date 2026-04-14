"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "lucide-react"

export default function ContactError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[ContactDetail] Error boundary:", error)
  }, [error])

  return (
    <div className="container mx-auto py-16 flex flex-col items-center gap-4 text-center">
      <AlertTriangle className="h-10 w-10 text-destructive" />
      <h2 className="text-lg font-semibold">Unable to load contact</h2>
      <p className="text-sm text-muted-foreground max-w-sm">
        Something went wrong loading this contact record. Please try again.
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">Try Again</Button>
        <Button asChild variant="ghost">
          <a href="/dashboard/contacts">Back to Contacts</a>
        </Button>
      </div>
    </div>
  )
}
