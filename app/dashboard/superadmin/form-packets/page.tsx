/**
 * app/dashboard/superadmin/form-packets/page.tsx — PLATFORM FORM PACKETS (platform Media).
 *
 * Wave 143, lane 143B. The licensed fillable form packets the platform holds for every subscriber: load a PDF
 * (it registers as a DRAFT with its fillable-field count), record the licence it is held under, approve it —
 * and every subscriber's FormWizard offers it (scope "platform") until it is retired or the licence expires.
 * Core: lib/forms/platform-form-packets.ts. Gated on superadmin before the service client (§4 gate first).
 * No tenant predicate BY DESIGN — platform content has no tenant.
 */
import Link from "next/link"
import { redirect } from "next/navigation"
import { requireSuperadmin } from "@/lib/auth/platform-guard"
import { createServiceClient } from "@/lib/supabase/service"
import { PLATFORM_PACKET_TYPES } from "@/lib/forms/platform-form-packets"
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
    .select("id, name, state, packet_type, form_code, description, file_name, field_count, status, version, license_note, license_expires_at, approved_at, retired_at, retired_reason, created_at")
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

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Form packets — platform</h1>
          <p className="text-sm text-muted-foreground">
            Licensed fillable packets held for every subscriber. A packet reaches tenants only when approved here, with the licence it is held under, and stops the moment it is retired or the licence expires.
          </p>
        </div>
        <Link href="/dashboard/superadmin/home" className="text-sm underline">Home</Link>
      </div>
      <PlatformPacketsClient packets={(data ?? []) as PacketListRow[]} packetTypes={[...PLATFORM_PACKET_TYPES]} />
    </div>
  )
}
