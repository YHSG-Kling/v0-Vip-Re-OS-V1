// lib/content-intel/system-topic-source.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SOURCE ROW A SYSTEM TOPIC WRITER FILES UNDER (wave 144, lane 144G).
//
// LIVE FINDING (Supabase hrvaqgvukzxfskkcrwbt, information_schema, 2026-10-25):
// content_topic_bank.source_id is NOT NULL (m128: `source_id uuid not null references
// content_topic_sources(id)`; no later migration relaxed it). Three SYSTEM writers insert topic
// rows with NO source_id and are therefore refused by the database on every live write:
//   · lib/competitive-intel/brand-listening.ts     (discussion topics → bank)
//   · lib/competitive-intel/promote-to-topic-bank.ts (competitor ad insights → bank)
//   · lib/kernel/lookalike-audience.ts              (look-alike research briefs → bank; outside 144G)
// Their in-memory proofs passed because the fixture database enforces no NOT NULL. The live
// table holds 0 rows (2026-10-25), so nothing has been lost yet — the writers simply never landed.
//
// The rule kept (provenance, OS principle 4): every topic names the SOURCE that produced it. A
// system writer is a source too, so it gets a content_topic_sources row of its own, per tenant,
// on the existing vocabulary: source_type 'manual' (the live CHECK allows reddit / youtube_search /
// google_trends / rss / manual / apify_actor — no new spelling, §6; 'manual' is the one type NO
// ingest cron iterates, so the row is never fetched as a feed). It is visible in the tenant's
// content-sources screen (app/actions/content-intel/sources.ts lists the brokerage's rows), and
// is_active is the tenant's own off switch for that writer.
//
// Not server-only: the proofs drive it with an in-memory client.

type Db = { from: (table: string) => any }

/** The system writers that file topics under their own source row. */
export const SYSTEM_TOPIC_WRITERS = {
  local_intel: "Local intelligence — events & news (system)",
  brand_listening: "Brand listening topics (system)",
  competitor_promotion: "Competitor ad insights (system)",
  lookalike_research: "Look-alike research briefs (system)",
} as const
export type SystemTopicWriter = keyof typeof SYSTEM_TOPIC_WRITERS

export type SystemTopicSource =
  | { ok: true; id: string; active: boolean; created: boolean }
  | { ok: false; error: string }

/**
 * Find (or create, once) THIS tenant's source row for a system writer. Tenant-pinned on every
 * read and write; a refused read or insert is returned as an error, never as "no source".
 */
export async function resolveSystemTopicSource(db: Db, brokerageId: string, writer: SystemTopicWriter): Promise<SystemTopicSource> {
  if (!brokerageId) return { ok: false, error: "no tenant — a system topic source is per brokerage" }
  const { data, error } = await db.from("content_topic_sources")
    .select("id, is_active")
    .eq("brokerage_id", brokerageId)
    .eq("source_type", "manual")
    .contains("source_config", { system_writer: writer })
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) return { ok: false, error: `content_topic_sources read refused: ${error.message ?? "unknown"}` }
  const found = ((data ?? []) as Array<{ id: string; is_active: boolean | null }>)[0]
  if (found) return { ok: true, id: found.id, active: found.is_active !== false, created: false }
  const { data: ins, error: insErr } = await db.from("content_topic_sources")
    .insert({
      brokerage_id: brokerageId,
      source_type: "manual",
      label: SYSTEM_TOPIC_WRITERS[writer],
      is_active: true,
      source_config: { system_writer: writer, note: "Filed by the platform's own writer; turn it off to stop this writer feeding your topic bank." },
    })
    .select("id")
    .single()
  const row = (Array.isArray(ins) ? ins[0] : ins) as { id?: string } | null | undefined
  if (insErr || !row?.id) return { ok: false, error: `content_topic_sources insert refused: ${insErr?.message ?? "no row returned"}` }
  return { ok: true, id: String(row.id), active: true, created: true }
}
