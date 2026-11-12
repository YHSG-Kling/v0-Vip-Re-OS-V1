// lib/listings/listing-slug.ts
// ─────────────────────────────────────────────────────────────────────────────
// LISTING → PROPERTY PAGE, BY CONSTRUCTION (wave 81, lane 81D — owner: "…
// automatic video landing pages for when a new video is created, property
// listing page, etc. just make sure the whole platform is properly coded and
// working for production.").
//
// FOUND: app/listing/[slug]/page.tsx serves a listing ONLY through
// listings.slug (app/actions/listing-landing.ts getListingBySlug), and the
// column had NO production writer — the demo seed (lib/platform/demo-tenant.ts)
// was the only place a slug was ever set, and saveListingDraftAction's
// allow-list lets an agent type one by hand. So a real listing had no public
// page unless someone remembered to name it. This module is the missing half
// (§1.2): ONE pure slug rule, ONE idempotent writer, ONE bounded sweep.
//
//   buildListingSlug(address, city, state, id) — PURE, deterministic, unique by
//     construction (the listing id's first 8 hex chars ride the tail, so two
//     "123 Main St" listings never collide and a corrected address never moves
//     an existing slug — see ensureListingSlug).
//   ensureListingSlug(svc, { listingId, brokerageId }) — idempotent: a listing
//     that already carries a slug KEEPS it (printed QR codes and indexed URLs
//     must never move); tenant-predicated on every read and write; the update
//     is COUNTED (.select) so a refused/unmatched write is reported, never
//     mistaken for success (CLAUDE.md §3).
//   ensureMissingListingSlugs(svc, limit) — the net: a bounded sweep the
//     geo-reel-autopublish tick runs so every non-draft listing has a page
//     even when it was created off the two hooked paths.
//
// No model calls, no network. Every DB-touching dependency is passed in.

export const LISTING_SLUG_MAX = 72

/** PURE: kebab of the address + city + state, tailed by the id's first 8 hex
 *  chars — stable, unique, and safe to print. */
export function buildListingSlug(address: string | null | undefined, city: string | null | undefined, state: string | null | undefined, listingId: string): string {
  const tail = listingId.replace(/-/g, "").slice(0, 8).toLowerCase() || "listing"
  const base = [address, city, state].filter((s): s is string => !!s && s.trim().length > 0).join(" ")
    .toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, LISTING_SLUG_MAX - tail.length - 1)
  return `${base || "home"}-${tail}`
}

export type EnsureSlugOutcome =
  | { ok: true; slug: string; created: boolean }
  | { ok: false; reason: string }

/**
 * Idempotent, tenant-predicated, counted. A listing with a slug keeps it; a
 * listing without one gets buildListingSlug(); a refused read or an unmatched
 * update (wrong tenant / gone listing) is reported by name.
 */
export async function ensureListingSlug(svc: any, args: { listingId: string; brokerageId: string }): Promise<EnsureSlugOutcome> {
  if (!args.listingId || !args.brokerageId) return { ok: false, reason: "ensureListingSlug needs a listing id and the session's brokerage id" }
  const { data: row, error } = await svc.from("listings")
    .select("id, slug, address, city, state")
    .eq("id", args.listingId).eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, reason: `listing read refused: ${error.message}` }
  if (!row) return { ok: false, reason: "listing not found in this brokerage" }
  const existing = (row as { slug?: string | null }).slug
  if (existing && existing.trim()) return { ok: true, slug: existing, created: false }
  const r = row as { address?: string | null; city?: string | null; state?: string | null }
  const slug = buildListingSlug(r.address, r.city, r.state, args.listingId)
  const { data: updated, error: upErr } = await svc.from("listings")
    .update({ slug, updated_at: new Date().toISOString() })
    .eq("id", args.listingId).eq("brokerage_id", args.brokerageId).is("slug", null)
    .select("id")
  if (upErr) return { ok: false, reason: `listing slug write refused: ${upErr.message}` }
  const n = Array.isArray(updated) ? updated.length : 0
  if (n !== 1) {
    // Zero rows: the listing gained a slug between the read and the write (a
    // race with the sweep) — re-read rather than report a phantom success.
    const { data: again, error: againErr } = await svc.from("listings").select("slug").eq("id", args.listingId).eq("brokerage_id", args.brokerageId).maybeSingle()
    if (againErr || !(again as { slug?: string | null } | null)?.slug) return { ok: false, reason: `listing slug write matched ${n} rows and no slug is on the row` }
    return { ok: true, slug: (again as { slug: string }).slug, created: false }
  }
  return { ok: true, slug, created: true }
}

/** The net: give every non-draft, undeleted listing without a slug its page.
 *  Bounded; per-listing outcomes are counted, refusals named. */
export async function ensureMissingListingSlugs(svc: any, limit = 100): Promise<{ scanned: number; created: number; errors: string[] }> {
  const { data, error } = await svc.from("listings")
    .select("id, brokerage_id")
    .is("slug", null).is("deleted_at", null).neq("status", "draft")
    .order("updated_at", { ascending: true })
    .limit(limit)
  if (error) return { scanned: 0, created: 0, errors: [`listing sweep read refused: ${error.message}`] }
  const rows = (data ?? []) as Array<{ id: string; brokerage_id: string | null }>
  let created = 0
  const errors: string[] = []
  for (const r of rows) {
    if (!r.brokerage_id) { errors.push(`${r.id}: no brokerage`); continue }
    const out = await ensureListingSlug(svc, { listingId: r.id, brokerageId: r.brokerage_id })
    if (!out.ok) errors.push(`${r.id}: ${out.reason}`)
    else if (out.created) created++
  }
  return { scanned: rows.length, created, errors }
}
