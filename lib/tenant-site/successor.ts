// lib/tenant-site/successor.ts
// ─────────────────────────────────────────────────────────────────────────────
// AN ARCHIVED WORKSPACE FORWARDS TO THE BROKERAGE THAT ADOPTED IT (wave 143, lane 143G).
//
// AUDITED FIRST (LAW 1): lib/kernel/brokerage-transfer.ts archives the SOURCE tenant (brokerages.status 'archived',
// archived_at — "archived, never deleted") once an independent subscriber is adopted by a brokerage, and moves the
// subscriber's book, website content and landing pages to the target. Nothing downstream READS the archive: the public
// storefront (app/site/[slug]) and the website chat widget (lib/widget/resolve-widget-tenant.ts) resolve a tenant by slug
// and ignore status, so after a transfer the old URL kept serving a hollow storefront and the embedded chat widget kept
// answering and filing every new lead under a tenant nobody reads. The owner's transfer ruling: "provenance of … websites
// … preserved … brokerage owns the seat/platform relationship" — so the old public handle follows the relationship.
//
// RULE: an archived workspace has no public surface of its own. Its slug forwards to the target of its COMPLETED transfer
// (the request row is the proof — never a guess); no completed transfer, a target that is itself archived/deleted, or an
// unreadable lookup ⇒ no successor (the caller 404s / 503s — fail closed). One hop only: a chain is never followed, so a
// loop is impossible by construction.
//
// TENANT (CLAUDE.md §4): the archived id comes from the slug the visitor typed (the public handle IS the key); the
// successor is read from the transfer request pinned to THAT source id — never from a body or a parameter.
//
// Not "use server": plain functions over the caller's client.

type Svc = any

export interface SiteSuccessorRow { id: string; slug: string; name: string; widget_enabled: boolean | null }

export type SiteSuccessor =
  | { ok: true; successor: SiteSuccessorRow }
  | { ok: false; reason: "none" | "unreadable" }

export async function resolveArchivedSiteSuccessor(svc: Svc, archivedBrokerageId: string): Promise<SiteSuccessor> {
  if (!archivedBrokerageId) return { ok: false, reason: "none" }
  try {
    const { data: req, error: reqErr } = await svc.from("brokerage_transfer_requests")
      .select("target_brokerage_id, completed_at")
      .eq("source_brokerage_id", archivedBrokerageId).eq("status", "completed")
      .order("completed_at", { ascending: false }).limit(1).maybeSingle()
    if (reqErr) return { ok: false, reason: "unreadable" }
    const targetId = (req as { target_brokerage_id?: string | null } | null)?.target_brokerage_id
    if (!targetId) return { ok: false, reason: "none" }
    const { data: t, error: tErr } = await svc.from("brokerages")
      .select("id, slug, name, status, deleted_at, archived_at, widget_enabled").eq("id", targetId).maybeSingle()
    if (tErr) return { ok: false, reason: "unreadable" }
    const row = t as { id: string; slug: string | null; name: string | null; status: string | null; deleted_at: string | null; archived_at: string | null; widget_enabled: boolean | null } | null
    if (!row || row.deleted_at || row.archived_at || row.status === "archived" || !row.slug) return { ok: false, reason: "none" }
    return { ok: true, successor: { id: row.id, slug: row.slug, name: row.name ?? "", widget_enabled: row.widget_enabled } }
  } catch {
    return { ok: false, reason: "unreadable" }
  }
}
