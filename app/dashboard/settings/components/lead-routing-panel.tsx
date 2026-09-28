"use client"

/**
 * app/dashboard/settings/components/lead-routing-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW A NEW CONTACT GETS AN AGENT — the admin's decision, in Settings.
 *
 * assignment_rules already let an admin choose a method per rule. But a rule
 * only fires when its conditions match, and the ordinary case is a new contact
 * or a newly CONVERTED lead that no rule covers. For that lead both routers did
 * the same hardcoded thing — capacity-based load balancing — so the method that
 * decides MOST assignments was the only one nobody could set.
 *
 * This panel sets brokerages.default_assignment_method (m305). It reads its
 * options and its help text from lib/lead-assignment/rule-matcher, the same
 * source the per-rule picker and both engines use, so the words here cannot
 * promise something the router does not do — which is precisely what
 * "Load Balance" and "Specialization" did before they were made real.
 *
 * MAILBOX-OWNER RULE (wave 86 lane 86A2 built it as a switch; wave 87 lane 87A made it the rule —
 * owner: "since the email was from the agents' mailbox, it should lead back to the agent."): a lead
 * that landed from an agent's or team lead's own mailbox goes back to that owner when it is qualified
 * and assigned (it is the brokerage's lead until then; the agent only ever receives the contact).
 * TOMBSTONE: the "Prefer the mailbox owner" SWITCH and its get/setMailboxOwnerPreference doors are
 * removed — there is no per-brokerage option to set. Survivor: the always-on rung
 * lib/lead-assignment/mailbox-owner-preference.ts. The panel now STATES the rule instead.
 */

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select"
import { Route, AlertTriangle, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"
import {
  RULE_TYPES,
  RULE_TYPE_LABELS,
  RULE_TYPE_HELP,
  type RuleType,
} from "@/lib/lead-assignment/rule-matcher"
import {
  getDefaultAssignmentMethod,
  setDefaultAssignmentMethod,
} from "@/app/actions/admin/lead-routing-settings"

export function LeadRoutingPanel() {
  const [method, setMethod] = useState<RuleType>("load_balance")
  const [saved, setSaved] = useState<RuleType>("load_balance")
  const [loading, setLoading] = useState(true)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    getDefaultAssignmentMethod().then((r) => {
      if (cancelled) return
      if (r.error) toast.error(r.error)
      setMethod(r.method)
      setSaved(r.method)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const dirty = method !== saved

  function save() {
    startTransition(async () => {
      const res = await setDefaultAssignmentMethod(method)
      if (!res.success) {
        toast.error(res.error ?? "Could not save the assignment method.")
        return
      }
      setSaved(method)
      toast.success(`New contacts will be assigned by ${RULE_TYPE_LABELS[method]}.`)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Route className="h-4 w-4" />
          Lead Routing
        </CardTitle>
        <CardDescription>
          How a new contact — including a newly converted lead — gets an agent
          when no assignment rule matches it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="default-assignment-method">Default assignment method</Label>
          <Select
            value={method}
            onValueChange={(v) => setMethod(v as RuleType)}
            disabled={loading || isPending}
          >
            <SelectTrigger id="default-assignment-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{RULE_TYPE_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{RULE_TYPE_HELP[method]}</p>
        </div>

        {/* Manual breaks the "no contact is ever left unrouted" invariant. That is
            a legitimate choice for a brokerage whose owner places every lead —
            but it must be stated plainly, not discovered later. */}
        {method === "manual" && (
          <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              With Manual selected, a contact that matches no rule is left
              <strong> unassigned</strong> until someone routes it by hand. Each hold
              is recorded on the lead's timeline so nothing disappears quietly.
            </span>
          </div>
        )}

        <div className="space-y-0.5 rounded-md border px-3 py-2" data-rule="mailbox-owner">
          <p className="text-sm font-medium">Emails to an agent&apos;s own mailbox go back to that agent</p>
          <p className="text-xs text-muted-foreground">
            When someone new emails an agent&apos;s or team lead&apos;s own mailbox, the lead is still the
            brokerage&apos;s — but once it is qualified, the contact goes to the agent they wrote to. If that
            agent&apos;s book is on an open transfer, it goes to the covering agent. Only when the agent is
            inactive, no longer with the brokerage or off the team&apos;s board do the normal rules decide.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <Link
            href="/dashboard/admin/assignment-rules"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            Per-rule routing (ZIP farms, teams, priorities)
            <ExternalLink className="h-3 w-3" />
          </Link>
          <Button size="sm" onClick={save} disabled={!dirty || loading || isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
