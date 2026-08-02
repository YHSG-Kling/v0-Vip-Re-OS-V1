import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"

// CROSS-TENANT VENDOR OVERSIGHT — every vendor across every tenant in one
// table. PLATFORM-GLOBAL READ by design (sentinel-gated — vendor network
// quality/abuse is a sentinel concern; service client). Verified linkage map
// (scripts/schema-snapshot.ts + the real writers):
//   • vendors                — the canonical per-tenant vendor record
//                              (brokerage_id, category, status).
//   • user_role_assignments  — the vendor↔user account linkage: the invite
//                              accept flow (app/actions/vendor-invite.ts)
//                              creates users with user_type='vendor' and links
//                              auth user ↔ vendors.id via
//                              user_role_assignments.vendor_id. vendors has NO
//                              user_id column — the assignment row IS the link.
//   • vendor_invitations     — status 'pending'|'accepted'|'expired'|'revoked'
//                              (writers in vendor-invite.ts).
//   • vendor_directory       — the curated list carrying the premium-placement
//                              flags {preferred, display_priority}. There is NO
//                              FK between vendors and vendor_directory; the only
//                              association is nominal (same brokerage + name),
//                              so the match below is by-name and labeled as such.
//   • vendor_invoices        — the billing ledger. Premium-placement charges
//                              (lib/vendors/premium-placement.ts) store
//                              vendor_id = vendor_directory.id and a
//                              line_items[] entry {type:'premium_placement',
//                              directory_id, placement_until}; ordinary vendor
//                              invoices store vendor_id = vendors.id. Per-vendor
//                              totals therefore aggregate on vendors.id, and
//                              placement terms resolve through directory_id.
// Nothing here is fabricated: every badge is exactly what those tables hold.

function fmtAgo(iso: string | null) {
  if (!iso) return "never"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}

function fmtMoney(n: number) {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// vendor_invoices status CHECK: draft|submitted|viewed|paid|overdue|cancelled|disputed.
// Outstanding = issued and awaiting payment.
const OUTSTANDING_STATUSES = ["submitted", "viewed", "overdue"]

interface PlacementItem {
  type: string
  directory_id?: string
  placement_until?: string
  months?: number
}

function placementItemOf(lineItems: unknown): PlacementItem | null {
  if (!Array.isArray(lineItems)) return null
  const item = lineItems.find(
    (li: any) => li && typeof li === "object" && li.type === "premium_placement" && typeof li.directory_id === "string"
  )
  return (item as PlacementItem) ?? null
}

export default async function SuperadminVendorsPage() {
  const gate = await requirePlatformCapability("sentinel")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: superadmin access only</div>

  const svc = createServiceClient()

  const [brk, vend, dir, invites, links, vendorUsers, invoices] = await Promise.all([
    svc.from("brokerages").select("id, name").is("deleted_at", null),
    svc.from("vendors").select("id, brokerage_id, name, category, status, email, created_at").order("created_at", { ascending: false }).limit(5000),
    svc.from("vendor_directory").select("id, brokerage_id, vendor_id, name, preferred, display_priority"),
    svc.from("vendor_invitations").select("vendor_id, brokerage_id, status, created_at").order("created_at", { ascending: false }).limit(5000),
    svc.from("user_role_assignments").select("user_id, vendor_id, brokerage_id").not("vendor_id", "is", null),
    svc.from("users").select("id, email").eq("user_type", "vendor"),
    svc.from("vendor_invoices").select("id, vendor_id, brokerage_id, status, total_amount, paid_at, line_items").order("created_at", { ascending: false }).limit(5000),
  ])
  const failed = [brk, vend, dir, invites, links, vendorUsers, invoices].find((r) => r.error)
  if (failed?.error) return <div className="p-6 text-red-600">Failed to load vendor board: {failed.error.message}</div>

  const brokerageName = new Map<string, string>()
  for (const b of (brk.data ?? []) as any[]) brokerageName.set(b.id, b.name ?? "(unnamed)")

  // Latest invitation per vendor (rows arrive newest-first — first hit wins).
  const latestInviteByVendor = new Map<string, string>()
  for (const i of (invites.data ?? []) as any[]) {
    if (i.vendor_id && !latestInviteByVendor.has(i.vendor_id)) latestInviteByVendor.set(i.vendor_id, i.status ?? "pending")
  }

  // Portal account linkage: user_role_assignments.vendor_id → users.email.
  const emailByUserId = new Map<string, string>()
  for (const u of (vendorUsers.data ?? []) as any[]) emailByUserId.set(u.id, u.email ?? "")
  const linkedUserByVendor = new Map<string, string>()
  for (const l of (links.data ?? []) as any[]) {
    if (l.vendor_id && !linkedUserByVendor.has(l.vendor_id)) {
      linkedUserByVendor.set(l.vendor_id, emailByUserId.get(l.user_id) ?? "linked account")
    }
  }

  // Directory placement flags, keyed on the REAL foreign key.
  //
  // This used to join on a lowercased `brokerage_id::name` string, under page
  // copy asserting "the two tables share no foreign key". That stopped being
  // true when m303 added vendor_directory.vendor_id REFERENCES vendors(id) —
  // it is in the schema snapshot. Matching on a name means a vendor whose
  // directory row drifts by so much as a trailing "LLC" reports placement:
  // none, forever, on the console a platform admin uses to see who is paying.
  const dirRows = (dir.data ?? []) as any[]
  const dirByVendorId = new Map<string, { id: string; preferred: boolean }>()
  for (const d of dirRows) {
    if (!d.vendor_id) continue
    if (!dirByVendorId.has(d.vendor_id)) dirByVendorId.set(d.vendor_id, { id: d.id, preferred: d.preferred === true })
  }

  // Latest PAID premium-placement term per directory row (line_items.placement_until,
  // written by markPlacementPaid; latest paid_at wins — a renewal supersedes).
  const paidTermByDirectory = new Map<string, { paidAt: string; until: string | null }>()
  let outstandingCount = 0
  let outstandingTotal = 0
  const invoiceAgg = new Map<string, { billed: number; outstanding: number; paid: number }>()
  for (const inv of (invoices.data ?? []) as any[]) {
    const amount = Number(inv.total_amount ?? 0)
    if (OUTSTANDING_STATUSES.includes(inv.status)) {
      outstandingCount += 1
      outstandingTotal += amount
    }
    // Per-vendor totals aggregate on vendor_id — matches vendors.id for ordinary
    // invoices; placement invoices (vendor_id = directory id) simply won't join.
    if (inv.vendor_id) {
      const agg = invoiceAgg.get(inv.vendor_id) ?? { billed: 0, outstanding: 0, paid: 0 }
      agg.billed += amount
      if (OUTSTANDING_STATUSES.includes(inv.status)) agg.outstanding += 1
      if (inv.status === "paid") agg.paid += 1
      invoiceAgg.set(inv.vendor_id, agg)
    }
    if (inv.status === "paid" && inv.paid_at) {
      const item = placementItemOf(inv.line_items)
      if (item?.directory_id) {
        const prev = paidTermByDirectory.get(item.directory_id)
        if (!prev || inv.paid_at > prev.paidAt) {
          paidTermByDirectory.set(item.directory_id, { paidAt: inv.paid_at, until: item.placement_until ?? null })
        }
      }
    }
  }

  const rows = ((vend.data ?? []) as any[]).map((v) => {
    const dirMatch = dirByVendorId.get(v.id)
    const term = dirMatch ? paidTermByDirectory.get(dirMatch.id) : undefined
    const linkedEmail = linkedUserByVendor.get(v.id) ?? null
    return {
      id: v.id as string,
      name: (v.name as string) ?? "(unnamed)",
      category: (v.category as string) ?? "—",
      brokerageId: v.brokerage_id as string,
      tenant: brokerageName.get(v.brokerage_id) ?? "(unknown tenant)",
      status: (v.status as string) ?? "—",
      inviteStatus: latestInviteByVendor.get(v.id) ?? null,
      linkedEmail,
      // Placement is resolved through the by-name directory match (no FK exists).
      placement: dirMatch
        ? {
            preferred: dirMatch.preferred,
            until: term?.until ?? null,
            paidTerm: !!term,
          }
        : null,
      invoices: invoiceAgg.get(v.id) ?? null,
      createdAt: (v.created_at as string) ?? null,
    }
  })
  rows.sort((a, b) => a.tenant.localeCompare(b.tenant) || a.name.localeCompare(b.name))

  const totalVendors = rows.length
  const preferredNow = dirRows.filter((d) => d.preferred === true).length
  const preferredPaidUnexpired = dirRows.filter((d) => {
    if (d.preferred !== true) return false
    const term = paidTermByDirectory.get(d.id)
    return !!term?.until && new Date(term.until).getTime() >= Date.now()
  }).length
  const linkedCount = rows.filter((r) => r.linkedEmail).length

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Vendors — every tenant</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Cross-tenant vendor network posture: record status, invitation/portal linkage, premium-placement
            monetization state, and the invoice ledger. Placement is joined on
            vendor_directory.vendor_id, the real foreign key to vendors.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/dashboard/superadmin/home" className="rounded-md border px-3 py-1 text-sm">Home</Link>
          <Link href="/dashboard/superadmin/platform" className="rounded-md border px-3 py-1 text-sm">Platform</Link>
        </div>
      </div>

      {/* Posture counts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{totalVendors}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-slate-100 text-slate-700">Total vendors</div>
          <div className="text-[11px] text-muted-foreground mt-1">{linkedCount} with a linked portal account</div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{preferredNow}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">Premium placements active</div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {preferredPaidUnexpired} on an unexpired paid term; the rest are manually curated or pre-date term tracking
          </div>
        </div>
        <div className="rounded-lg border p-3">
          <div className="text-2xl font-bold tabular-nums">{outstandingCount}</div>
          <div className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">Invoices outstanding</div>
          <div className="text-[11px] text-muted-foreground mt-1">{fmtMoney(outstandingTotal)} awaiting payment (submitted / viewed / overdue)</div>
        </div>
      </div>

      {/* Every vendor */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">All vendors ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
            No vendors yet in any tenant.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Vendor</th>
                  <th className="p-2">Category</th>
                  <th className="p-2">Tenant</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Portal account</th>
                  <th className="p-2">Placement</th>
                  <th className="p-2 text-right">Invoiced</th>
                  <th className="p-2 text-right">Open inv.</th>
                  <th className="p-2">Added</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-2">
                      <div className="font-medium">{r.name}</div>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{r.category}</td>
                    <td className="p-2">
                      <Link href={`/dashboard/superadmin/brokerages/${r.brokerageId}`} className="text-xs font-medium text-indigo-600">
                        {r.tenant}
                      </Link>
                    </td>
                    <td className="p-2">
                      <span className={
                        "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                        (r.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600")
                      }>
                        {r.status}
                      </span>
                    </td>
                    <td className="p-2 text-xs">
                      {r.linkedEmail ? (
                        <span className="text-emerald-700" title="Linked via user_role_assignments.vendor_id">{r.linkedEmail}</span>
                      ) : r.inviteStatus ? (
                        <span className={
                          "rounded px-1.5 py-0.5 text-[11px] font-medium " +
                          (r.inviteStatus === "pending" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600")
                        }>
                          invite {r.inviteStatus}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">not invited</span>
                      )}
                    </td>
                    <td className="p-2 text-xs">
                      {r.placement === null ? (
                        <span className="text-muted-foreground">not in directory</span>
                      ) : r.placement.preferred ? (
                        <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800">
                          featured
                          {r.placement.until
                            ? ` until ${new Date(r.placement.until).toLocaleDateString()}`
                            : r.placement.paidTerm
                              ? " (term unrecorded)"
                              : " (manually curated)"}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">standard listing</span>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {r.invoices ? fmtMoney(r.invoices.billed) : "—"}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {r.invoices && r.invoices.outstanding > 0 ? (
                        <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-100 text-red-800">{r.invoices.outstanding}</span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground" title={r.createdAt ?? undefined}>{fmtAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
