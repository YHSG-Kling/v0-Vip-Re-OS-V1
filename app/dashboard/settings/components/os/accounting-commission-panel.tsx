"use client"

/**
 * app/dashboard/settings/components/os/accounting-commission-panel.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * ACCOUNTING & COMMISSION — and, from m461, WHERE A BROKERAGE SETS ITS CAP.
 *
 * ── WHAT FED `capAmount` BEFORE, AND WHY THE TILE NEVER APPEARED ────────────
 *
 * This panel has declared `capAmount?: number | null` and rendered a "Cap Amount"
 * tile behind `{commission.capAmount && …}` since it was written. Its only
 * caller, `app/dashboard/settings/page.tsx`, passed a HARDCODED `null`:
 *
 *     capAmount: null, // Would come from agent_cap_tracking or commission_structures
 *
 * So the tile was unreachable by construction. A prop, a conditional and a
 * formatted currency string, all in service of a constant — the shape of a
 * control that looks configurable and is decoration. The comment named two
 * candidate sources and neither could have worked: `agent_cap_tracking` is
 * per-agent-per-anniversary-window and has no single brokerage number, and
 * `commission_structures` has no cap column at all.
 *
 * m461 gave it a real source — `brokerages.default_cap_amount` — and this panel
 * now both SHOWS and SETS it, because a brokerage-level surface is exactly where
 * a brokerage-level default belongs (the owner's ruling that put the brokerage
 * licence number beside the brokerage name).
 *
 * ── WHAT A CAP IS, SAID ON THE SCREEN ───────────────────────────────────────
 *
 * A cap is a ceiling on what the BROKERAGE COLLECTS from an agent per
 * anniversary year — not on what the agent earns. `07-apply-cap.ts` says so in
 * its own header, and once the brokerage has taken this much its share drops to
 * $0 and the agent keeps the rest. Broker-facing copy that got this backwards
 * would have brokers setting the opposite of what they mean, so the panel states
 * the direction of the money.
 *
 * ── SETTING IT HERE DOES NOT CAP ANYBODY BY ITSELF ──────────────────────────
 *
 * The commission engine reads exactly ONE table, `agent_cap_tracking`. This
 * default is what `lib/commission/cap-resolver.ts:ensureAgentCapWindow`
 * materialises into that ledger, per agent, for the window containing today —
 * and that seeder is what makes this setting real. Before it existed, four
 * agents on the live database carried a cap and three had no ledger row at all,
 * so the engine had never once enforced them. The panel says which agents are
 * covered rather than implying the number alone does something.
 *
 * The write goes through `updateBrokerageIdentity` — the ONE allow-listed writer
 * for the `brokerages` row — never a second action against the same table.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DollarSign,
  FileText,
  Link2,
  ExternalLink,
  AlertTriangle,
  Info,
} from "lucide-react"
import { toast } from "sonner"
import { updateBrokerageIdentity } from "@/app/actions/settings/brokerage-identity"
import {
  CAP_ANNIVERSARY_BASES,
  CAP_ANNIVERSARY_BASIS_LABEL,
  type CapAnniversaryBasis,
} from "@/lib/commission/cap-resolver"

interface AccountingStatus {
  quickbooksConnected: boolean
  xeroConnected: boolean
  lastSyncAt?: string | null
  syncErrors: number
}

interface CommissionSettings {
  defaultSplitPct: number
  /** `brokerages.default_cap_amount` in dollars. NULL means UNCAPPED — which is
   *  a different fact from 0, "the brokerage collects nothing". */
  capAmount?: number | null
  capAnniversaryBasis: CapAnniversaryBasis
  hasStructures: boolean
  structureCount: number
}

interface AccountingCommissionPanelProps {
  accounting: AccountingStatus
  commission: CommissionSettings
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })

export function AccountingCommissionPanel({
  accounting,
  commission,
}: AccountingCommissionPanelProps) {
  const hasAccountingProvider = accounting.quickbooksConnected || accounting.xeroConnected
  const providerName = accounting.quickbooksConnected ? "QuickBooks" : accounting.xeroConnected ? "Xero" : null

  // NULL (uncapped) and 0 (collects nothing) are different answers, so the form
  // seed is explicit: only a genuine null becomes an empty box.
  const [capAmount, setCapAmount] = useState<string>(
    commission.capAmount === null || commission.capAmount === undefined ? "" : String(commission.capAmount),
  )
  const [basis, setBasis] = useState<CapAnniversaryBasis>(commission.capAnniversaryBasis)
  const [savedCap, setSavedCap] = useState<string>(
    commission.capAmount === null || commission.capAmount === undefined ? "" : String(commission.capAmount),
  )
  const [savedBasis, setSavedBasis] = useState<CapAnniversaryBasis>(commission.capAnniversaryBasis)
  const [editing, setEditing] = useState(false)
  const [pending, startSave] = useTransition()

  const dirty = capAmount !== savedCap || basis !== savedBasis

  function saveCap() {
    startSave(async () => {
      // Only the two cap fields are sent. The action's allow-list would drop
      // anything else anyway, but sending only what this control owns means a
      // half-typed address on another card can never be committed from here.
      const res = await updateBrokerageIdentity({
        default_cap_amount: capAmount,
        default_cap_anniversary_basis: basis,
      })
      if (res.error || !res.data) {
        toast.error(res.error ?? "Could not save your brokerage's cap.")
        return
      }
      setSavedCap(capAmount)
      setSavedBasis(basis)
      setEditing(false)
      toast.success(
        capAmount.trim()
          ? "Default cap saved. New agents inherit it; existing agents keep the cap already in their ledger."
          : "Default cap cleared. New agents are uncapped unless they have their own cap.",
      )
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <DollarSign className="h-4 w-4" />
          Accounting & Commission
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Accounting Status */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className={`h-4 w-4 ${hasAccountingProvider ? "text-green-500" : "text-muted-foreground"}`} />
              <span className="text-sm">Accounting Sync</span>
            </div>
            {hasAccountingProvider ? (
              <Badge variant="default" className="text-xs">{providerName}</Badge>
            ) : (
              <Link href="/settings/accounting">
                <Button variant="outline" size="sm" className="h-6 px-2 text-xs">
                  Connect
                </Button>
              </Link>
            )}
          </div>

          {hasAccountingProvider && accounting.syncErrors > 0 && (
            <div className="flex items-center gap-2 text-xs text-amber-600 pl-6">
              <AlertTriangle className="h-3 w-3" />
              {accounting.syncErrors} sync errors need attention
            </div>
          )}

          {hasAccountingProvider && accounting.lastSyncAt && (
            <p className="text-xs text-muted-foreground pl-6">
              Last synced: {new Date(accounting.lastSyncAt).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Commission Settings */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">Commission Structures</span>
            </div>
            <Badge variant="outline" className="text-xs">
              {commission.structureCount} active
            </Badge>
          </div>

          <div className="text-xs pl-6">
            <p className="text-muted-foreground">Default Split</p>
            <p className="font-medium">{commission.defaultSplitPct}%</p>
          </div>
        </div>

        {/* ── THE BROKERAGE'S DEFAULT COMMISSION CAP ───────────────────────────
            OWNER RULING: "brokerage and teams may also have commission caps."
            Set here because settings is where a brokerage configures itself. */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm">Default Commission Cap</p>
              <p className="text-xs text-muted-foreground">
                The most this brokerage <strong>collects from</strong> an agent per year.
              </p>
            </div>
            {!editing && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs shrink-0"
                onClick={() => setEditing(true)}
              >
                {savedCap ? "Change" : "Set"}
              </Button>
            )}
          </div>

          {!editing ? (
            <div className="pl-0 text-xs space-y-1">
              {savedCap ? (
                <>
                  <p className="font-medium text-sm">
                    {USD.format(Number(savedCap))}
                    <span className="text-muted-foreground font-normal"> per agent, per year</span>
                  </p>
                  <p className="text-muted-foreground">
                    Resets: {CAP_ANNIVERSARY_BASIS_LABEL[savedBasis]}
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">
                  No cap set — the brokerage keeps taking its share of every deal, all year, unless an
                  individual agent has their own cap.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="brokerage-cap-amount" className="text-xs">
                  Cap amount
                </Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    id="brokerage-cap-amount"
                    inputMode="decimal"
                    placeholder="Leave blank for no cap"
                    value={capAmount}
                    onChange={(e) => setCapAmount(e.target.value)}
                    disabled={pending}
                    className="h-8 text-sm"
                  />
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Once the brokerage has collected this much from an agent in their year, its share
                  drops to $0 and the agent keeps the whole commission. Blank means no cap. At most
                  two decimal places — a longer number is refused, not rounded.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="brokerage-cap-basis" className="text-xs">
                  When the cap resets
                </Label>
                <Select
                  value={basis}
                  onValueChange={(v) => setBasis(v as CapAnniversaryBasis)}
                  disabled={pending}
                >
                  <SelectTrigger id="brokerage-cap-basis" className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAP_ANNIVERSARY_BASES.map((b) => (
                      <SelectItem key={b} value={b} className="text-xs">
                        {CAP_ANNIVERSARY_BASIS_LABEL[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-md border bg-muted/40 p-2.5">
                <p className="text-[11px] font-medium flex items-center gap-1.5">
                  <Info className="h-3 w-3" />
                  This is the default, not a retroactive change
                </p>
                <p className="text-[11px] leading-snug text-muted-foreground mt-1">
                  It applies to agents who have no cap of their own, and it is written into an
                  agent&apos;s cap ledger when their record is created. An agent already part-way
                  through a capped year keeps the cap in their ledger — changing this number does not
                  move a ceiling somebody is already counting against.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <Button size="sm" className="h-7 text-xs" onClick={saveCap} disabled={!dirty || pending}>
                  {pending ? "Saving…" : "Save cap"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={pending}
                  onClick={() => {
                    setCapAmount(savedCap)
                    setBasis(savedBasis)
                    setEditing(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Quick Links */}
        <div className="flex gap-2 pt-2 border-t">
          <Link href="/settings/accounting" className="flex-1">
            <Button variant="outline" size="sm" className="w-full text-xs">
              Accounting <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
          <Link href="/settings/commission" className="flex-1">
            <Button variant="outline" size="sm" className="w-full text-xs">
              Commission <ExternalLink className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
