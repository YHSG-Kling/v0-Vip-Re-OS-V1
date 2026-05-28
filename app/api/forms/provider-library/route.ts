import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { resolveESignProviderForActor } from "@/lib/integrations/resolve-esign-provider"

/**
 * GET /api/forms/provider-library
 *
 * Returns the list of forms available from the agent's configured transaction
 * provider (Dotloop, DocuSign, SkySlope, Authentisign). FormWizard merges
 * these with the brokerage's uploaded storage forms so the agent can pick
 * from either source in the same UI.
 *
 * Query params:
 *   state    — Two-letter state code (e.g. TX). Optional.
 *   category — offer | listing | addendum | disclosure | agency. Optional.
 *   q        — Free-text search. Optional.
 *
 * Auth: requires a logged-in user. Provider credentials are resolved via the
 * user → team → brokerage cascade (resolveESignProviderForActor).
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!profile?.brokerage_id) {
    return NextResponse.json({ error: "User has no brokerage" }, { status: 400 })
  }

  let resolved
  try {
    resolved = await resolveESignProviderForActor({
      brokerageId: profile.brokerage_id,
      userId:      user.id,
      teamId:      (profile.team_id as string | null) ?? null,
    })
  } catch (err: any) {
    // No provider configured — return empty so the FormWizard just hides the tab.
    return NextResponse.json({
      configured: false,
      provider:   null,
      forms:      [],
      message:    err?.message ?? "No transaction provider configured.",
    })
  }

  const url      = new URL(req.url)
  const state    = url.searchParams.get("state") ?? undefined
  const category = url.searchParams.get("category") ?? undefined
  const query    = url.searchParams.get("q") ?? undefined

  const result = await resolved.provider.listForms({
    stateCode: state ?? undefined,
    category:  category ?? undefined,
    query:     query ?? undefined,
    pageSize:  100,
  })

  if (!result.success) {
    return NextResponse.json({
      configured: true,
      provider:   resolved.providerName,
      forms:      [],
      error:      result.error,
    }, { status: 502 })
  }

  return NextResponse.json({
    configured: true,
    provider:   resolved.providerName,
    forms:      result.forms ?? [],
  })
}
