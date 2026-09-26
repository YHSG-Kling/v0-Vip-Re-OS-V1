"use client"

/**
 * SUBSCRIBERS — the list the newsletter screen counted and could not change.
 *
 * `app/actions/ai-newsletter.ts` has two subscriber-management exports and
 * neither had a caller anywhere:
 *
 *   · manageSubscribers      — one email: add, unsubscribe, remove.
 *   · manageSubscriberBatch  — a set of CONTACTS onto the list in one pass.
 *
 * Meanwhile this screen already renders "Active Subscribers: N" from a live
 * count of newsletter_subscribers, and the only thing that could actually PUT a
 * row in that table was the automatic lifecycle enrolment
 * (lib/content/newsletter-enrollment.ts, fired on lead capture and on
 * conversion). So an agent could see the number, write a newsletter, send it —
 * and had no way to add the person who handed them a business card at an open
 * house, or to honour someone who asked in person to be taken off.
 *
 * WHAT THIS PANEL WILL NOT DO, and why:
 *   · It will not re-subscribe an address that previously unsubscribed. That is
 *     enforced in the action, not here, and the reason is reported back per
 *     contact rather than silently skipped.
 *   · It does not offer "remove" as a delete. Both actions set status to
 *     'unsubscribed'; a deleted row would let the same address be re-added later
 *     as if it had never opted out.
 *   · Batch adds report what was SKIPPED as loudly as what was added, because
 *     the batch action used to report every contact as added while the database
 *     rejected all of them (newsletter_subscribers.email is NOT NULL and no
 *     email was being written).
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Users, Loader2, UserPlus, UserMinus } from "lucide-react"
import { toast } from "sonner"
import { manageSubscribers, manageSubscriberBatch } from "@/app/actions/ai-newsletter"

/** newsletter_subscribers_source_check, verified live. The auto_* values are
 *  written by the lifecycle enrolment lane and are not an agent's to choose. */
const MANUAL_SOURCES = [
  { value: "manual", label: "Added by hand" },
  { value: "form", label: "Signup form" },
  { value: "open_house", label: "Open house" },
  { value: "qr_scan", label: "QR scan" },
  { value: "import", label: "Import" },
  { value: "portal", label: "Client portal" },
]

export interface SubscribableContact {
  id: string
  name: string
  email: string | null
  optedOut: boolean
}

export function SubscribersPanel({
  totalSubscribers,
  contacts,
}: {
  totalSubscribers: number
  contacts: SubscribableContact[]
}) {
  const [email, setEmail] = useState("")
  const [source, setSource] = useState("manual")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchResult, setBatchResult] = useState<{
    affected: number
    skipped: Array<{ contactId: string; reason: string }>
  } | null>(null)
  const [isPending, startTransition] = useTransition()

  const nameOf = (id: string) => contacts.find((c) => c.id === id)?.name ?? "A contact"

  const single = (action: "add" | "unsubscribe") => {
    startTransition(async () => {
      const result = await manageSubscribers({ action, email, source })
      if (!result.success) {
        toast.error((result as { error?: string }).error ?? "That did not work")
        return
      }
      toast.success(action === "add" ? "Added to the list" : "Marked unsubscribed")
      setEmail("")
    })
  }

  const batch = (action: "add" | "remove") => {
    setBatchResult(null)
    startTransition(async () => {
      const result = await manageSubscriberBatch({ action, contactIds: [...selected] })
      if (!result.success) {
        toast.error((result as { error?: string }).error ?? "That did not work")
        return
      }
      setBatchResult({
        affected: (result as any).affected ?? 0,
        skipped: ((result as any).skipped ?? []) as Array<{ contactId: string; reason: string }>,
      })
      setSelected(new Set())
    })
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="h-4 w-4" />
          Subscribers
          <Badge variant="secondary" className="ml-1 text-[10px]">
            {totalSubscribers.toLocaleString()} active
          </Badge>
        </CardTitle>
        <CardDescription>
          People are enrolled automatically when they are captured or convert. This is the manual lane.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ── One address ──────────────────────────────────────────────────── */}
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">One address</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-[2fr_1fr]">
            <div>
              <Label className="text-[11px]">Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className="mt-1 h-8 text-xs"
              />
            </div>
            <div>
              <Label className="text-[11px]">How you got it</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="mt-1 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => single("add")} disabled={isPending || !email.trim()}>
              {isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <UserPlus className="mr-1.5 h-3.5 w-3.5" />}
              Add
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => single("unsubscribe")}
              disabled={isPending || !email.trim()}
            >
              <UserMinus className="mr-1.5 h-3.5 w-3.5" />
              Unsubscribe
            </Button>
          </div>
        </div>

        {/* ── From contacts ────────────────────────────────────────────────── */}
        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">From your contacts</p>
          {contacts.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              No contacts with an email address are available to add.
            </p>
          ) : (
            <>
              <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {contacts.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 rounded border px-2 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggle(c.id)}
                      disabled={c.optedOut}
                    />
                    <span className="font-medium">{c.name}</span>
                    <span className="truncate text-muted-foreground">{c.email}</span>
                    {c.optedOut && (
                      <Badge variant="outline" className="ml-auto text-[10px]">Opted out</Badge>
                    )}
                  </label>
                ))}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => batch("add")} disabled={isPending || selected.size === 0}>
                  {isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Subscribe {selected.size > 0 ? selected.size : ""}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => batch("remove")}
                  disabled={isPending || selected.size === 0}
                >
                  Unsubscribe {selected.size > 0 ? selected.size : ""}
                </Button>
              </div>
            </>
          )}

          {batchResult && (
            <div className="mt-2 text-xs">
              <p className="font-medium">{batchResult.affected} updated</p>
              {batchResult.skipped.length > 0 && (
                <>
                  <p className="mt-1 text-muted-foreground">
                    {batchResult.skipped.length} not changed:
                  </p>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {batchResult.skipped.map((s, i) => (
                      <li key={i}>
                        {nameOf(s.contactId)} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
