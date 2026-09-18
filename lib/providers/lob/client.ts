// lib/providers/lob/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE LOB VERIFICATION SERVER ADAPTER (wave 71A, owner ruling: "for any of
// our providers for platform, if there is an sdk option, we should use that…
// keeping pricing in mind"). Lob's official Node SDK, `lob@^6.6.3`, was ALREADY
// in package.json (used by lib/providers/dispatch.ts for postcard/letter
// sends) but UNUSED by lib/external/lob-address-verify.ts, which hand-built
// the us_verifications call through the connector gateway instead. This
// adapter is the missing half: the SAME already-installed SDK, for the
// verification endpoint. No new package installed for Lob this wave.
//
// VERSION NOTE. `lob@^6.6.3`'s own package.json declares `engines: { node:
// ">= 10.0.0" }` (verified via `npm view lob@6.6.3 engines`) — compatible with
// this repo's Node 22 runtime. The lob-node README's "Node.js >= 24.15.0"
// notice describes a LATER major (lob@8.x, verified via `npm view lob
// version` = 8.1.1) that this repo is deliberately NOT on — the task
// instructed keeping the already-installed v6, not upgrading.
//
// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled (see lib/providers/apify/client.ts for the fuller
// version of this note).
// `lob` ships no TypeScript types (no "types" field, no .d.ts anywhere in the
// published tree — verified 2026-09-17) and lib/providers/dispatch.ts already
// established the `require()` idiom for it for exactly that reason. A bare
// `require(...)` is NOT used here, though: this repo's package.json is `"type":
// "module"`, and scripts/*.ts proof scripts load adapters directly via tsx's
// ESM loader, where the global `require` dispatch.ts relies on (present under
// Next's CJS-transpiled server bundle) does not exist — `ReferenceError:
// require is not defined in ES module scope` (caught by test:sdk-rollout-2
// the first time this adapter was proof-run). `createRequire` is Node's own
// ESM-safe equivalent and works in both runtimes.
import { createRequire } from "node:module"
const LobSDK = createRequire(import.meta.url)("lob")

interface LobClient {
  usVerifications: { verify: (params: LobVerifyParams, callback?: (err: unknown, data: unknown) => void) => Promise<unknown> }
}

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// One client per API key (platform-owned — effectively one key for the
// process lifetime, but keyed defensively rather than assuming a singleton;
// same idiom as lib/providers/dispatch.ts's own `LobSDK(lobApiKey)` call).
const clients = new Map<string, LobClient>()
function client(apiKey: string): LobClient {
  let c = clients.get(apiKey)
  if (!c) {
    c = LobSDK(apiKey) as LobClient
    clients.set(apiKey, c)
  }
  return c
}

function mapError(err: unknown): AdapterResult<any> {
  // lob's ResourceBase._transmit rejects with an Error carrying `.status_code`
  // (snake_case — the SDK's own naming, not `.status` or `.statusCode`) and
  // `._response` (the raw axios/request response).
  const e = err as { status_code?: number; message?: string }
  return {
    ok: false,
    status: typeof e?.status_code === "number" ? e.status_code : null,
    data: null,
    error: e?.message ?? "Lob request failed",
  }
}

export interface LobVerifyParams {
  primary_line: string
  secondary_line?: string
  urbanization?: string
  city?: string
  state?: string
  zip_code?: string
  recipient?: string
}

export interface LobVerifyData {
  deliverability?: string
  primary_line?: string
  secondary_line?: string
  last_line?: string
  components?: Record<string, unknown>
}

/** `POST /v1/us_verifications` — the SDK equivalent of the hand-built form
 *  POST verifyAddressViaLob used. `usVerifications.verify(params)` returns a
 *  Promise (the SDK's own callback param is optional). */
export async function verifyUsAddress(apiKey: string, params: LobVerifyParams): Promise<AdapterResult<LobVerifyData>> {
  if (!apiKey) return { ok: false, status: null, data: null, error: "unconfigured: no Lob API key" }
  try {
    const data = await client(apiKey).usVerifications.verify(params)
    return { ok: true, status: 200, data: data as LobVerifyData, error: null }
  } catch (err) {
    return mapError(err)
  }
}
