/**
 * /buyer-intake/[token]
 *
 * PUBLIC token-authed landing page where the buyer self-serves their legal
 * name (with DL upload), funds source, and pre-approval/POF docs. The agent
 * generates the token via POST /api/workflow/buyer-intake/create and texts/
 * emails the URL to the buyer.
 *
 * This is a server component that resolves the token + agent context, then
 * passes everything to the BuyerIntakeForm client component.
 *
 * Outcomes:
 *   - Token valid + pending → render the form
 *   - Token expired         → "this link has expired" + ask agent for new link
 *   - Token already used    → success state ("you already submitted")
 *   - Token not found       → 404
 */

import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import BuyerIntakeForm from "./buyer-intake-form"

export const dynamic = "force-dynamic"

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function BuyerIntakePage({ params }: PageProps) {
  const { token } = await params
  const svc = createServiceClient()

  const { data: tokenRow } = await svc
    .from("buyer_intake_tokens")
    .select("id, status, expires_at, brokerage_id, contact_id, agent_user_id")
    .eq("token", token)
    .maybeSingle()

  if (!tokenRow) notFound()

  // Resolve agent + brokerage display info for the buyer-facing page
  let agentName: string | null = null
  let brokerageName: string | null = null
  if (tokenRow.agent_user_id) {
    const { data: u } = await svc
      .from("users").select("first_name, last_name").eq("id", tokenRow.agent_user_id).maybeSingle()
    if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || null
  }
  const { data: b } = await svc
    .from("brokerages").select("name").eq("id", tokenRow.brokerage_id).maybeSingle()
  if (b) brokerageName = b.name ?? null

  // Resolve contact info to greet the buyer by their first name
  let contactFirstName: string | null = null
  let contactEmail: string | null = null
  if (tokenRow.contact_id) {
    const { data: c } = await svc
      .from("contacts").select("first_name, email").eq("id", tokenRow.contact_id).maybeSingle()
    if (c) {
      contactFirstName = c.first_name ?? null
      contactEmail = c.email ?? null
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 dark:from-slate-950 dark:to-slate-900 py-12 px-4">
      <div className="mx-auto max-w-2xl">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {contactFirstName ? `Welcome, ${contactFirstName}` : "Buyer Intake"}
          </h1>
          {agentName && (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              {agentName}{brokerageName ? ` · ${brokerageName}` : ""} sent you this secure form
              to capture a few details before drafting offers.
            </p>
          )}
        </header>

        <BuyerIntakeForm
          token={token}
          status={tokenRow.status}
          expiresAt={tokenRow.expires_at}
          contactFirstName={contactFirstName}
          contactEmail={contactEmail}
        />
      </div>
    </div>
  )
}
