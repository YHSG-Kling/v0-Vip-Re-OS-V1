import "server-only"
/**
 * lib/lead-pipeline/scraping-job-ledger.ts — the per-market scrape JOB ledger
 * (`lead_scraping_jobs`) written by the lead-scraping cron and read by the admin
 * markets page's recent-jobs panel (app/actions/lead-scraping-config.ts::getScrapingJobs).
 *
 * ── WHY THIS MOVED OUT OF A "use server" FILE (lane 88F, census round 33) ────
 * The cron called `createScrapingJob` / `updateScrapingJob` in
 * app/actions/lead-scraping-config.ts, which built the COOKIE client. A cron has no
 * cookie, so each insert ran with no session: live `lead_scraping_jobs` policies are
 * insert-for-`authenticated` + select/update-for-`is_platform_admin()` (read live,
 * project hrvaqgvukzxfskkcrwbt, 2026-09-28), so the open was refused, `job.job?.id`
 * came back undefined, and every later update matched nothing — the admin panel
 * could only ever be empty (0 rows live). Both doors were also PUBLIC endpoints any
 * signed-in user could call to mint or rewrite job rows. The sessionless census
 * carried them as its two OPEN scraping findings.
 *
 * Survivor shape: a server-only core on the service client the cron hands in (cron
 * auth is verified before it is built). Every refusal is READ — the open returns it,
 * the update COUNTS its row (§3: an update that matches nothing resolves exactly like
 * one that worked) and logs a refusal naming the job.
 */

type Svc = { from: (table: string) => any }

export interface ScrapingJobOpen {
  job_type: string
  market_id: string
  source: string
  /** The territory's brokerage (NULL for a platform-owned market). */
  brokerage_id: string | null
}

export type ScrapingJobUpdate = Partial<{
  status: string
  leads_found: number
  leads_created: number
  error_message: string
  started_at: string
  completed_at: string
}>

/** Open one job row at 'pending'. The refusal comes back to the caller, never a fabricated id. */
export async function openScrapingJob(
  svc: Svc,
  job: ScrapingJobOpen,
): Promise<{ success: boolean; job: { id: string } | null; error?: string }> {
  const { data, error } = await svc
    .from("lead_scraping_jobs")
    .insert({ ...job, status: "pending" })
    .select("id")
    .single()
  if (error || !data) {
    const message = error?.message ?? "no row returned"
    console.error(`[scraping-job-ledger] lead_scraping_jobs open refused (${job.source}, market ${job.market_id}):`, message)
    return { success: false, job: null, error: message }
  }
  return { success: true, job: { id: (data as { id: string }).id } }
}

/** Advance one job row. A missing id (the open was refused) or a zero-row match is a failure, logged. */
export async function updateScrapingJobRow(
  svc: Svc,
  id: string | null | undefined,
  updates: ScrapingJobUpdate,
): Promise<{ success: boolean; error?: string }> {
  if (!id) return { success: false, error: "no lead_scraping_jobs id — the open was refused" }
  const { data, error } = await svc.from("lead_scraping_jobs").update(updates).eq("id", id).select("id")
  if (error) {
    console.error(`[scraping-job-ledger] lead_scraping_jobs ${id} update refused:`, error.message)
    return { success: false, error: error.message }
  }
  if ((data ?? []).length === 0) {
    console.error(`[scraping-job-ledger] lead_scraping_jobs ${id} update matched no row`)
    return { success: false, error: "no lead_scraping_jobs row matched" }
  }
  return { success: true }
}
