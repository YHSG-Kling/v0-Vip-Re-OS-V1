"use client"

import { useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Check, X, Phone } from "lucide-react"
import { proposeDialBatchAction, approveDialBatchAction, rejectDialBatchAction } from "@/app/actions/voice-dial-batch"

interface CallOutcome {
  contactId: string | null
  name: string | null
  placed: boolean
  error: string | null
}

interface Batch {
  id: string
  status: string
  script: string | null
  proposedCount: number
  dialedCount: number | null
  proposedAt: string | null
  completedAt: string | null
  targets: Array<{ name: string; propensity_score: number }>
  /** ai_isa_call_batches.approved_by — a users.id, stamped on approve AND on
   *  reject. Null means NOT RECORDED (a batch still proposed, or a legacy row);
   *  it never means "auto-approved" and must never be rendered that way. */
  approvedByUserId: string | null
  /** Tenant-anchored name for approvedByUserId; null when it does not resolve here. */
  approverName: string | null
  approvedAt: string | null
  /** ai_isa_call_batches.call_results, normalized server-side. Null when the
   *  column is empty or unreadable — "outcomes not recorded", never "0 calls". */
  callResults: {
    attempted: number | null
    placed: number | null
    droppedForConsent: number | null
    outcomes: CallOutcome[]
  } | null
}

const fmt = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : null
}

/**
 * THE APPROVAL RECORD, rendered as the data says and no further. This page
 * advertises consent gating at its header; the human who cleared the batch is
 * the other half of that claim. An absent approver is "not recorded" — it is
 * never inferred to be the system, the proposer, or the viewer.
 */
function ApprovalLine({ b }: { b: Batch }) {
  const terminal = b.status === "completed" || b.status === "rejected"
  if (!terminal && !b.approvedByUserId) {
    return <p className="text-xs text-muted-foreground">Awaiting a human decision — nothing has been dialed.</p>
  }
  const verb = b.status === "rejected" ? "Rejected" : "Approved"
  const who = b.approverName
    ? b.approverName
    : b.approvedByUserId
    ? "an account outside this brokerage"
    : null
  const when = fmt(b.approvedAt)
  return (
    <p className="text-xs text-muted-foreground">
      {who
        ? <>{verb} by <span className="font-medium text-foreground">{who}</span>{when ? ` on ${when}` : " (time not recorded)"}.</>
        : <>{verb} — <span className="font-medium text-amber-700">approver not recorded</span>{when ? ` (${when})` : ""}.</>}
    </p>
  )
}

function statusBadge(s: string) {
  const tone: Record<string, string> = {
    proposed: "bg-blue-100 text-blue-800", completed: "bg-green-100 text-green-800",
    rejected: "bg-slate-100 text-slate-600", cancelled: "bg-slate-100 text-slate-600",
  }
  return <Badge className={`text-xs ${tone[s] ?? "bg-slate-100 text-slate-600"}`}>{s}</Badge>
}

export function DialBatchClient({ initialBatches }: { initialBatches: Batch[] }) {
  const [batches, setBatches] = useState<Batch[]>(initialBatches)
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  const [openResults, setOpenResults] = useState<string | null>(null)
  // Batches actioned in THIS session. The optimistic update below flips status but
  // cannot know the stored approval record, so those rows say so plainly instead
  // of rendering "approver not recorded" about a decision just made.
  const [actionedHere, setActionedHere] = useState<Set<string>>(new Set())

  function propose() {
    setMsg(null)
    startTransition(async () => {
      const r = await proposeDialBatchAction()
      if (r.ok) setMsg(`Proposed a batch of ${r.eligibleCount} consented contacts — reload to review.`)
      else setMsg(r.error ?? "Could not propose a batch.")
    })
  }
  function act(id: string, kind: "approve" | "reject") {
    setMsg(null)
    startTransition(async () => {
      if (kind === "approve") {
        const r = await approveDialBatchAction(id)
        if (r.ok) {
          setMsg(`Approved — ${r.dialedCount} will dial${(r.droppedForConsent ?? 0) > 0 ? `, ${r.droppedForConsent} dropped (consent changed)` : ""}.`)
          setBatches((p) => p.map((b) => b.id === id ? { ...b, status: "completed", dialedCount: r.dialedCount ?? 0 } : b))
          setActionedHere((s) => new Set(s).add(id))
        }
        else setMsg(r.error ?? "Approve failed.")
      } else {
        const r = await rejectDialBatchAction(id)
        if (r.ok) { setBatches((p) => p.map((b) => b.id === id ? { ...b, status: "rejected" } : b)); setActionedHere((s) => new Set(s).add(id)) }
        else setMsg(r.error ?? "Reject failed.")
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Button onClick={propose} disabled={pending} className="bg-indigo-600 hover:bg-indigo-700">
          <Phone className="h-4 w-4 mr-1" /> Propose new batch
        </Button>
        {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
      </div>

      {batches.length === 0 ? (
        <Card className="p-6 text-center text-sm text-muted-foreground">No dial batches yet — propose one from your consented hot-list.</Card>
      ) : batches.map((b) => (
        <Card key={b.id} className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {statusBadge(b.status)}
              <span className="text-sm font-medium">{b.proposedCount} consented contact{b.proposedCount === 1 ? "" : "s"}</span>
              {b.dialedCount != null && <span className="text-xs text-muted-foreground">· {b.dialedCount} dialed</span>}
            </div>
            {b.status === "proposed" && (
              <div className="flex gap-2">
                <Button size="sm" className="bg-green-600 hover:bg-green-700" disabled={pending} onClick={() => act(b.id, "approve")}>
                  <Check className="h-4 w-4 mr-1" /> Approve &amp; dial
                </Button>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act(b.id, "reject")}>
                  <X className="h-4 w-4 mr-1" /> Reject
                </Button>
              </div>
            )}
          </div>
          {b.script && <p className="text-xs text-muted-foreground">{b.script}</p>}

          {/* WHO CLEARED IT — the other half of the consent claim in the page header. */}
          {actionedHere.has(b.id)
            ? <p className="text-xs text-muted-foreground">Your decision was recorded — reload to see the stored approval record.</p>
            : <ApprovalLine b={b} />}

          {/* PER-CONTACT OUTCOMES, behind dialed_count. `call_results` recorded
              every attempt and was read by nothing, so "12 dialed" was the entire
              account of what an outbound campaign did. */}
          {b.dialedCount != null && (
            b.callResults ? (
              <div className="space-y-1">
                <button
                  type="button"
                  className="text-xs text-indigo-700 hover:underline"
                  onClick={() => setOpenResults((cur) => (cur === b.id ? null : b.id))}
                >
                  {openResults === b.id ? "Hide" : "Show"} call outcomes
                  {b.callResults.attempted != null ? ` (${b.callResults.attempted} attempted` : " ("}
                  {b.callResults.placed != null ? `, ${b.callResults.placed} placed` : ""}
                  {b.callResults.droppedForConsent != null ? `, ${b.callResults.droppedForConsent} dropped for consent` : ""}
                  )
                </button>
                {openResults === b.id && (
                  b.callResults.outcomes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Counts were recorded but no per-contact outcome rows were.</p>
                  ) : (
                    <ul className="text-xs space-y-0.5 border rounded p-2 bg-slate-50">
                      {b.callResults.outcomes.map((o, i) => (
                        <li key={i} className="flex items-start gap-2">
                          <span className={o.placed ? "text-green-700" : "text-slate-500"}>{o.placed ? "placed" : "not placed"}</span>
                          <span className="font-medium">
                            {o.name ?? (o.contactId ? `contact ${o.contactId.slice(0, 8)}` : "contact not recorded")}
                          </span>
                          {o.error && <span className="text-amber-700">— {o.error}</span>}
                          {!o.placed && !o.error && <span className="text-muted-foreground">— no reason recorded</span>}
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Per-contact outcomes were not recorded for this batch.</p>
            )
          )}

          <div className="flex flex-wrap gap-1.5">
            {b.targets.slice(0, 12).map((t, i) => (
              <Badge key={i} className="bg-slate-100 text-slate-700 text-[11px]">{t.name} · {t.propensity_score}</Badge>
            ))}
            {b.targets.length > 12 && <span className="text-[11px] text-muted-foreground">+{b.targets.length - 12} more</span>}
          </div>
        </Card>
      ))}
    </div>
  )
}
