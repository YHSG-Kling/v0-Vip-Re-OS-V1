import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveESignProviderForActor } from "@/lib/integrations/resolve-esign-provider"
import { listDirectoryRowsForActor, resolvePacketActor } from "@/lib/forms/tenant-form-packets"
import {
  FORM_DIRECTORY_CATEGORIES, PROVIDER_PAGING_EVIDENCE, classifyResolveFailure, mergeFormDirectory, walkProviderLibrary, type DirectoryFilter, type FormDirectoryCategory,
} from "@/lib/forms/provider-form-directory"

/**
 * GET /api/forms/provider-library — THE FORM DIRECTORY: the connected provider's AUTHORIZED library, walked to the end, merged with
 * the tenant's own library into ONE list (wave 156, lane 156C; originally the provider tab's one-page fetch).
 *
 * WHAT WAS WRONG: this route asked the provider for ONE page (`pageSize: 100`) and returned it as the library — a provider holding 250
 * forms showed 100 and nothing said the rest existed. It also admitted ANY signed-in user with a brokerage (a portal contact or a
 * vendor seat could browse the brokerage's licensed library).
 *
 * NOW:
 *   · GATE: a signed-in ACTIVE tenant staff seat (lib/forms/tenant-form-packets.ts resolvePacketActor — the same seat rule as the
 *     packet library; a contact / vendor / suspended seat is refused 403). Tenant, team and office come from the SESSION.
 *   · WALK: lib/forms/provider-form-directory.ts walkProviderLibrary pages with the provider's cursor (up to 10 pages per request) and
 *     returns `nextCursor` until the provider is exhausted; `loaded`, `scanned`, `total` (the provider's own, when reported) and
 *     `completeness` ("complete" | "more_available" | "unknown_possibly_truncated") travel with every chunk.
 *   · FILTERS: q (text), state, county, category (listing / offer / addendum / disclosure / agency / compliance / other), version,
 *     status (active | retired | all), and the seat's office / team applicability. Unlicensed forms are never listed.
 *   · ONE PICKER: `entries` = the tenant library (brokerage / office / team / agent sources, incl. provider-form references and named
 *     requirements not yet configured) + the provider's forms, an adopted provider form listed ONCE. `forms` keeps the provider-only
 *     list for the wizard's provider tab. No provider PDF bytes are read or stored here.
 *   · REFUSALS: `refusal.code` ∈ no_provider_selected / credentials_need_attention / provider_unavailable / license_missing /
 *     form_not_in_provider_library, with tenant words and the route to fix it. The tenant half still answers when the provider refuses.
 *
 * Query params: cursor, q, state, county, category, version, status.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // GATE FIRST (CLAUDE.md §4), then the service client as the resolved actor.
  const svc = createServiceClient()
  const resolvedActor = await resolvePacketActor(svc as never, user.id)
  if (!resolvedActor.ok) return NextResponse.json({ error: resolvedActor.error, forms: [], entries: [] }, { status: 403 })
  const actor = resolvedActor.actor

  const url = new URL(req.url)
  const p = (k: string) => { const v = (url.searchParams.get(k) ?? "").trim(); return v.length > 0 ? v.slice(0, 200) : null }
  const stateRaw = (p("state") ?? "").toUpperCase()
  const categoryRaw = p("category")
  const statusRaw = p("status")
  const filter: DirectoryFilter = {
    text: p("q"),
    stateCode: /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : null,
    county: p("county"),
    category: categoryRaw && (FORM_DIRECTORY_CATEGORIES as readonly string[]).includes(categoryRaw) ? (categoryRaw as FormDirectoryCategory) : null,
    version: p("version"),
    officeId: actor.locationId ?? null,
    teamId: actor.teamId,
    status: statusRaw === "retired" || statusRaw === "all" ? statusRaw : "active",
  }
  const cursor = p("cursor")

  // The tenant half — read on the first chunk only (a continuation adds provider pages to a list the wizard already holds).
  let tenantRows: Awaited<ReturnType<typeof listDirectoryRowsForActor>> | null = null
  if (!cursor) {
    tenantRows = await listDirectoryRowsForActor(svc as never, actor, { stateCode: filter.stateCode })
    if (!tenantRows.ok) return NextResponse.json({ error: tenantRows.error, forms: [], entries: [] }, { status: 503 })
  }
  const tenant = tenantRows && tenantRows.ok ? tenantRows.rows : []

  let resolved
  try {
    resolved = await resolveESignProviderForActor({ brokerageId: actor.brokerageId, userId: user.id, teamId: actor.teamId })
  } catch (err: any) {
    const refusal = classifyResolveFailure(err?.message)
    return NextResponse.json({
      configured: false, provider: null, forms: [], entries: mergeFormDirectory(tenant, []),
      loaded: 0, scanned: 0, total: null, nextCursor: null, exhausted: true, completeness: "complete", refusal, message: refusal.message,
    })
  }

  const chunk = await walkProviderLibrary(resolved.provider, filter, { cursor })
  if (!chunk.ok) {
    return NextResponse.json({
      configured: true, provider: resolved.providerName, forms: [], entries: mergeFormDirectory(tenant, []),
      loaded: 0, scanned: 0, total: null, nextCursor: cursor, exhausted: false, completeness: "more_available",
      refusal: chunk.refusal, error: chunk.refusal.message,
    }, { status: chunk.refusal.retryable ? 503 : 409 })
  }

  return NextResponse.json({
    configured: true,
    provider:   resolved.providerName,
    forms:      chunk.forms,
    entries:    mergeFormDirectory(tenant, chunk.forms.map((f) => ({ ...f, providerName: resolved.providerName }))),
    loaded:     chunk.forms.length,
    scanned:    chunk.scanned,
    total:      chunk.providerTotal,
    nextCursor: chunk.nextCursor,
    exhausted:  chunk.exhausted,
    completeness: chunk.completeness,
    pagingEvidence: PROVIDER_PAGING_EVIDENCE[resolved.providerName] ?? { verified: false, note: "not verified — no public documentation", source: null },
  })
}
