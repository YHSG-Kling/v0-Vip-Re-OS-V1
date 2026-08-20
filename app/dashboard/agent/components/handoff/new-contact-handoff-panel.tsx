"use client"

// app/dashboard/agent/components/handoff/new-contact-handoff-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// "A NEW CONTACT WAS ADDED TO YOU" — the agent-side first-touch heads-up.
//
// OWNER RULING, verbatim: "their needs to be an agent side first touch
// acknolegement becaue the agent needs a heads up that a new contact has been
// added and contact welcome package sent."
//
// This is the ONLY caller of `acknowledgeLeadHandoffAction`, which flips
// `assignment_log.claimed` false → true and emits LEAD_CLAIMED. Three live
// surfaces read that flag as "still awaiting first touch"
// (daily-briefing-generator, isa-overnight `handoffs_unclaimed`,
// user-type-briefs/team-lead); until this panel existed the flag had no writer
// and those counters could only go up.
//
// ── WHAT THIS PANEL WILL AND WILL NOT SAY ───────────────────────────────────
//
// It shows the CONTACT the lead became, never a lead row — the standing access
// ruling. Name, type, channel, when it landed. No lead fields exist in the
// payload to render.
//
// And it does NOT print "welcome package sent" as a slogan. `ensureClientWelcome`
// (lib/kernel/client-welcome.ts) records what happened on `agent_client_messages`,
// and that table's status column is the only record of it. So each row prints the
// ledger's own answer — sent (with the timestamp), approved-but-not-yet-sent,
// drafted-and-waiting, failed, or nothing on record at all. A handoff with no
// welcome row says so plainly, which is the point: an unverified send is not
// worth more than an honest blank.
//
// 'sent' HERE MEANS A PROVIDER ACCEPTED IT. Per the owner ruling the welcome now
// goes out from the assigned agent through the canonical governed egress, and the
// ledger is stamped 'sent' only on a provider success (evidence line on
// `rationale`). "Drafted and waiting" is what a send HELD by the manager-autonomy
// gate looks like — the broker's posture asked for a human on this one.
//
// NOTE THAT AN AGENT CANNOT APPROVE THE DRAFT THEMSELVES. `client_message`
// approval lives only in the admin Command Center (app/actions/command-center.ts
// gates it to admin/broker/broker_owner) — it is NOT in the /approvals queue
// (lib/kernel/approval-queue-aggregator.ts carries no client_message lane). That
// is exactly why the default path no longer depends on a per-message approval the
// assigned agent cannot give: a drafted-but-unsent welcome is still reported as
// waiting on the brokerage, with no link offered to a page this reader cannot act on.
//
// Acknowledging is NOT claiming. The contact is already theirs; this records
// that a human has seen the handoff.

import { useCallback, useEffect, useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import {
  ArrowRight,
  BellRing,
  CheckCircle2,
  Clock,
  FileWarning,
  Handshake,
  Mail,
  MailCheck,
  Phone,
  ShieldAlert,
} from "lucide-react"
import {
  listMyPendingHandoffsAction,
  type PendingHandoff,
  type WelcomePackageState,
} from "@/app/actions/lead-handoff/pending-handoffs"
import { acknowledgeLeadHandoffAction } from "@/app/actions/lead-assignment/assign-lead"

/** Exactly what the agent_client_messages ledger supports saying. */
const WELCOME_COPY: Record<
  WelcomePackageState,
  { label: string; detail: string; tone: string; icon: typeof MailCheck }
> = {
  sent: {
    label: "Welcome package sent",
    detail: "Confirmed on the client-message ledger.",
    tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
    icon: MailCheck,
  },
  approved_not_sent: {
    label: "Welcome package approved — not yet sent",
    detail: "Approved on the ledger; no send has been recorded yet.",
    tone: "bg-sky-50 text-sky-700 border-sky-200",
    icon: Clock,
  },
  drafted_awaiting_approval: {
    label: "Welcome package drafted — NOT sent",
    detail: "Waiting on brokerage approval in the Command Center. Nothing has reached this contact yet.",
    tone: "bg-amber-50 text-amber-700 border-amber-200",
    icon: FileWarning,
  },
  send_failed: {
    label: "Welcome package FAILED to send",
    detail: "The ledger recorded a send failure — this contact has not been welcomed.",
    tone: "bg-red-50 text-red-700 border-red-200",
    icon: ShieldAlert,
  },
  rejected: {
    label: "Welcome package rejected",
    detail: "The draft was rejected on review. Nothing was sent.",
    tone: "bg-red-50 text-red-700 border-red-200",
    icon: ShieldAlert,
  },
  none_on_record: {
    label: "No welcome package on record",
    detail: "Nothing has been drafted or sent for this contact. Yours is the first touch.",
    tone: "bg-muted text-muted-foreground border-border",
    icon: FileWarning,
  },
}

function formatWhen(value: string | null): string {
  if (!value) return "recently"
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return "recently"
  const mins = Math.floor((Date.now() - then) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatStamp(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

export function NewContactHandoffPanel() {
  const [handoffs, setHandoffs] = useState<PendingHandoff[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acking, setAcking] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  const load = useCallback(async () => {
    const res = await listMyPendingHandoffsAction()
    if (!res.ok) {
      setError(res.reason)
      setHandoffs([])
    } else {
      setError(null)
      setHandoffs(res.handoffs)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const acknowledge = useCallback(
    async (handoff: PendingHandoff) => {
      setAcking(handoff.handoffLeadId)
      try {
        // The action re-reads the session and re-proves this caller is the
        // assigned agent before it writes — the id below grants nothing.
        const res = await acknowledgeLeadHandoffAction(handoff.handoffLeadId)
        if (!res.success) {
          toast.error(
            res.reason === "already_claimed"
              ? "That handoff was already acknowledged."
              : `Could not acknowledge: ${res.reason ?? "unknown reason"}`,
          )
          // A refusal can mean the world moved — re-read rather than guess.
          startTransition(() => { void load() })
          return
        }
        toast.success(`First touch acknowledged for ${handoff.contactName}.`)
        setHandoffs((prev) => prev.filter((h) => h.handoffLeadId !== handoff.handoffLeadId))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not acknowledge that handoff")
      } finally {
        setAcking(null)
      }
    },
    [load],
  )

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-blue-600" />
            New Contacts Assigned to You
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-blue-600" />
            New Contacts Assigned to You
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Could not load your handoffs</p>
              <p className="text-xs">{error}</p>
              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={() => { setLoading(true); void load() }}>
                Try again
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (handoffs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="h-4 w-4 text-blue-600" />
            New Contacts Assigned to You
          </CardTitle>
          <CardDescription>Handoffs awaiting your first touch</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="py-8 text-center text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-2 h-8 w-8 opacity-50" />
            <p className="text-sm">Nothing awaiting acknowledgement</p>
            <p className="mt-1 text-xs">New contacts assigned to you land here first.</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-blue-200">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BellRing className="h-4 w-4 text-blue-600" />
              New Contacts Assigned to You
            </CardTitle>
            <CardDescription>
              {handoffs.length} new {handoffs.length === 1 ? "contact is" : "contacts are"} yours and
              {" "}{handoffs.length === 1 ? "has" : "have"} not been acknowledged yet
            </CardDescription>
          </div>
          <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">
            {handoffs.length} awaiting first touch
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {handoffs.map((h) => {
          const w = WELCOME_COPY[h.welcome.state]
          const WIcon = w.icon
          const stamp =
            h.welcome.state === "sent"
              ? formatStamp(h.welcome.sentAt)
              : h.welcome.state === "approved_not_sent"
                ? formatStamp(h.welcome.approvedAt)
                : formatStamp(h.welcome.proposedAt)

          return (
            <div key={h.handoffLeadId} className="rounded-lg border p-3 transition-colors hover:bg-muted/30">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/crm/contacts/${h.contactId}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {h.contactName}
                    </Link>
                    {h.contactType && (
                      <Badge variant="outline" className="text-xs capitalize">
                        {h.contactType.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </div>

                  <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Handshake className="h-3 w-3" />
                      Assigned {formatWhen(h.assignedAt)}
                      {h.assignmentMethod ? ` · ${h.assignmentMethod.replace(/_/g, " ")}` : ""}
                    </span>
                    {h.preferredChannel && <span>Prefers {h.preferredChannel}</span>}
                  </div>

                  {/* The welcome claim — whatever the ledger actually says. */}
                  <div className={`flex items-start gap-1.5 rounded border p-2 text-xs ${w.tone}`}>
                    <WIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      <span className="font-medium">{w.label}</span>
                      {stamp ? ` (${stamp})` : ""} — {w.detail}
                      {h.welcome.error ? ` ${h.welcome.error}` : ""}
                    </span>
                  </div>
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  {h.phone && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                      <a href={`tel:${h.phone}`}>
                        <Phone className="mr-1 h-3 w-3" />
                        Call
                      </a>
                    </Button>
                  )}
                  {h.email && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                      <a href={`mailto:${h.email}`}>
                        <Mail className="mr-1 h-3 w-3" />
                        Email
                      </a>
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                <Link href={`/crm/contacts/${h.contactId}`}>
                  <Button size="sm" variant="ghost" className="h-7 text-xs">
                    Open contact
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </Link>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={acking === h.handoffLeadId}
                  onClick={() => void acknowledge(h)}
                >
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  {acking === h.handoffLeadId ? "Acknowledging…" : "I've got it — acknowledge"}
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

export default NewContactHandoffPanel
