/**
 * /dashboard/admin/transaction-forms
 *
 * Broker admin UI for the brokerage_form_library — broker-uploaded
 * transaction forms (state-specific addenda, brokerage representation
 * forms, custom disclosures) the AI form-fill engine consults when
 * assembling offer/listing packets.
 *
 * Distinct from /dashboard/admin/forms (which manages lead-capture
 * web forms in the `forms` table).
 */

import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { isTenantAdminOrPlatformStaff } from "@/lib/auth/resolve-user-role"
import TransactionFormsClient from "./transaction-forms-client"
import { RoleGateNotice } from "@/app/components/shared/role-gate-notice"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Transaction Form Library | Admin",
  description: "Upload and manage state-specific legal forms used by the AI form-fill engine.",
}

export default async function TransactionFormsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login?redirect=/dashboard/admin/transaction-forms")

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  // Tenant-admin config with platform staff admitted — user_type and platform_role
  // each answer their own half, never coalesced (same gate as the API route).
  if (!brokerageId) redirect("/dashboard/onboarding")
  if (!isTenantAdminOrPlatformStaff(userRow ?? {})) {
    return <RoleGateNotice surface="Legal forms" audience="brokerage admins and platform staff" />
  }

  // The AUTHED client: m853's row policy answers which packets this person's memberships reach (a team lead sees their own
  // team's packets and the brokerage's, never another team's). `error` is READ — a refused read is shown, never an empty library.
  const { data: forms, error: formsError } = await supabase
    .from("brokerage_form_library")
    .select("id, name, description, state, packet_type, pdf_url, field_schema, is_active, created_at, team_id, form_code, license_note, license_expires_at, source_platform_packet_id, storage_path")
    .eq("brokerage_id", brokerageId)
    .order("state", { ascending: true })
    .order("packet_type", { ascending: true })
    .order("name", { ascending: true })

  return (
    <div className="px-6 py-6 space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Transaction Form Library</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Your brokerage&apos;s own form packets: state forms, addenda, representation disclosures and your branded
          templates. Share a packet with the whole brokerage or with one team. Agents see only the packets their brokerage and
          their own team share, in the Form Wizard. You can also add a licensed packet from the VIPAgents catalogue to your library.
        </p>
      </header>

      {formsError && (
        <p className="text-sm text-red-600">Your form library could not be read: {formsError.message}</p>
      )}
      <TransactionFormsClient initialForms={forms ?? []} />
    </div>
  )
}
