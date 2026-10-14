import { NextResponse } from "next/server"
import { resolveTransactionProvider } from "@/lib/integrations/transaction-providers/resolve-transaction-provider"
import { providerPortalMode, supportsEmbeddedSend } from "@/lib/integrations/providers/catalog"
import { resolveESignChoice } from "@/lib/integrations/resolve-esign-provider"
import { createClient } from "@/lib/supabase/server"

/**
 * GET /api/form-wizard/resolve-provider — the FormWizard's step-2 provider lookup.
 *
 * TENANT FROM THE SESSION (CLAUDE.md §4, lane 88C). This route used to read
 * `agentUserId`, `teamId` and `brokerageId` from the QUERY STRING and hand them to
 * two service-client resolvers — any signed-in user could name another tenant's
 * brokerage and read which providers it had connected. The query string is now
 * ignored; every id comes from the authenticated user's own row.
 *
 * TOMBSTONE (lane 88C): lib/integrations/transaction-providers/embed-url.ts
 * (getTransactionProviderEmbedUrl) is deleted. It was a second spelling of the
 * provider portal window (§6) that ignored frameability — it handed the wizard
 * "https://dotloop.com/loops?embed=1", which is not a real endpoint and which
 * Dotloop would not let us frame anyway, so step 3 rendered a blank iframe.
 * Survivor: providerPortalMode at lib/integrations/providers/catalog.ts (the same
 * function the Forms Library already used), which answers iframe vs popup from
 * the catalog's evidence-backed `embed` capability.
 *
 * The e-sign answer comes from resolveESignChoice (the ONE rule — the user's / team's /
 * brokerage's e-sign SELECTION, else the DocuSign default carried by the tenant's own
 * DocuSign connection or the platform's DocuSign account; lane 89A), not from the
 * brokerage-wide newest platform_credentials row the old getConnectedEsignProvider read.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthenticated" }, { status: 401 })

  const { data: me, error: meErr } = await supabase
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()
  if (meErr) return NextResponse.json({ error: `Could not read your account: ${meErr.message}` }, { status: 500 })
  const brokerageId = (me?.brokerage_id as string | null) ?? null
  if (!brokerageId) return NextResponse.json({ error: "Your account is not attached to a brokerage" }, { status: 403 })
  const teamId = (me?.team_id as string | null) ?? null

  const [resolved, esign] = await Promise.all([
    resolveTransactionProvider({ agentUserId: user.id, teamId, brokerageId }),
    resolveESignChoice({ brokerageId, userId: user.id, teamId }),
  ])

  const portal = resolved?.provider ? providerPortalMode(resolved.provider) : null
  return NextResponse.json({
    provider: resolved?.provider ?? null,
    credentialsId: resolved?.credentialsId ?? null,
    /** Kept for the existing reader: the portal URL (null when no provider). */
    embedUrl: portal?.url ?? null,
    /** "iframe" only when the vendor documents framing; otherwise "popup". */
    embedMode: portal ? (portal.mode === "iframe" ? "iframe" : "popup") : null,
    providerLabel: portal?.label ?? null,
    esignProvider: esign.ok ? esign.providerName : null,
    esignMode: esign.ok ? (esign.kind === "google" ? "google_drive_handoff" : supportsEmbeddedSend(esign.providerName) ? "embedded_send" : "api_send") : null,
    /** Whose e-sign this is: a "user" / "team" / "brokerage" selection or credential, "platform"
     *  (the platform's DocuSign account carrying the default) or "default" (Google chosen by nobody). */
    esignScope: esign.ok ? (esign.kind === "google" ? esign.resolvedScope : esign.resolved.resolvedScope) : null,
    esignIsDefault: esign.ok ? (esign.kind === "google" ? esign.resolvedScope === "default" : esign.resolved.isDefault) : null,
    esignError: esign.ok ? null : esign.error,
  })
}
