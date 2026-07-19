"use client"

// app/dashboard/superadmin/message-admin-composer.tsx
// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE A TENANT ADMIN — the ONE compose modal, mounted in two homes:
//   · the brokerage detail actions card (brokerages/[id]/brokerage-actions.tsx)
//   · the support-console ticket thread header (support/[id]/page.tsx)
// Recipient picker (the tenant's broker/admin bench), subject, body, an
// optional "Draft with AI" assist (platform voice, grounded in real tenant
// facts, deterministic fallback — staff edit before send, never auto-sent),
// and an HONEST outcome line: suppressed / no email / provider refusal each
// surface distinctly, and success says whether the in-app mirror landed.

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Loader2, Mail, Sparkles } from "lucide-react"
import {
  listMessageableAdminsAction,
  draftTenantAdminMessageAction,
  sendTenantAdminMessageAction,
  type MessageableAdmin,
} from "@/app/actions/superadmin/tenant-message"

export function MessageAdminComposer({
  brokerageId,
  brokerageName,
  triggerLabel = "Message admin",
}: {
  brokerageId: string
  brokerageName?: string | null
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [admins, setAdmins] = useState<MessageableAdmin[] | null>(null)
  const [recipientId, setRecipientId] = useState("")
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [purpose, setPurpose] = useState("")
  const [draftNote, setDraftNote] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ kind: "error" | "success"; message: string } | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next && admins === null) {
      startTransition(async () => {
        const r = await listMessageableAdminsAction(brokerageId)
        if (!r.ok) { setOutcome({ kind: "error", message: r.error }); setAdmins([]); return }
        setAdmins(r.admins)
        const first = r.admins.find((a) => !!a.email) ?? r.admins[0]
        if (first) setRecipientId(first.id)
      })
    }
    if (!next) setOutcome(null)
  }

  function draftWithAI() {
    if (!recipientId) { setOutcome({ kind: "error", message: "Pick a recipient first — the draft is grounded in who it's for" }); return }
    setOutcome(null); setDraftNote(null)
    startTransition(async () => {
      const r = await draftTenantAdminMessageAction({ brokerageId, targetUserId: recipientId, purpose })
      if (!r.ok) { setOutcome({ kind: "error", message: r.error }); return }
      setSubject(r.draft.subject)
      setBody(r.draft.body)
      setDraftNote(
        r.draft.source === "ai"
          ? `AI draft grounded in: ${r.draft.facts.slice(0, 3).join(" · ")}${r.draft.facts.length > 3 ? " · …" : ""}. Edit before sending.`
          : "AI rail unavailable — standard template inserted. Edit before sending.",
      )
    })
  }

  function send() {
    setOutcome(null)
    startTransition(async () => {
      const r = await sendTenantAdminMessageAction({ brokerageId, targetUserId: recipientId, subject, body })
      if (!r.ok) { setOutcome({ kind: "error", message: r.error ?? "Send failed" }); return }
      setOutcome({ kind: "success", message: r.note ?? "Sent." })
      setBody(""); setSubject(""); setPurpose(""); setDraftNote(null)
    })
  }

  const selected = admins?.find((a) => a.id === recipientId) ?? null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Mail className="h-3.5 w-3.5 mr-1" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Message a tenant admin{brokerageName ? ` — ${brokerageName}` : ""}</DialogTitle>
          <DialogDescription>
            Direct platform→customer email to this tenant&apos;s broker/admin bench. Suppression-checked, audited, and mirrored to their in-app notifications.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Recipient */}
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="tenant-msg-recipient">Recipient</label>
            {admins === null ? (
              <p className="text-sm text-muted-foreground mt-1">Loading admins…</p>
            ) : admins.length === 0 ? (
              <p className="text-sm text-amber-700 mt-1">No broker/admin users found for this tenant — there is nobody to message.</p>
            ) : (
              <select
                id="tenant-msg-recipient"
                value={recipientId}
                onChange={(e) => setRecipientId(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border px-2 text-sm bg-transparent"
              >
                {admins.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.userType}){a.email ? ` — ${a.email}` : " — no email on file"}
                  </option>
                ))}
              </select>
            )}
            {selected && !selected.email && (
              <p className="text-xs text-amber-700 mt-1">This admin has no email on file — the send will be refused.</p>
            )}
          </div>

          {/* AI assist */}
          <div className="rounded-md border p-2 space-y-2">
            <label className="text-xs text-muted-foreground" htmlFor="tenant-msg-purpose">Draft with AI — state the purpose (optional)</label>
            <div className="flex gap-2">
              <input
                id="tenant-msg-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. their data import finished; heads-up before tomorrow's call"
                className="h-8 flex-1 rounded-md border px-2 text-sm"
              />
              <Button size="sm" variant="outline" onClick={draftWithAI} disabled={isPending || purpose.trim().length < 8}>
                <Sparkles className="h-3.5 w-3.5 mr-1" />
                Draft
              </Button>
            </div>
            {draftNote && <p className="text-xs text-muted-foreground">{draftNote}</p>}
          </div>

          {/* Subject + body */}
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="tenant-msg-subject">Subject</label>
            <input
              id="tenant-msg-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              className="mt-1 w-full h-9 rounded-md border px-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="tenant-msg-body">Message</label>
            <textarea
              id="tenant-msg-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={7}
              maxLength={5000}
              className="mt-1 w-full rounded-md border p-2 text-sm"
            />
          </div>

          {outcome && (
            <div className={`rounded-md border p-2 text-sm ${outcome.kind === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>
              {outcome.message}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            <Button size="sm" onClick={send} disabled={isPending || !recipientId || subject.trim().length < 3 || body.trim().length < 10}>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Mail className="h-3.5 w-3.5 mr-1" />}
              Send email
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
