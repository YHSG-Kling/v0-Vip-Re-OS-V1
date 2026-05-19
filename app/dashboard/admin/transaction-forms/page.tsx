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
import TransactionFormsClient from "./transaction-forms-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Transaction Form Library | Admin",
  description: "Upload and manage state-specific transaction forms used by the AI form-fill engine.",
}

const ADMIN_ROLES = new Set(["admin", "superadmin", "broker", "broker_admin"])

export default async function TransactionFormsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login?redirect=/dashboard/admin/transaction-forms")

  const { data: userRow } = await supabase
    .from("users").select("brokerage_id, role, platform_role").eq("id", user.id).maybeSingle()
  const brokerageId = userRow?.brokerage_id
  const role = userRow?.role ?? userRow?.platform_role
  if (!brokerageId || !role || !ADMIN_ROLES.has(role)) {
    redirect("/dashboard")
  }

  const { data: forms } = await supabase
    .from("brokerage_form_library")
    .select("id, name, description, state, packet_type, pdf_url, field_schema, is_active, created_at")
    .eq("brokerage_id", brokerageId)
    .order("state", { ascending: true })
    .order("packet_type", { ascending: true })
    .order("name", { ascending: true })

  return (
    <div className="px-6 py-6 space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Transaction Form Library</h1>
        <p className="text-sm text-muted-foreground max-w-2xl">
          Upload custom transaction forms (state-specific addenda, brokerage representation
          disclosures, custom forms). The AI form-fill engine uses these alongside the
          built-in 50-state registry when assembling offer and listing packets for your agents.
        </p>
      </header>

      <TransactionFormsClient initialForms={forms ?? []} />
    </div>
  )
}
