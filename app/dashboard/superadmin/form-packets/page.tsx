/**
 * app/dashboard/superadmin/form-packets/page.tsx — THE VIPAGENTS FORM CATALOGUE (platform-provided packets).
 *
 * Wave 143, lane 143B built this as platform Media handed straight to every subscriber's FormWizard. Wave 144 (lane 144C, owner
 * ruling 3: "Form packets are NOT platform-owned … The brokerage or team uploads approved form packets … into THEIR OWN tenant/team
 * bucket and shares them with their agents") makes it a CATALOGUE: load a PDF (it registers as a DRAFT with its fillable-field
 * count), record the licence it is held under, approve it — and a BROKERAGE may then add it to its OWN library (a copy in its own
 * folder, app/dashboard/admin/transaction-forms), where its agents see it through their memberships. No agent sees a catalogue
 * packet directly. Core: lib/forms/platform-form-packets.ts. Gated on superadmin before the service client (§4 gate first).
 * No tenant predicate BY DESIGN — catalogue content has no tenant.
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { createServiceClient } from "@/lib/supabase/service"
import { PLATFORM_PACKET_TYPES, usablePlatformPaths } from "@/lib/forms/platform-form-packets"
import { PlatformPacketsClient, type PacketListRow } from "./platform-packets-client"

export const dynamic = "force-dynamic"
export const metadata = { title: "Form packets — platform" }

export default async function PlatformFormPacketsPage() {
  const gate = await requireSuperadmin()
  if (!gate.ok) {
    if (gate.error === "Unauthenticated") redirect("/login")
    return <div className="p-6 text-red-600">Forbidden: platform superadmin only</div>
  }

  const svc = createServiceClient()
  const { data, error } = await svc
    .from("platform_form_packets")
    .select("id, name, state, packet_type, form_code, description, file_name, field_count, status, version, license_note, license_expires_at, approved_at, retired_at, retired_reason, created_at, storage_path")
    .order("created_at", { ascending: false })
    .limit(500)
  // A refused read is shown as a fault, never as an empty library (m807 may not be applied yet).
  if (error) {
    return (
      <div className="p-6 space-y-2">
        <h1 className="text-xl font-semibold">Form packets — platform</h1>
        <p className="text-sm text-red-600">The packet registry could not be read: {error.message}</p>
        <p className="text-xs text-muted-foreground">If the table does not exist yet, migration m807 (platform_form_packets) has not been applied.</p>
      </div>
    )
  }

  // WHICH APPROVED PACKETS ARE OFFERED TO BROKERAGES RIGHT NOW — the registry's own admission (the rule that guards the copy into a
  // brokerage's library), so staff see what a brokerage admin will see, not a re-derived guess. A refused check shows as not offered.
  const rows = (data ?? []) as PacketListRow[]
  const offered = await usablePlatformPaths(svc, rows.map((r) => r.storage_path ?? "").filter(Boolean))
  const withOffer = rows.map((r) => ({ ...r, offered_now: offered.ok && !!r.storage_path && offered.usable.has(r.storage_path) }))

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Form packets — VIPAgents catalogue</h1>
          <p className="text-sm text-muted-foreground">
            Licensed fillable packets the platform provides as a catalogue. Packets belong to brokerages and teams: an approved catalogue packet is offered to a brokerage&apos;s admins, who may add it to their OWN library (a copy in their own folder, shared with their brokerage or one team). Agents never see a catalogue packet directly. A retired or expired packet can no longer be added.
          </p>
        </div>
        <Link href="/dashboard/superadmin/home" className="text-sm underline">Home</Link>
      </div>
      <PlatformPacketsClient packets={withOffer} packetTypes={[...PLATFORM_PACKET_TYPES]} />
    </div>
  )
}
