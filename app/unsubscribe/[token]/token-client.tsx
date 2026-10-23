"use client"

/**
 * app/unsubscribe/[token]/token-client.tsx
 *
 * Two decisions, in the order a person holding a postcard makes them:
 *   1. "Stop sending me mail"  — the default, big, and what the piece asked about
 *   2. "Stop contacting me altogether" — the secondary, because someone who went
 *      to the trouble of typing a code off paper often means all of it, and
 *      making them hunt for a second surface is how opt-outs get ignored.
 *
 * The token shape is checked in the browser before any request is made, so an
 * obviously mistyped code says so immediately instead of costing a round trip.
 * That check is SHAPE ONLY — the server is the authority on whether the token
 * exists, and this component never sees a lead id, a contact id or a brokerage.
 */

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { CheckCircle, AlertTriangle, Mail, Loader2 } from "lucide-react"
import { isMailUnsubTokenShaped, formatMailUnsubTokenForPrint } from "@/lib/direct-mail/unsubscribe-token"

type Stage = "checking" | "confirm" | "processing" | "done" | "error" | "invalid"

export function MailUnsubscribeClient({ token }: { token: string }) {
  const [stage, setStage] = useState<Stage>(() => (isMailUnsubTokenShaped(token) ? "checking" : "invalid"))
  const [firstName, setFirstName] = useState<string | null>(null)
  const [scope, setScope] = useState<"mail" | "all">("mail")
  const [warning, setWarning] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Read-only preview. Confirms the code is real and personalises the question,
  // without writing anything — see the route's note on GET-fetching link scanners.
  useEffect(() => {
    if (stage !== "checking") return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/unsubscribe/token?token=${encodeURIComponent(token)}`)
        if (cancelled) return
        if (res.status === 404) {
          setStage("invalid")
          return
        }
        if (!res.ok) {
          setErrorMsg("We could not check that code right now. Please try again.")
          setStage("error")
          return
        }
        const data = await res.json()
        setFirstName(typeof data.firstName === "string" ? data.firstName : null)
        // An already-used code goes straight to the confirmed state rather than
        // asking a second time for a decision already made and honoured.
        setStage(data.alreadyUnsubscribed ? "done" : "confirm")
      } catch {
        if (!cancelled) {
          setErrorMsg("Network error. Please try again.")
          setStage("error")
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [stage, token])

  async function handleConfirm(request: "mail" | "all") {
    setScope(request)
    setStage("processing")
    try {
      const res = await fetch("/api/unsubscribe/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, request }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.")
        setStage("error")
        return
      }
      setWarning(typeof data.warning === "string" ? data.warning : null)
      setStage("done")
    } catch {
      setErrorMsg("Network error. Please try again.")
      setStage("error")
    }
  }

  if (stage === "invalid") {
    return (
      <PageShell>
        <AlertTriangle className="h-12 w-12 text-amber-500 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">We didn&apos;t recognise that code</h1>
        <p className="text-muted-foreground text-sm max-w-sm leading-relaxed">
          Please check the code printed on the mail piece and enter it exactly. It is 14 characters long and is not
          case-sensitive.
        </p>
        <p className="text-muted-foreground text-xs mt-4">
          Still stuck? Reply to the mail piece and we will remove you by hand.
        </p>
      </PageShell>
    )
  }

  if (stage === "checking") {
    return (
      <PageShell>
        <Loader2 className="h-10 w-10 text-muted-foreground mx-auto mb-4 animate-spin" />
        <p className="text-muted-foreground text-sm">Checking your code...</p>
      </PageShell>
    )
  }

  if (stage === "done") {
    return (
      <PageShell>
        <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">
          {scope === "all" ? "You have been removed from all contact" : "You have been removed from our mailing list"}
        </h1>
        <p className="text-muted-foreground text-sm max-w-sm leading-relaxed">
          {scope === "all"
            ? "We will stop sending you mail, email, texts and calls."
            : "We will stop sending you physical mail."}{" "}
          Pieces already at the post office may still arrive.
        </p>
        {warning ? (
          <p className="text-amber-600 dark:text-amber-500 text-xs mt-4 max-w-sm leading-relaxed">{warning}</p>
        ) : null}
        <p className="text-muted-foreground text-xs mt-4">
          You may still receive messages required to complete an active transaction.
        </p>
      </PageShell>
    )
  }

  if (stage === "error") {
    return (
      <PageShell>
        <AlertTriangle className="h-12 w-12 text-destructive mx-auto mb-4" />
        <h1 className="text-xl font-semibold text-foreground mb-2">Something went wrong</h1>
        <p className="text-muted-foreground text-sm mb-6">{errorMsg}</p>
        <Button variant="outline" onClick={() => setStage("confirm")}>
          Try again
        </Button>
      </PageShell>
    )
  }

  const busy = stage === "processing"

  return (
    <PageShell>
      <Mail className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
      <h1 className="text-xl font-semibold text-foreground mb-2">
        {firstName ? `${firstName}, stop receiving mail from us?` : "Stop receiving mail from us?"}
      </h1>
      <p className="text-muted-foreground text-sm mb-8 max-w-sm text-center leading-relaxed">
        We will remove you from the mailing list this piece came from, and from future mail campaigns.
      </p>
      <div className="flex flex-col gap-3 w-full max-w-xs">
        <Button variant="destructive" onClick={() => handleConfirm("mail")} disabled={busy}>
          {busy ? "Processing..." : "Stop sending me mail"}
        </Button>
        <Button variant="outline" onClick={() => handleConfirm("all")} disabled={busy}>
          Stop contacting me altogether
        </Button>
      </div>
      <p className="text-muted-foreground text-xs mt-8">
        Code {formatMailUnsubTokenForPrint(token)}
      </p>
    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-12 bg-background">
      <div className="w-full max-w-md flex flex-col items-center text-center gap-2">{children}</div>
      <p className="mt-12 text-xs text-muted-foreground">
        Equal Housing Opportunity &mdash; Powered by VIP Agents AI
      </p>
    </main>
  )
}
