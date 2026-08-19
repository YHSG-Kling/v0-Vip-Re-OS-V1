"use client"

/**
 * app/dashboard/admin/cron-health/reproject-portal-button.tsx
 *
 * On-demand re-run of the portal-stream projector.
 *
 * `triggerPortalProjectionAction` was written for exactly this — the cron route
 * it calls documents an "admin on-demand reprojection" path — and had no
 * caller, so the only way to refresh portal_event_stream between scheduled
 * ticks was to wait for the cron. Cron Health is where an admin already goes to
 * see that a projector has gone stale, so the re-run lives next to the evidence
 * that it needs re-running.
 *
 * The action is the authority on who may do this: it resolves the caller's
 * users.user_type / platform_role and refuses anyone who is not a broker,
 * brokerage admin or platform superadmin, failing CLOSED on a refused profile
 * read. This page is already gated to admin/broker, so the button is not the
 * gate — it is the entry point.
 */

import { useState, useTransition } from "react"
import { RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { triggerPortalProjectionAction } from "@/app/actions/portal-stream"

export function ReprojectPortalButton() {
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function run() {
    startTransition(async () => {
      setMessage(null)
      const result = await triggerPortalProjectionAction()
      // The action RETURNS its refusal ("Forbidden…", "CRON_SECRET not
      // configured", a non-2xx from the projector). Reporting success on
      // anything other than success would claim a projection pass that never
      // happened.
      setMessage(
        result.success
          ? { ok: true, text: "Projection pass completed." }
          : { ok: false, text: result.error ?? "The projection did not run." },
      )
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" size="sm" onClick={run} disabled={isPending}>
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 mr-2" />
        )}
        Re-run portal projection
      </Button>
      {message && (
        <span className={message.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>
          {message.text}
        </span>
      )}
    </div>
  )
}
