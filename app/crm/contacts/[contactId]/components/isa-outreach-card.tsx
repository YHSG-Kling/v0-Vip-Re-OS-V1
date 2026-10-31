"use client"

/**
 * app/crm/contacts/[contactId]/components/isa-outreach-card.tsx
 *
 * The door for POST /api/contacts/send-isa-email.
 *
 * THE ROUTE NAMED ITS OWN HOME. Its direct-mail branch writes the activity
 * description "Operator triggered direct mail from CRM contact record"
 * (app/api/contacts/send-isa-email/route.ts:126) — a sentence that can only be
 * true once a control on the CRM contact record exists. This is that control.
 *
 * THE ROUTE STAYS THE IMPLEMENTATION. Nothing here re-derives a lead link, a
 * sender, an email body or a queue row: the two branches (linked lead →
 * initiateAIISAEngagement; no lead → assembleEmail + resolveOutboundSender +
 * dispatchEmail, or the direct_mail_queued activity) all live there. This card
 * sends `{ contactId, channel }` and READS what comes back.
 *
 * ── EVERY GATE IS THE ROUTE'S, AND EVERY REFUSAL IS SHOWN ────────────────────
 * This card deliberately does NOT pre-check DNC, opt-out or address-on-file
 * before enabling its button. A second copy of a compliance test is a second
 * vocabulary (§6) and, worse, a client-side one that can disagree with the
 * server's answer while looking authoritative. The button always asks; the
 * server always decides; the answer is printed verbatim beside a plain-language
 * gloss.
 *
 * THE REFUSALS THAT COME BACK, and why each needs to be visible:
 *   · HTTP 403 "Contact is on Do Not Contact list" / "…opted out of email" —
 *     the TCPA/DNC guard. An operator who is not told this will try again.
 *   · HTTP 400 "No mailing address on file" / "No email on contact" — missing
 *     data, fixable on this same record.
 *   · HTTP 404 "Contact not found" — the §4 tenant predicate refusing. The
 *     route resolves the caller's brokerage from the SESSION and pins the
 *     contact read to it; a contact outside it is a 404 and must not read as a
 *     transient failure.
 *   · HTTP 422 with NO_SENDER_ERROR — no verified outbound sender is configured.
 *     Nothing was sent and nothing was charged; the message names the surface an
 *     admin must go and fix.
 *   · HTTP 200 with `success:false` and a `reason` — the lead-linked branch.
 *     initiateAIISAEngagement returns its compliance stops this way
 *     ('stop:dnc', 'stop:representation', 'stop:max_touches', 'no_email',
 *     'paused:under_contract', …) with a 200 status, so reading `res.ok` alone
 *     would report a blocked send as a sent one. `success` is what is read.
 */

import { useState } from "react"
import { Loader2, Mail, Send } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { processOptOut } from "@/app/actions/ai-isa/process-opt-out"

type Channel = "email" | "direct_mail"

const CHANNELS: Array<{ value: Channel; label: string; hint: string }> = [
  { value: "email", label: "Email", hint: "Sends now, from the brokerage's verified sender" },
  { value: "direct_mail", label: "Direct mail", hint: "Queues a piece for fulfillment" },
]

/** Plain-language gloss for the stop codes initiateAIISAEngagement returns on a
 *  200. The raw code is ALWAYS printed too — a gloss this map does not have must
 *  never swallow the reason the server gave. */
const REASON_GLOSS: Record<string, string> = {
  "stop:dnc": "This contact is on the Do Not Contact list.",
  "stop:representation": "This person is already represented — outreach is blocked.",
  "stop:inactive": "The linked lead is inactive.",
  "stop:max_touches": "The outreach cap for this lead has been reached.",
  "stop:reengage_blocked": "Re-engagement is blocked for this lead.",
  "stop:not_personalized": "The draft was not personalized enough to send.",
  "stop:parked_awaiting_distribution": "The lead is parked awaiting distribution.",
  "paused:under_contract": "Paused — this lead is under contract.",
  no_email: "There is no email address on the linked lead.",
  no_phone: "There is no phone number on the linked lead.",
  no_mailing_address: "There is no mailing address on the linked lead.",
  Unauthorized: "Your session is not permitted to send for this brokerage.",
  Forbidden: "This lead is outside your brokerage.",
  "Lead already assigned to agent": "The linked lead is already with an agent — ISA outreach stops there.",
}

export function IsaOutreachCard({ contactId }: { contactId: string }) {
  const [channel, setChannel] = useState<Channel>("email")
  const [sending, setSending] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const [dncSaving, setDncSaving] = useState(false)
  const [dncOutcome, setDncOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  async function recordDoNotContact() {
    if (!window.confirm("Record that this person asked not to be contacted? Email, text, calls and mail all stop.")) return
    setDncSaving(true)
    setDncOutcome(null)
    try {
      const r = await processOptOut({ entityType: "contact", entityId: contactId, channel: "all", source: "agent", rawMessage: "Do Not Contact recorded by staff from the CRM contact record" })
      setDncOutcome(r.success
        ? { ok: true, text: `Recorded — ${r.channelsSuppressed.join(", ") || "every channel"} suppressed${r.globalDNC ? " (Do Not Contact)" : ""}.` }
        : { ok: false, text: `Not recorded — ${r.error ?? "the server refused"}` })
    } catch (err: unknown) {
      setDncOutcome({ ok: false, text: err instanceof Error ? err.message : "Not recorded." })
    } finally {
      setDncSaving(false)
    }
  }

  async function send() {
    setSending(true)
    setOutcome(null)
    try {
      const res = await fetch("/api/contacts/send-isa-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // §4 — the CONTACT is the addressed record; the tenant is never sent.
        // The route resolves the caller's brokerage from the session and pins
        // its contact read to it, which is what makes this contactId safe to
        // pass at all.
        body: JSON.stringify({ contactId, channel }),
      })
      const payload = await res.json().catch(() => null)

      if (!res.ok) {
        setOutcome({
          ok: false,
          text:
            (payload && typeof payload.error === "string" && payload.error) ||
            `Nothing was sent (HTTP ${res.status}).`,
        })
        return
      }

      // A 200 is NOT a send. The lead-linked branch reports its compliance stops
      // with success:false at status 200.
      if (payload?.success === false) {
        const reason = typeof payload.reason === "string" ? payload.reason : null
        const detail = typeof payload.error === "string" ? payload.error : null
        const gloss = reason ? REASON_GLOSS[reason] : null
        setOutcome({
          ok: false,
          text: [gloss, reason ? `(${reason})` : null, detail]
            .filter(Boolean)
            .join(" ") || "Nothing was sent, and the server gave no reason.",
        })
        return
      }

      if (payload?.success !== true) {
        setOutcome({
          ok: false,
          text: "The server did not confirm a send, so this is not a confirmation that one happened.",
        })
        return
      }

      setOutcome({
        ok: true,
        text:
          channel === "email"
            ? "Email sent from the brokerage's verified sender."
            : "Direct mail piece queued for fulfillment — the queue row is the record that it was asked for.",
      })
    } catch (err: unknown) {
      setOutcome({
        ok: false,
        text: err instanceof Error ? err.message : "Nothing was sent.",
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Mail className="h-4 w-4" />
          ISA follow-up
        </CardTitle>
        <CardDescription className="text-xs">
          Send the ISA follow-up to this contact, or queue a mail piece. Every send runs the
          brokerage&apos;s consent and sender gates first — if one refuses, you are told which and
          nothing goes out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[16rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNELS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label} — {c.hint}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={send} disabled={sending}>
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 mr-2" />
            )}
            {channel === "email" ? "Send follow-up" : "Queue mail piece"}
          </Button>
        </div>
        {sending && (
          <p className="text-sm text-muted-foreground">
            Running the consent and sender gates…
          </p>
        )}
        {outcome && (
          <p className={outcome.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
            {outcome.text}
          </p>
        )}
        {/* THE STAFF HALF OF THE OPT-OUT DOOR (wave 146, lane 146Z): a person who asks staff — by phone, in person — to stop
            is recorded through the SESSION door (app/actions/ai-isa/process-opt-out.ts processOptOut, source 'agent'): the
            tenant is the session's, the contact must be in it, and the ONE writer (lib/ai-isa/opt-out-writer.ts) suppresses
            every channel with its audit row. Inbound STOPs keep riding the signature-verified doors. */}
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">They asked not to be contacted? Record it — every channel stops.</p>
          <Button size="sm" variant="outline" onClick={recordDoNotContact} disabled={dncSaving}>
            {dncSaving ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Record Do Not Contact
          </Button>
        </div>
        {dncOutcome && (
          <p className={dncOutcome.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{dncOutcome.text}</p>
        )}
      </CardContent>
    </Card>
  )
}
