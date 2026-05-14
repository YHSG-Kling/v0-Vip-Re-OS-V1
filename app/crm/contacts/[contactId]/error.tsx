"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { AlertTriangle, ArrowLeft, RefreshCw, Users } from "lucide-react"

export default function ContactError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    console.error("[ContactDetail] Error boundary:", error)
  }, [error])

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-6">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight">Contact Unavailable</h2>
          <p className="text-sm text-muted-foreground mt-1">
            There was a problem loading this contact profile. This may be a temporary issue.
          </p>
        </CardHeader>

        <CardContent className="text-center">
          {error.digest && (
            <p className="text-xs text-muted-foreground/60 font-mono bg-muted rounded px-2 py-1 inline-block">
              Ref: {error.digest}
            </p>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button onClick={reset} className="w-full gap-2">
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={() => router.push("/crm/contacts")}
          >
            <Users className="h-4 w-4" />
            Back to Contacts
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full gap-1.5 text-muted-foreground"
            onClick={() => router.back()}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Go Back
          </Button>
        </CardFooter>
      </Card>
    </div>
  )
}
