// lib/tenant-site/landing-page.ts
// ─────────────────────────────────────────────────────────────────────────────
// LANDING PAGES INSIDE THE TENANT WEBSITE (wave 143, lane 143G; owner: "landing pages live inside the tenant
// website created automatically when the tenant subscribes").
//
// AUDITED FIRST (LAW 1, no second renderer): the landing page already exists — app/lm/[slug]/page.tsx renders a
// lead_capture_forms row (AI landing copy, GEO FAQ, video slot, consent-bearing capture form). It had two defects
// against the ruling: (1) it is a DETACHED host — nothing placed it under the tenant's /site/<slug> storefront or
// its connected custom domain; (2) it reads the form by slug ALONE, so on a tenant's vanity host (proxy.ts passes
// non-/site paths through unchanged) /lm/<any-slug> served ANOTHER tenant's landing page under this tenant's
// domain. The survivor is KEPT and EXTENDED: the route app/site/[slug]/lm/[formSlug]/page.tsx proves the form
// belongs to THIS site's brokerage with the functions below, then renders the survivor's own page (no copy of the
// renderer), and proxy.ts serves a connected domain's /lm/<slug> through that route.
//
// TENANT (CLAUDE.md §4): the site slug names the tenant (the public storefront URL IS the tenant key, resolved to
// brokerages.id here); the form is read WITH that brokerage_id in the predicate — the tenant is in the query, never
// compared after the fact, so another tenant's form is "no row" and indistinguishable from a missing one (no
// enumeration). A refused read FAILS CLOSED ("unreadable" — the page 404s; "nobody checked" never renders as
// "checked and fine"). The form's active/draft gate stays the survivor's (a draft previews only for a proven member).
//
// Not "use server": plain functions over the caller's client; the route owns the client.

type Svc = any

export interface TenantLandingSite {
  id: string
  name: string
  slug: string
  logoUrl: string | null
  primaryColor: string | null
}

export type TenantLandingResolution =
  | { ok: true; site: TenantLandingSite; formId: string }
  | { ok: false; reason: "unreadable" | "no_site" | "no_form" }

/**
 * Resolve (site slug, landing slug) → the tenant and the form that BELONGS to it. `ok:false` for a missing site, a
 * missing form, OR a form owned by a different tenant (all "no_form" — the caller renders the same 404); `unreadable`
 * when either read was refused. Never throws.
 */
export async function resolveTenantLandingForm(svc: Svc, siteSlug: string, formSlug: string): Promise<TenantLandingResolution> {
  const site = (siteSlug ?? "").trim()
  const form = (formSlug ?? "").trim()
  if (!site || !form) return { ok: false, reason: "no_form" }
  try {
    const { data: b, error: bErr } = await svc.from("brokerages")
      .select("id, name, slug, logo_url, primary_color")
      .eq("slug", site).is("deleted_at", null).maybeSingle()
    if (bErr) return { ok: false, reason: "unreadable" }
    if (!b) return { ok: false, reason: "no_site" }
    const row = b as { id: string; name: string | null; slug: string | null; logo_url: string | null; primary_color: string | null }
    const { data: f, error: fErr } = await svc.from("lead_capture_forms")
      .select("id")
      .eq("slug", form).eq("brokerage_id", row.id).maybeSingle()
    if (fErr) return { ok: false, reason: "unreadable" }
    if (!f) return { ok: false, reason: "no_form" }
    return {
      ok: true,
      formId: (f as { id: string }).id,
      site: { id: row.id, name: row.name ?? "", slug: row.slug ?? site, logoUrl: row.logo_url ?? null, primaryColor: row.primary_color ?? null },
    }
  } catch {
    return { ok: false, reason: "unreadable" }
  }
}
