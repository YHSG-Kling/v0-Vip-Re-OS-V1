"use client"

// app/dashboard/vendors/vendor-access-panel.tsx
// ─────────────────────────────────────────────────────────────────────────────
// CLIENT ACCESS GRANTS — the write half of the vendor/lender access model.
//
// The READ half was already live: lib/vendor/assignment-access.ts
// (assertVendorAssignedToContact) gates every vendor-side surface on an ACTIVE
// row in vendor_contact_assignments, and the scoped vendor portal lists contacts
// from the same table. But the only writer for that table was a server action
// nothing called — so no grant could ever exist, and the gate's honest answer to
// every vendor was permanently "You are not assigned to this contact."
// A table with no reachable writer returns a permanent zero that reads like
// policy. This panel is the writer.
//
// WHO CAN DO WHAT (enforced server-side, mirrored here):
//   grant  — broker / broker_admin / admin / superadmin / team_lead / agent / tc
//   revoke — broker / broker_admin / admin / superadmin / team_lead
//   both are scoped to the caller's own brokerage, and the server re-verifies
//   that the vendor AND the contact belong to it before writing.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { ShieldCheck, ShieldOff, Loader2, KeyRound } from "lucide-react"
import {
  assignVendorToContactAction,
  revokeVendorContactAccessAction,
  setVendorAccessLevelAction,
} from "@/app/actions/vendor-contact-access"
import { GATED_VENDOR_ACCESS_LEVELS, PAID_CONTACT_ACCESS_LEVEL } from "@/lib/vendor/assignment-access"

/** DOOR 2 in words — the two levels a gate reads (lib/vendor/assignment-access.ts
 *  GATED_VENDOR_ACCESS_LEVELS). team_full_access is in the CHECK but opens
 *  nothing, so the writer refuses it and this control never offers it. */
const ACCESS_LEVEL_COPY: Record<string, { label: string; hint: string }> = {
  transaction_only: {
    label: "Assigned clients only",
    hint: "The default. The vendor sees a client only through a grant above.",
  },
  [PAID_CONTACT_ACCESS_LEVEL]: {
    label: "Every client in this brokerage",
    hint: "Bench-wide contact access (name, email, phone on every client record). Documents and financials still need a per-client grant.",
  },
}

/** Mirrors the vendor_contact_assignments.scope CHECK constraint. */
const SCOPES = [
  { value: "pii_basic",        label: "Basic contact info",  hint: "Name, email, phone." },
  { value: "pii_full",         label: "Full client profile", hint: "Everything on the contact record." },
  { value: "transaction_docs", label: "Transaction documents", hint: "Documents on the linked deal." },
  { value: "financial",        label: "Financial",           hint: "Required for lender financial confirmations." },
] as const

export interface VendorAccessAssignmentRow {
  id:             string
  vendor_id:      string
  vendor_name:    string
  contact_id:     string
  contact_name:   string
  transaction_id: string | null
  scope:          string
  status:         string
  granted_at:     string
  revoked_at:     string | null
  /** The stated purpose of the grant (vendor_contact_assignments.notes). */
  notes:            string | null
  /** Who opened the door / who shut it, and why. All four were written on every
   *  grant and revoke and read by nothing — an access record with no actor and
   *  no reason cannot answer the only question it exists to answer. */
  assigned_by_name: string | null
  revoked_by_name:  string | null
  revoke_reason:    string | null
}

export interface VendorAccessPanelProps {
  assignments: VendorAccessAssignmentRow[]
  /** accessLevel = vendors.access_level (DOOR 2); null when never set. */
  vendors:  Array<{ id: string; name: string; accessLevel: string | null }>
  contacts: Array<{ id: string; name: string }>
  /** Server-rendered load error, surfaced instead of an empty list that would
   *  read as "no grants exist". */
  loadError?: string | null
  canRevoke: boolean
}

export function VendorAccessPanel({ assignments, vendors, contacts, loadError, canRevoke }: VendorAccessPanelProps) {
  const router = useRouter()
  const [vendorId, setVendorId] = useState("")
  const [contactId, setContactId] = useState("")
  const [scope, setScope] = useState<string>("pii_basic")
  const [expiresAt, setExpiresAt] = useState("")
  const [granting, setGranting] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [levelBusyId, setLevelBusyId] = useState<string | null>(null)

  async function handleAccessLevel(vendorId: string, accessLevel: string) {
    setLevelBusyId(vendorId)
    try {
      const res = await setVendorAccessLevelAction({ vendorId, accessLevel, reason: "Set from the vendor access panel" })
      // The server COUNTS the update and refuses a level no gate reads, so a
      // green toast means the door genuinely moved — never merely that the call returned.
      if (!res.ok) {
        toast.error(res.error ?? "Could not change the access level")
        return
      }
      toast.success(res.changed
        ? (res.accessLevel === PAID_CONTACT_ACCESS_LEVEL
          ? "Bench-wide access opened — this vendor can now see every client's contact details."
          : "Bench-wide access closed — this vendor sees assigned clients only.")
        : "Already at that level — nothing changed.")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not change the access level")
    } finally {
      setLevelBusyId(null)
    }
  }

  const active  = assignments.filter((a) => a.status === "active")
  const revoked = assignments.filter((a) => a.status !== "active")

  async function handleGrant() {
    if (!vendorId || !contactId) {
      toast.error("Pick both a vendor and a client")
      return
    }
    setGranting(true)
    try {
      const res = await assignVendorToContactAction({
        vendorId,
        contactId,
        scope: scope as "pii_basic" | "pii_full" | "transaction_docs" | "financial",
        // datetime-local has no zone; send an ISO instant the server can parse.
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      })
      if (!res.ok) {
        toast.error(res.error ?? "Could not grant access")
        return
      }
      toast.success("Access granted — the vendor can now see this client.")
      setVendorId(""); setContactId(""); setScope("pii_basic"); setExpiresAt("")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not grant access")
    } finally {
      setGranting(false)
    }
  }

  async function handleRevoke(assignmentId: string) {
    setRevokingId(assignmentId)
    try {
      const res = await revokeVendorContactAccessAction({ assignmentId, reason: "Revoked from the vendor access panel" })
      // The server refuses when no ACTIVE row matched, so a green toast here
      // means the grant is genuinely gone — not merely that the call returned.
      if (!res.ok) {
        toast.error(res.error ?? "Could not revoke access")
        return
      }
      toast.success("Access revoked — the vendor can no longer see this client.")
      router.refresh()
    } catch (e: any) {
      toast.error(e?.message ?? "Could not revoke access")
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Grant a vendor access to a client
          </CardTitle>
          <CardDescription className="text-xs">
            A vendor or lender sees nothing about your clients until you assign them here.
            Grants are scoped, can be time-boxed, and can be revoked at any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Vendor</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger><SelectValue placeholder="Select a vendor…" /></SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Client</Label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger><SelectValue placeholder="Select a client…" /></SelectTrigger>
                <SelectContent>
                  {contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Scope</Label>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {SCOPES.find((s) => s.value === scope)?.hint}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Expires (optional)</Label>
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              <p className="text-[11px] text-muted-foreground">Leave blank for access that lasts until you revoke it.</p>
            </div>
          </div>
          <Button size="sm" onClick={handleGrant} disabled={granting} className="gap-1.5">
            {granting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Grant access
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Active grants ({active.length})</CardTitle>
          <CardDescription className="text-xs">Every outside party who can currently see one of your clients.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loadError ? (
            <p className="px-6 pb-6 text-sm text-red-600">Could not load grants: {loadError}</p>
          ) : active.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              No vendor has access to any client record. That is the correct default — grant access above when a
              lender, title officer, or inspector needs to work a specific file.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10 text-xs text-muted-foreground">
                    <th className="text-left px-4 py-2 font-medium">Vendor</th>
                    <th className="text-left px-4 py-2 font-medium">Client</th>
                    <th className="text-left px-4 py-2 font-medium">Scope</th>
                    <th className="text-right px-4 py-2 font-medium">Granted</th>
                    <th className="text-right px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((a) => (
                    <tr key={a.id} className="border-b last:border-0">
                      <td className="px-4 py-2.5 font-medium">
                        {a.vendor_name}
                        {/* WHO GRANTED IT, and the reason they typed. */}
                        <span className="block text-[11px] font-normal text-muted-foreground">
                          {a.assigned_by_name ? `granted by ${a.assigned_by_name}` : "granter not on file"}
                          {a.notes ? ` · ${a.notes}` : ""}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{a.contact_name}</td>
                      <td className="px-4 py-2.5">
                        <Badge variant="outline" className="text-[11px]">{a.scope.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {new Date(a.granted_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canRevoke ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-xs text-red-600"
                            onClick={() => handleRevoke(a.id)}
                            disabled={revokingId === a.id}
                          >
                            {revokingId === a.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <ShieldOff className="h-3.5 w-3.5" />}
                            Revoke
                          </Button>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Broker/admin revokes</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DOOR 2 — the bench-wide level (vendors.access_level). Readers existed
          for years (the access verdict, the vendor portal list, RLS); the WRITER
          is setVendorAccessLevelAction (lane 81E). Broker/admin only, like revoke:
          opening every client record to an outside party is wider than any grant. */}
      {canRevoke && vendors.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              Bench-wide access
            </CardTitle>
            <CardDescription className="text-xs">
              Per-vendor: assigned clients only (the default), or contact details on every client in the brokerage.
              Documents and financials never ride this door — they stay per-client grants above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {vendors.map((v) => {
              const current = v.accessLevel && ACCESS_LEVEL_COPY[v.accessLevel] ? v.accessLevel : "transaction_only"
              return (
                <div key={v.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between rounded-md border px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{v.name}</p>
                    <p className="text-[11px] text-muted-foreground">{ACCESS_LEVEL_COPY[current]?.hint}</p>
                  </div>
                  <Select
                    value={current}
                    onValueChange={(next) => { if (next !== current) void handleAccessLevel(v.id, next) }}
                    disabled={levelBusyId === v.id}
                  >
                    <SelectTrigger className="h-8 w-full sm:w-64 text-xs">
                      {levelBusyId === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <SelectValue />}
                    </SelectTrigger>
                    <SelectContent>
                      {GATED_VENDOR_ACCESS_LEVELS.map((lvl) => (
                        <SelectItem key={lvl} value={lvl}>{ACCESS_LEVEL_COPY[lvl]?.label ?? lvl}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {revoked.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Ended grants ({revoked.length})</CardTitle>
            <CardDescription className="text-xs">Kept as the record of who once had access, and when it ended.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {revoked.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="text-[11px]">{a.status}</Badge>
                <span className="font-medium">{a.vendor_name}</span>
                <span className="text-muted-foreground">→ {a.contact_name}</span>
                <span className="ml-auto text-muted-foreground">
                  {a.revoked_at ? `ended ${new Date(a.revoked_at).toLocaleDateString()}` : ""}
                  {/* The revoker and the stated reason. This card calls itself
                      "the record of who once had access" — until now it could
                      not say who ended it or why. */}
                  {a.revoked_by_name ? ` by ${a.revoked_by_name}` : ""}
                  {a.revoke_reason ? ` — ${a.revoke_reason}` : ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
