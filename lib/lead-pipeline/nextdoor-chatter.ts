// lib/lead-pipeline/nextdoor-chatter.ts
// ─────────────────────────────────────────────────────────────────────────────
// NEXTDOOR THROUGH THE PAGE TRANSPORT (wave 153, lane 153N — owner ruling B2, verbatim: "nextdoor goes through zyte or
// zenrows").
//
// The ONE Nextdoor fetch: lib/providers/scrape-checkpoint.ts fetchCheckpointedSnapshot under the purpose
// `real_estate_need_chatter` (owner ruling B3) — robots, terms, spend gate, tick budget, backoff and the content digest before
// and after any paid request. RIGHTS: Nextdoor's Member Agreement forbids unauthorized scraping, so the checkpoint's terms
// verdict for nextdoor.com is the NAMED hold `license_required` until a reviewed written agreement is recorded
// (SCRAPE_TARGET_AGREEMENTS["nextdoor.com"] — an OWNER decision). Until then this returns `held` naming LICENSE_REQUIRED and
// spends nothing.
//
// Survivor of the retired ZenrowsClient.scrapeNextdoor (lib/external/zenrows-client.ts tombstone). A module of its own, with
// only dynamic imports, so the manual reader (app/actions/lead-intelligence.ts) does not pull the social sourcer's graph into
// every page that imports it (scripts/proxy-graph-budget-guard.ts). Callers: the lead-scraping cron (records through the
// caller's `normalize` — social-sourcer.ts normalizeNextdoorPost with the territory's resolved keywords) and the manual reader
// (its own parser over `html`). `commit` runs after the caller's producer accepted the batch.

import type { NormalizedScrapedRecord } from "./raw-record-types"

type ScrapeCheckpointModule = typeof import("@/lib/providers/scrape-checkpoint")
type NextdoorExtract = typeof import("@/lib/external/zenrows-client").extractNextdoorPostsFromHtml

export interface NextdoorCheckpoint {
  ledgerClient: { from: (t: string) => any }
  scope: { brokerageId: string | null; marketId: string | null }
  spendGate: (estimateUsd: number) => { allowed: boolean; reason: string }
  tickBudget?: { fetchesLeft: number }
}

export interface NextdoorChatterResult {
  records: NormalizedScrapedRecord[]
  posts: Array<Record<string, any>>
  /** The HTML of every CHANGED page (empty when the snapshot was unchanged or held). */
  html: string[]
  cost: number
  provider: "zenrows" | "zyte" | null
  /** A hold / refusal named by the checkpoint (LICENSE_REQUIRED, robots, budget, backoff …); null when fetched or quietly unchanged. */
  held: string | null
  commit: (ok: boolean) => Promise<{ persisted: boolean; error: string | null }>
}

export async function sourceNextdoorChatter(
  url: string,
  checkpoint: NextdoorCheckpoint | undefined,
  opts: {
    /** Post → Raw Lead record (the cron passes normalizeNextdoorPost with the territory's resolved keywords). */
    normalize?: (post: Record<string, any>) => NormalizedScrapedRecord | null
    keywords?: string[]
    /** A caller that parses the HTML itself pays for no extraction pass. */
    skipExtract?: boolean
    extract?: NextdoorExtract
    /** Proof seams for the checkpoint (fetcher, robots, store, agreements, now) — production passes none. */
    snapshotDeps?: Parameters<ScrapeCheckpointModule["fetchCheckpointedSnapshot"]>[1]
  } = {},
): Promise<NextdoorChatterResult> {
  const noCommit = async () => ({ persisted: false, error: "nothing to commit" })
  if (!checkpoint) return { records: [], posts: [], html: [], cost: 0, provider: null, held: "no snapshot checkpoint supplied — Nextdoor fetched nothing", commit: noCommit }
  const { fetchCheckpointedSnapshot } = await import("@/lib/providers/scrape-checkpoint")
  const snap = await fetchCheckpointedSnapshot(
    { url, scope: { ...checkpoint.scope, purpose: "real_estate_need_chatter", lane: "nextdoor_chatter" }, jsRender: true, premiumProxy: true, maxPages: 1 },
    { ledgerClient: checkpoint.ledgerClient, spendGate: checkpoint.spendGate, tickBudget: checkpoint.tickBudget, ...(opts.snapshotDeps ?? {}) },
  )
  if (snap.status !== "fetched_changed") {
    const quiet = snap.status === "unchanged" || snap.status === "not_modified" || snap.status === "skipped_interval"
    return { records: [], posts: [], html: [], cost: snap.costUsd, provider: snap.provider, held: quiet ? null : `${snap.status} — ${snap.reason}`, commit: noCommit }
  }
  const posts: Array<Record<string, any>> = []
  if (!opts.skipExtract) {
    const extract = opts.extract ?? (await import("@/lib/external/zenrows-client")).extractNextdoorPostsFromHtml
    for (const html of snap.html) {
      const r = await extract(html, { keywords: opts.keywords, sourceUrl: url })
      if (r.error) console.warn("[nextdoor-chatter] extraction:", r.error)
      posts.push(...(r.posts as unknown as Array<Record<string, any>>))
    }
  }
  const parsed = opts.normalize ? posts.map((p) => opts.normalize!(p)).filter((r): r is NormalizedScrapedRecord => !!r) : []
  const fresh = snap.selectNew(parsed).records
  return {
    records: fresh, posts, html: snap.html, cost: snap.costUsd, provider: snap.provider, held: null,
    commit: (ok: boolean) => snap.commit({ ok, forwarded: ok ? fresh : [] }),
  }
}
