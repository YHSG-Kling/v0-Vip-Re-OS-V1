import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { redirect } from "next/navigation"
import Link from "next/link"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { resolveTenantScope, isTenantScopeRefusal, describeTenantScope, applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"

export const metadata = {
  title: "Download Audit | Document Center",
  description: "Every external-partner document download — who pulled what, when. The egress audit trail.",
}

const RANGES = [7, 30, 90, 365]

// The Document Center's own elevated ladder (app/actions/document-center.ts:88)
// — the seats that see the whole brokerage's documents are the seats that may
// see who downloaded them. 'superadmin' stays out as users.user_type (0 live
// rows); platform staff arrive via platform_role below.
const ELEVATED_ROLES = ["admin", "broker", "broker_owner", "broker_admin", "tc", "transaction_coordinator", "compliance_officer"]

const PARTNER_BADGE: Record<string, string> = {
  lender: "bg-amber-100 text-amber-800",
  title: "bg-blue-100 text-blue-800",
}

/**
 * DOWNLOAD AUDIT — the ledger of documents that LEFT THE BUILDING through the
 * external portal (app/api/external-portal/documents/download/route.ts writes
 * these rows). Compliance-ledger pattern: SSR, resolveTenantScope, pure-Link
 * ?days= filters, honest refusals. An empty download ledger is a compliance
 * claim ("nothing was ever pulled"), so a refused read must never render as it.
 *
 * ip_address / user_agent exist on the table but are written by nobody —
 * displaying them would render blanks that read as data, so they are omitted.
 */
export default async function DocumentDownloadsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/auth/login")
  const { days } = await searchParams

  const { data: userData } = await supabase
    .from("users").select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()
  const userType = userData?.user_type ?? "agent"
  if (!ELEVATED_ROLES.includes(userType)) redirect("/dashboard/documents")
  const isSuperadmin = isPlatformSuperadminIdentity(userType, userData?.platform_role)

  // SCOPE IS DECLARED, NOT INFERRED FROM AN ABSENT ID (§4, fail closed) — the
  // same discriminator the compliance ledger uses: platform authority is the
  // explicit boolean, and "no authority, no tenant" refuses rather than widening.
  let scope: TenantScope
  try {
    scope = resolveTenantScope({
      brokerageId: userData?.brokerage_id,
      platformAuthorized: isSuperadmin,
      platformReason: "platform_role='superadmin' — the cross-tenant document-egress audit trail",
      where: "document downloads page",
    })
  } catch (e) {
    if (!isTenantScopeRefusal(e)) throw e
    // An honest refusal, never a fabricated empty ledger: an empty table here
    // reads as "no document ever left the building", which is a claim about
    // compliance.
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Download Audit</h1>
        <p className="text-sm text-red-700">
          Your account has no brokerage assigned and no platform role, so this ledger cannot be scoped.
          Nothing is shown rather than showing another brokerage&apos;s record. Ask an administrator to
          set your brokerage.
        </p>
      </div>
    )
  }

  const sinceDays = RANGES.includes(Number(days)) ? Number(days) : 30
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString()

  const svc = createServiceClient()
  const { data: rows, error } = await applyTenantScope(
    svc
      .from("document_downloads")
      .select("id, downloaded_at, document_id, user_id, partner_id, partner_type"),
    scope,
  )
    .gte("downloaded_at", since)
    .order("downloaded_at", { ascending: false })
    .limit(200)

  // §3 — supabase-js RESOLVES refusals; without this branch a refused read
  // renders as a clean, empty audit trail.
  if (error) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold">Download Audit</h1>
        <p className="text-sm text-red-700">
          The download ledger could not be read ({error.message}). Nothing is shown rather than
          rendering a refused read as an empty audit trail.
        </p>
      </div>
    )
  }

  const downloads = (rows ?? []) as Array<{
    id: string
    downloaded_at: string
    document_id: string
    user_id: string | null
    partner_id: string | null
    partner_type: string | null
  }>

  // ── THE TWO-SHAPED BRANCH ──────────────────────────────────────────────────
  // partner_id is NOT one id space: the writer (external-portal download route)
  // stamps the caller's vendors.id on the 'lender' lane and their users.id on
  // the 'title' lane. Partition BEFORE building id lists — a blind join of all
  // partner_ids against either table would resolve some rows against the wrong
  // id space and silently mislabel who pulled the document.
  const lenderVendorIds = Array.from(new Set(downloads.filter((d) => d.partner_type === "lender").map((d) => d.partner_id).filter(Boolean))) as string[]
  const titleUserIds = Array.from(new Set(downloads.filter((d) => d.partner_type === "title").map((d) => d.partner_id).filter(Boolean))) as string[]
  const documentIds = Array.from(new Set(downloads.map((d) => d.document_id).filter(Boolean)))

  const [{ data: vendors }, { data: titleUsers }, { data: documents }] = await Promise.all([
    lenderVendorIds.length > 0
      ? applyTenantScope(svc.from("vendors").select("id, name"), scope).in("id", lenderVendorIds)
      : Promise.resolve({ data: [] as any[] }),
    // Title partner users are EXTERNAL to the brokerage — a brokerage_id anchor
    // here would blank every legitimate title name. The ids come off tenant-scoped
    // download rows, and the read is a PK list.
    titleUserIds.length > 0
      ? svc.from("users").select("id, first_name, last_name, email").in("id", titleUserIds)
      : Promise.resolve({ data: [] as any[] }),
    documentIds.length > 0
      ? applyTenantScope(svc.from("documents").select("id, document_type, transaction_id"), scope).in("id", documentIds)
      : Promise.resolve({ data: [] as any[] }),
  ])

  const vendorName = new Map(((vendors ?? []) as any[]).map((v) => [v.id, v.name ?? "Lender"]))
  const titleName = new Map(((titleUsers ?? []) as any[]).map((u) => [
    u.id,
    [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || "Title partner",
  ]))
  const docById = new Map(((documents ?? []) as any[]).map((d) => [d.id, d]))

  const summary = {
    total: downloads.length,
    lender: downloads.filter((d) => d.partner_type === "lender").length,
    title: downloads.filter((d) => d.partner_type === "title").length,
    uniqueDocuments: documentIds.length,
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-semibold">Download Audit</h1>
          <Link href="/dashboard/documents" className="text-sm text-primary hover:underline">
            ← Document Center
          </Link>
        </div>
        <p className="text-xs font-medium text-muted-foreground">{describeTenantScope(scope)}</p>
        <p className="text-sm text-muted-foreground">
          Every external-partner document download — who pulled what, when. The egress audit trail.
        </p>
      </div>

      {/* Summary tiles — the full window. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Downloads", value: summary.total, tone: "text-foreground" },
          { label: "By lenders", value: summary.lender, tone: "text-amber-700" },
          { label: "By title", value: summary.title, tone: "text-blue-700" },
          { label: "Documents touched", value: summary.uniqueDocuments, tone: "text-foreground" },
        ].map((c) => (
          <Card key={c.label} className="p-3">
            <div className={`text-2xl font-semibold ${c.tone}`}>{c.value}</div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
          </Card>
        ))}
      </div>

      {/* Filters — pure links (SSR), no client JS. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Window:</span>
        {RANGES.map((d) => (
          <Link key={d} href={`?days=${d}`} className={`rounded-full px-2.5 py-1 ${d === sinceDays ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {d === 365 ? "1 year" : `${d}d`}
          </Link>
        ))}
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Partner</th>
              <th className="px-3 py-2">Lane</th>
            </tr>
          </thead>
          <tbody>
            {downloads.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">No external downloads in this window.</td></tr>
            )}
            {downloads.map((d) => {
              const doc = docById.get(d.document_id) as { id: string; document_type: string | null; transaction_id: string | null } | undefined
              // documents has NO file_name column — document_type IS the display
              // name (the download route itself returns it as `name`).
              const docLabel = (doc?.document_type ?? "document").replace(/_/g, " ")
              let partnerLabel: string
              let unknownShape = false
              if (d.partner_type === "lender") {
                partnerLabel = (d.partner_id && vendorName.get(d.partner_id)) ?? d.partner_id ?? "—"
              } else if (d.partner_type === "title") {
                partnerLabel = (d.partner_id && titleName.get(d.partner_id)) ?? d.partner_id ?? "—"
              } else {
                // Unknown partner_type: which table partner_id points at is
                // unknowable, so the raw id is shown rather than a blind join.
                partnerLabel = d.partner_id ?? "—"
                unknownShape = true
              }
              return (
                <tr key={d.id} className="border-t align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{new Date(d.downloaded_at).toLocaleString()}</td>
                  <td className="px-3 py-2 capitalize">
                    {doc?.transaction_id ? (
                      <Link href={`/dashboard/transactions/${doc.transaction_id}`} className="text-primary hover:underline">
                        {docLabel}
                      </Link>
                    ) : (
                      docLabel
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {partnerLabel}
                    {unknownShape && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(unrecognized partner lane — raw id shown)</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge className={PARTNER_BADGE[d.partner_type ?? ""] ?? "bg-slate-100 text-slate-700"}>
                      {d.partner_type ?? "unknown"}
                    </Badge>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
