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
}

const clients = new Map<string, ApifyClient>()
function client(token: string): ApifyClient {
  let c = clients.get(token)
  if (!c) {
    c = new ApifyClient({ token })
    clients.set(token, c)
  }
  return c
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
  opts?: { timeoutSecs?: number },
): Promise<AdapterResult<any[]>> {
  // FAIL CLOSED: no token means no network call at all — the proxy would
  // otherwise refuse the host and the refusal would read as a provider error.
  if (!token) return { ok: false, status: null, data: null, error: "unconfigured: no Apify token" }
  try {
    const normalizedId = actorId.replace("~", "/")
    // waitSecs is the client-side poll-wait cap (mirrors the old 60s
    // request timeout on the run-sync REST shortcut) — NOT the Actor's own
    // run timeout (ActorStartOptions.timeout), which is a different knob.
    const run = await client(token).actor(normalizedId).call(input, {
      waitSecs: opts?.timeoutSecs,
    })
    const { items } = await client(token).dataset(run.defaultDatasetId).listItems()
    return { ok: true, status: 200, data: items ?? [], error: null }
  } catch (err) {
    return mapError(err)
  }
}
