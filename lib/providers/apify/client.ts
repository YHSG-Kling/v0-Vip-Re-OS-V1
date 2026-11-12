// lib/providers/apify/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE APIFY SERVER ADAPTER (wave 70B, owner ruling: "if there is an sdk
// option, we should use that... keeping pricing in mind"). Apify's official
// Node SDK is `apify-client` (not previously installed —
// lib/external/apify-client.ts::runApifyActor hand-built the "run-sync-get-
// dataset-items" REST shortcut through the connector gateway). The SDK does
// not change price (Apify bills by actor compute-unit usage, not by request
// shape) — it removes the hand-built polling/dataset-id resolution.
//
// SHAPE NOTE. The REST shortcut endpoint
// (`/v2/acts/{id}/run-sync-get-dataset-items`) is one HTTP round trip; the SDK
// idiom is `actor(id).call(input)` (blocks until the run finishes, same as the
// shortcut) followed by `dataset(run.defaultDatasetId).listItems()` — two
// round trips instead of one. This does not change what is billed (Apify
// meters actor compute-unit usage, not API call count for this pattern) or
// what the caller receives (the same dataset items array), only how many
// internal HTTP calls produce it.

// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches (e.g. lib/external/apify-client.ts from
// lib/platform/provider-posture.ts's chain) would crash that proof for a
// directive with no live client-bundling risk to guard against here.
import { ApifyClient } from "apify-client"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
  /**
   * WAVE 152 (152J — convergence row 55): THE RUN CURSOR. Present whenever an Actor run STARTED (and is therefore billed
   * by Apify's compute-unit meter), whether or not its dataset was read to the end. `offset` is how many dataset items
   * this read consumed; `finished` is whether the run had reached a terminal status when it was read. A caller that
   * gets `finished: false` (the 60 s client-side wait ended while the Actor kept running — `actor.call({ waitSecs })`
   * returns the run in whatever state it is in) or `ok: false` WITH a cursor must not start a second paid run for the
   * same work; it resumes this dataset from `offset` (resumeRunDataset) instead.
   */
  run?: ApifyRunCursor
}

/** A started Actor run's dataset position. Documented API: GET /v2/actor-runs/{runId} (status, defaultDatasetId) and
 *  GET /v2/datasets/{datasetId}/items?offset=&limit= (docs.apify.com/api/v2 — dataset items, "offset" / "limit"). */
export interface ApifyRunCursor {
  runId: string
  datasetId: string
  /** Items consumed so far (the next read starts here). */
  offset: number
  /** The run's status at the read (READY / RUNNING / SUCCEEDED / FAILED / TIMING-OUT / TIMED-OUT / ABORTING / ABORTED). */
  runStatus: string
  /** The run had reached a terminal status, so the dataset will not grow. */
  finished: boolean
}

/** The slice of the official SDK this adapter uses — the proof (scripts/scraper-simulator.ts) injects one. */
interface ApifySdkLike {
  actor(id: string): { call(input: Record<string, unknown>, opts?: { waitSecs?: number }): Promise<{ id: string; status: string; defaultDatasetId: string }>; get(): Promise<unknown> }
  dataset(id: string): { listItems(opts?: { offset?: number; limit?: number }): Promise<{ items: unknown[]; total?: number }> }
  run(id: string): { get(): Promise<{ id: string; status: string; defaultDatasetId: string } | undefined | null> }
}

/** Apify's terminal run statuses (a run in one of these will not add dataset items). */
const TERMINAL_RUN_STATUSES = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"])
/** Items per dataset page (the API caps a page; reading in pages makes a mid-read failure resumable at the last page). */
const DATASET_PAGE = 1000

const clients = new Map<string, ApifyClient>()
function client(token: string): ApifyClient {
  let c = clients.get(token)
  if (!c) {
    c = new ApifyClient({ token })
    clients.set(token, c)
  }
  return c
}

/** Read a run's dataset from `offset` in pages until a short page; a page that fails returns what was read + the cursor. */
async function readRunDataset(
  sdk: ApifySdkLike,
  run: { id: string; status: string; defaultDatasetId: string },
  offset: number,
): Promise<{ items: unknown[]; cursor: ApifyRunCursor; error: string | null }> {
  const items: unknown[] = []
  let at = offset
  const cursorAt = (): ApifyRunCursor => ({ runId: run.id, datasetId: run.defaultDatasetId, offset: at, runStatus: run.status, finished: TERMINAL_RUN_STATUSES.has(run.status) })
  for (;;) {
    let page: { items: unknown[]; total?: number }
    try {
      page = await sdk.dataset(run.defaultDatasetId).listItems({ offset: at, limit: DATASET_PAGE })
    } catch (err) {
      return { items, cursor: cursorAt(), error: (err as { message?: string })?.message ?? "Apify dataset read failed" }
    }
    const got = Array.isArray(page?.items) ? page.items : []
    items.push(...got)
    at += got.length
    if (got.length < DATASET_PAGE) break
    if (typeof page.total === "number" && at >= page.total) break
  }
  return { items, cursor: cursorAt(), error: null }
}

function mapError(err: unknown): AdapterResult<any> {
  const e = err as { statusCode?: number; message?: string }
  return {
    ok: false,
    status: typeof e?.statusCode === "number" ? e.statusCode : null,
    data: null,
    error: e?.message ?? "Apify request failed",
  }
}

/** Does an Actor still exist? `GET /v2/acts/{id}` via the SDK — used by the
 *  actor-health cron (lib/external/apify-actors.ts::checkActorExists) to skip
 *  dead candidates before spending a failed run. */
export async function actorExists(token: string, actorId: string): Promise<boolean> {
  try {
    const actor = await client(token).actor(actorId.replace("~", "/")).get()
    return actor != null
  } catch {
    return false
  }
}

/** Run an Actor synchronously and return its default dataset's items — the
 *  SDK equivalent of `POST /v2/acts/{id}/run-sync-get-dataset-items`. `actorId`
 *  accepts either spelling ("owner/name" or "owner~name"); the SDK normalizes
 *  it the same way the REST path segment did. */
export async function runActorSyncGetDatasetItems(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  opts?: { timeoutSecs?: number; sdk?: ApifySdkLike },
): Promise<AdapterResult<any[]>> {
  // FAIL CLOSED: no token means no network call at all — the proxy would
  // otherwise refuse the host and the refusal would read as a provider error.
  if (!token) return { ok: false, status: null, data: null, error: "unconfigured: no Apify token" }
  const sdk: ApifySdkLike = opts?.sdk ?? (client(token) as unknown as ApifySdkLike)
  let run: { id: string; status: string; defaultDatasetId: string }
  try {
    const normalizedId = actorId.replace("~", "/")
    // waitSecs is the client-side poll-wait cap (mirrors the old 60s
    // request timeout on the run-sync REST shortcut) — NOT the Actor's own
    // run timeout (ActorStartOptions.timeout), which is a different knob.
    // When it elapses the SDK returns the run AS IT IS (often RUNNING): the
    // Actor keeps going and keeps billing. That is why the dataset is read
    // in pages and the result carries a cursor (row 55) instead of treating
    // whatever was in the dataset at second 60 as the whole answer.
    run = await sdk.actor(normalizedId).call(input, { waitSecs: opts?.timeoutSecs })
  } catch (err) {
    // The run did not start (a removed Actor, a refused token): no cursor, the caller may try another candidate.
    return mapError(err)
  }
  const read = await readRunDataset(sdk, run, 0)
  if (read.error) return { ok: false, status: null, data: read.items, error: read.error, run: read.cursor }
  return { ok: true, status: 200, data: read.items, error: null, run: read.cursor }
}

/**
 * RESUME a started run's dataset from its cursor — no new Actor run, no new compute charge (a dataset read is storage
 * access, not a run). Re-reads the run's CURRENT status first (GET /v2/actor-runs/{runId}), so a run that was still
 * RUNNING at the last read reports whether it has finished since. Unnamed run datasets are retained for a limited time
 * (Apify's data-retention rule for unnamed storages); a vanished run or dataset comes back as ok:false with the cursor
 * unchanged — the caller retires it.
 */
export async function resumeRunDataset(
  token: string,
  cursor: ApifyRunCursor,
  opts?: { sdk?: ApifySdkLike },
): Promise<AdapterResult<any[]>> {
  if (!token) return { ok: false, status: null, data: null, error: "unconfigured: no Apify token", run: cursor }
  const sdk: ApifySdkLike = opts?.sdk ?? (client(token) as unknown as ApifySdkLike)
  let run: { id: string; status: string; defaultDatasetId: string } | null | undefined
  try {
    run = await sdk.run(cursor.runId).get()
  } catch (err) {
    return { ...mapError(err), run: cursor }
  }
  if (!run) return { ok: false, status: 404, data: null, error: "the Apify run is no longer available", run: cursor }
  const read = await readRunDataset(sdk, { id: run.id, status: run.status, defaultDatasetId: run.defaultDatasetId || cursor.datasetId }, cursor.offset)
  if (read.error) return { ok: false, status: null, data: read.items, error: read.error, run: read.cursor }
  return { ok: true, status: 200, data: read.items, error: null, run: read.cursor }
}
