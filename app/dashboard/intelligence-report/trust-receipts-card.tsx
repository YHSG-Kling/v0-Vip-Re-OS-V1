import { createServiceClient } from "@/lib/supabase/service"
import { loadDealContinuity, type ContinuityReceipt } from "@/lib/kernel/continuity-receipt"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

/**
 * TRUST RECEIPTS — the broker-visible half of the Continuity Engine. The
 * client portal already shows each party "your paperwork, loan milestones,
 * and timeline were verified in sync just now"; until this card, no broker
 * surface showed the same proof. It lives HERE (the Monthly Intelligence
 * Report) because this page is the principal's proof surface — "measured,
 * not claimed", already reading self-heal events — and it is gated by the
 * exact tier-parity principal idiom (isTenancyPrincipal) in page.tsx; this
 * card renders only behind that gate.
 *
 * ONE implementation: every receipt below is loadDealContinuity — the SAME
 * live per-deal contract checks the portal runs (never a parallel compute),
 * so what the broker sees can never disagree with what the client sees.
 * Live at read: "verified just now" is literally true. Read-only.
 */

interface DealReceiptRow {
  id: string
  label: string
  /** parties (buyer/seller/primary contact on the deal) whose portal shows this same receipt */
  partiesInformed: number
  /** the deal's last recorded update */
  updatedAt: string | null
  receipt: ContinuityReceipt
}

/** PURE: the honest rollup line over the shown receipts. */
export function composeTrustRollup(receipts: Array<Pick<ContinuityReceipt, "status" | "repairedLast30d">>): string {
  if (receipts.length === 0) {
    return "No active deals right now — trust receipts appear here the moment a deal is under way."
  }
  const attention = receipts.filter((r) => r.status === "attention").length
  const repaired = receipts.reduce((s, r) => s + r.repairedLast30d, 0)
  if (attention > 0) {
    return `${attention} of ${receipts.length} active deal${receipts.length === 1 ? "" : "s"} ${attention === 1 ? "has" : "have"} an item getting a closer look — the rest verified in sync just now.`
  }
  const base = `Every active deal shown (${receipts.length}) verified in sync just now`
  return repaired > 0
    ? `${base} — ${repaired} sync hiccup${repaired === 1 ? " was" : "s were"} caught and repaired automatically in the last 30 days.`
    : `${base}.`
}

const STATUS_STYLE: Record<ContinuityReceipt["status"], { label: string; className: string }> = {
  verified: { label: "Verified", className: "bg-emerald-100 text-emerald-800" },
  repaired: { label: "Verified · repaired", className: "bg-sky-100 text-sky-800" },
  attention: { label: "Closer look", className: "bg-amber-100 text-amber-800" },
}

const fmtDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"

export async function TrustReceiptsCard({ brokerageId }: { brokerageId: string }) {
  const svc = createServiceClient()

  // Recent active deals — the same active-deal shape the QBR loader counts.
  const { data: deals } = await svc.from("transactions")
    .select("id, deal_name, client_name, property_address, updated_at, contact_id, buyer_contact_id, seller_contact_id")
    .eq("brokerage_id", brokerageId).is("deleted_at", null)
    .not("status", "in", '("closed","cancelled")')
    .order("updated_at", { ascending: false })
    .limit(8)

  const rows: DealReceiptRow[] = await Promise.all(
    ((deals ?? []) as any[]).map(async (d) => ({
      id: d.id as string,
      label: (d.deal_name || d.property_address || d.client_name || `Deal ${String(d.id).slice(0, 8)}`) as string,
      partiesInformed: [d.contact_id, d.buyer_contact_id, d.seller_contact_id].filter(Boolean).length,
      updatedAt: (d.updated_at ?? null) as string | null,
      receipt: await loadDealContinuity(svc, { brokerageId, transactionId: d.id }),
    })),
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Trust receipts — deal continuity</CardTitle>
        <p className="text-sm font-medium leading-snug">{composeTrustRollup(rows.map((r) => r.receipt))}</p>
        <p className="text-xs text-muted-foreground">
          The same live verification each client sees on their portal — paperwork, loan milestones, and
          follow-through checked against the real ledgers at this moment, per deal.
        </p>
      </CardHeader>
      {rows.length > 0 && (
        <CardContent>
          <dl className="divide-y">
            {rows.map((r) => (
              <div key={r.id} className="flex items-baseline justify-between gap-4 py-1.5">
                <dt className="min-w-0 text-sm">
                  <span className="block truncate">{r.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.partiesInformed} {r.partiesInformed === 1 ? "party" : "parties"} informed · last deal update {fmtDay(r.updatedAt)}
                    {r.receipt.repairedLast30d > 0 ? ` · ${r.receipt.repairedLast30d} auto-repair${r.receipt.repairedLast30d === 1 ? "" : "s"} (30d)` : ""}
                  </span>
                </dt>
                <dd className="shrink-0 text-right">
                  <Badge className={`text-[10px] ${STATUS_STYLE[r.receipt.status].className}`}>
                    {STATUS_STYLE[r.receipt.status].label}
                  </Badge>
                  {r.receipt.openItems > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.receipt.openItems} open item{r.receipt.openItems === 1 ? "" : "s"}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      )}
    </Card>
  )
}
