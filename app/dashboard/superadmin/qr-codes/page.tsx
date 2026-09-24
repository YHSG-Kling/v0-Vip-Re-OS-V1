/**
 * app/dashboard/superadmin/qr-codes/page.tsx — THE PLATFORM QR BOARD.
 *
 * Wave 81, lane 81D — owner verbatim: "the qrcode system agent needs to make
 * sure that any qrcode that gets created for assets are added to the qrcode
 * management which is wired to the platform if used for platform or tenants
 * dashboard."
 *
 * The QR management registry is `qr_codes` — ONE table, ONE writer
 * (lib/marketing/tracked-qr.ts mintTrackedQr), ONE scan resolver
 * (/api/qr/scan). Every code the OS mints anywhere — video outros
 * (lib/video/video-qr.ts), listing flyers/packets (lib/marketing/marketing-qr.ts),
 * listing launches, open-house sign-in, lead magnets, direct-mail postcards,
 * studio QR assets, business cards created on the tenant board — lands here
 * at creation (scripts/qr-registry-guard.ts is the sweep that proves no emitter
 * encodes a QR image outside the registry).
 *
 * TWO BOARDS, ONE CLASSIFIER (qrOwnerKind): a tenant's codes show on the
 * tenant board (app/dashboard/agent/qr-codes, scoped agent/team/brokerage by
 * the session); THIS board is the platform's view — every tenant's codes
 * (platform staff see all tenants, CLAUDE.md §4) plus the PLATFORM-OWNED codes
 * (brokerage_id null, label `platform:*` — legal once m664 is applied).
 *
 * Read-only. Gated on the `marketing` platform capability before the service
 * client (§4 gate first). No tenant predicate BY DESIGN — this is the platform
 * seeing all tenants, not a tenant surface.
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { createServiceClient } from "@/lib/supabase/service"
import { qrOwnerKind, normalizeOrigin, type QrOwnerKind } from "@/lib/marketing/tracked-qr"
import { summarizeQrRegistry } from "@/lib/marketing/qr-registry-board"
import { agoOrNever } from "@/lib/format/dates"

export const dynamic = "force-dynamic"
export const metadata = { title: "QR registry — platform" }

interface QrRow {
  id: string
  brokerage_id: string | null
  agent_id: string | null
  label: string
  slug: string
  purpose: string | null
  destination_type: string | null
  target_url: string
  scan_count: number | null
  lead_count: number | null
  is_active: boolean
  created_at: string
  marketing_campaign_id: string | null
  listing_id: string | null
}

export default async function SuperadminQrRegistryPage() {
  const gate = await requirePlatformCapability("marketing")
  if (!gate.userId) redirect("/login")
  if (!gate.ok) return <div className="p-6 text-red-600">Forbidden: platform marketing staff only</div>

  const svc = createServiceClient()
  const [codes, brokerages] = await Promise.all([
    svc.from("qr_codes")
      .select("id, brokerage_id, agent_id, label, slug, purpose, destination_type, target_url, scan_count, lead_count, is_active, created_at, marketing_campaign_id, listing_id")
      .order("created_at", { ascending: false })
      .limit(500),
    svc.from("brokerages").select("id, name").is("deleted_at", null),
  ])
  if (codes.error) return <div className="p-6 text-red-600">Failed to load the QR registry: {codes.error.message}</div>
  if (brokerages.error) return <div className="p-6 text-red-600">Failed to load tenants: {brokerages.error.message}</div>

  const rows = (codes.data ?? []) as QrRow[]
  const tenantName = new Map(((brokerages.data ?? []) as Array<{ id: string; name: string }>).map((b) => [b.id, b.name]))
  const summary = summarizeQrRegistry(rows)
  const origin = normalizeOrigin()
  const ownerLabel = (r: QrRow): string => (qrOwnerKind(r) === "platform" ? "Platform" : tenantName.get(r.brokerage_id!) ?? r.brokerage_id!)
  const ownerCls: Record<QrOwnerKind, string> = { platform: "bg-purple-100 text-purple-800", tenant: "bg-slate-100 text-slate-700" }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">QR registry — platform + every tenant</h1>
          <p className="text-sm text-muted-foreground">
            The one QR management registry (qr_codes). Newest 500 codes across the fleet: who owns each, where it points, and its tracked scans through /api/qr/scan.
          </p>
        </div>
        <Link href="/dashboard/superadmin/home" className="text-sm underline">Home</Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-5 text-sm">
        <div className="rounded border p-3"><div className="text-muted-foreground text-xs">Codes (shown)</div><div className="text-lg font-semibold">{summary.total}</div></div>
        <div className="rounded border p-3"><div className="text-muted-foreground text-xs">Platform-owned</div><div className="text-lg font-semibold">{summary.platform}</div></div>
        <div className="rounded border p-3"><div className="text-muted-foreground text-xs">Tenant-owned</div><div className="text-lg font-semibold">{summary.tenant}</div></div>
        <div className="rounded border p-3"><div className="text-muted-foreground text-xs">Active</div><div className="text-lg font-semibold">{summary.active}</div></div>
        <div className="rounded border p-3"><div className="text-muted-foreground text-xs">Scans (sum)</div><div className="text-lg font-semibold">{summary.scans}</div></div>
      </div>

      {summary.platform === 0 && (
        <p className="text-xs text-muted-foreground">
          No platform-owned codes yet. A platform code carries no brokerage (label <code>platform:…</code>) and needs migration m664 applied before the registry accepts one; until then a platform mint returns an honest refusal.
        </p>
      )}

      <div className="overflow-x-auto rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs">
            <tr>
              <th className="p-2">Owner</th>
              <th className="p-2">Label (idempotency key)</th>
              <th className="p-2">Purpose</th>
              <th className="p-2">Destination</th>
              <th className="p-2">Scans</th>
              <th className="p-2">Leads</th>
              <th className="p-2">State</th>
              <th className="p-2">Minted</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td className="p-3 text-muted-foreground" colSpan={8}>No codes in the registry yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t align-top">
                <td className="p-2 whitespace-nowrap">
                  <span className={`rounded px-2 py-0.5 text-xs ${ownerCls[qrOwnerKind(r)]}`}>{ownerLabel(r)}</span>
                </td>
                <td className="p-2">
                  <div className="font-medium break-all">{r.label}</div>
                  <a className="text-xs underline break-all" href={`${origin}/api/qr/scan?slug=${r.slug}`} target="_blank" rel="noreferrer">scan link</a>
                </td>
                <td className="p-2 text-xs capitalize">{r.purpose ?? "—"}</td>
                <td className="p-2 text-xs">
                  <div>{r.destination_type ?? "—"}</div>
                  <a className="underline break-all text-muted-foreground" href={r.target_url} target="_blank" rel="noreferrer">{r.target_url}</a>
                </td>
                <td className="p-2 text-xs">{r.scan_count ?? 0}</td>
                <td className="p-2 text-xs">{r.lead_count ?? 0}</td>
                <td className="p-2 text-xs">{r.is_active ? "active" : "inactive"}</td>
                <td className="p-2 text-xs whitespace-nowrap">{agoOrNever(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
