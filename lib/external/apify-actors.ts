// lib/external/apify-actors.ts
// Apify actor RESILIENCE. Public actors come and go; a single hard-coded actor
// id is a single point of failure. Each logical scrape task has an ordered list
// of candidate actors (primary + fallbacks). runApifyTask tries them in order and
// returns the first success; if a candidate is gone (404) or errors, it moves to
// the next; if all fail it returns empty (graceful — the cron keeps running other
// sources). The actor-health cron probes each candidate and records which are
// alive so dead ones are skipped (no wasted failed-run cost). When no Apify actor
// works, the caller falls back to ZenRows where the data type allows.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type ApifyTask = "reddit" | "facebook" | "instagram" | "craigslist" | "google" | "linkedin"

/**
 * Ordered candidate actors per task — primary first. Multiple public actors
 * exist for each source; if one is removed we try the next. Keep primaries
 * cost-effective; fallbacks are alternates that accept compatible input.
 *
 * RE-VERIFIED 2026-09-15 (wave 65, Exa research — see
 * docs/lead-acquisition-coverage-2026-09.md for citations + pricing). Reddit's own
 * logged-out search.json API is reported hard-blocked (403) as of mid-2026, which is why a
 * dedicated Reddit SEARCH actor (clearpath) now leads that list ahead of the older
 * subreddit-listing-style trudax actor. The LinkedIn "no-cookies" slug below is the real,
 * currently-live actor id — the old entry (missing the "-no-cookies" suffix) was never
 * confirmed live and is kept only as an unverified last resort.
 */
export const ACTOR_REGISTRY: Record<ApifyTask, string[]> = {
  reddit:     ["clearpath/reddit-search-scraper", "harshmaur/reddit-search-scraper", "trudax/reddit-scraper", "trudax/reddit-scraper-lite", "oxylabs/reddit-scraper"],
  facebook:   ["memo23/facebook-public-group-posts-scraper", "scrapier/facebook-groups-posts-scraper", "logical_scrapers/facebook-group-posts-scraper", "apify/facebook-posts-scraper", "apify/facebook-pages-scraper"],
  instagram:  ["apify/instagram-hashtag-scraper", "apidojo/instagram-hashtag-scraper", "apify/instagram-scraper", "apify/instagram-search-scraper"],
  craigslist: ["solidcode/craigslist-scraper", "epctex/craigslist-scraper", "ivanvs/craigslist-scraper", "lukaskrivka/craigslist-scraper"],
  google:     ["apify/google-search-scraper", "scraping-fish/google-search-results-scraper"],
  linkedin:   ["apimaestro/linkedin-posts-search-scraper-no-cookies", "harvestapi/linkedin-post-search", "curious_coder/linkedin-post-search-scraper", "apimaestro/linkedin-posts-search-scraper"],
}

export type ActorRunner = (actorId: string, input: Record<string, any>) => Promise<{ data: any[]; cost: number }>

export interface ApifyTaskResult {
  data: any[]
  cost: number
  actorUsed: string | null
  triedActors: string[]
}

/**
 * Pure: ordered candidates for a task, with known-dead actors removed.
 * healthMap maps actorId -> alive. Unknown actors are kept (try them).
 */
export function pickActors(task: ApifyTask, healthMap?: Record<string, boolean>): string[] {
  const candidates = ACTOR_REGISTRY[task] ?? []
  if (!healthMap) return [...candidates]
  const alive = candidates.filter((id) => healthMap[id] !== false)
  // If health knocked everything out, still try the primary (health may be stale).
  return alive.length > 0 ? alive : candidates.slice(0, 1)
}

/**
 * Run a task across its candidate actors, returning the first success. Tries the
 * next candidate on any error (incl. a removed/404 actor). Never throws.
 * @param opts.runner injectable for tests; defaults to the real Apify runner.
 */
export async function runApifyTask(
  task: ApifyTask,
  input: Record<string, any>,
  opts?: { runner?: ActorRunner; healthMap?: Record<string, boolean> },
): Promise<ApifyTaskResult> {
  const runner = opts?.runner ?? ((await import("./apify-client")).runApifyActor as ActorRunner)
  const candidates = pickActors(task, opts?.healthMap)
  const tried: string[] = []
  for (const actorId of candidates) {
    tried.push(actorId)
    try {
      const r = await runner(actorId, input)
      return { data: r.data ?? [], cost: r.cost ?? 0, actorUsed: actorId, triedActors: tried }
    } catch (err) {
      console.warn(`[ApifyTask:${task}] actor ${actorId} failed, trying next:`, err instanceof Error ? err.message : String(err))
    }
  }
  return { data: [], cost: 0, actorUsed: null, triedActors: tried }
}

/** Does an Apify actor still exist? Real GET against the Apify API. */
export async function checkActorExists(actorId: string): Promise<boolean> {
  const token = process.env.APIFY_API_TOKEN
  if (!token) return false
  const res = await callConnector({
    connector: "apify", baseUrl: "https://api.apify.com",
    path: `/v2/acts/${actorId.replace("/", "~")}`, method: "GET",
    auth: { style: "bearer", token },
  })
  return res.ok
}
