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
  postcards: { create: (params: Record<string, unknown>, headers?: Record<string, string>) => Promise<unknown> }
  letters: { create: (params: Record<string, unknown>, headers?: Record<string, string>) => Promise<unknown> }
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

// ─── PROOF / PREVIEW (wave 150, lane 150R — owner ruling R5, contract C40) ─────────────────────────
// A Lob TEST key renders the piece — "a digital proof and thumbnails will be rendered, but the mail piece
// will not actually be printed and mailed", and the test environment carries no charge (help.lob.com
// account-management/api-keys, read 2026-11-06). So the preview is a real Lob render of the GLOBAL format
// template with THIS tenant's merge variables, at zero spend. STRUCTURALLY no live spend: a key that does
// not start with "test_" is refused before the SDK is touched, so a misconfigured live key can never turn
// a preview into a mailed, charged piece. The env NAME is LOB_TEST_API_KEY (no value in code).

export interface LobProofParams {
  pieceType: "letter" | "postcard"
  to: { name: string; address_line1: string; address_line2?: string; address_city: string; address_state: string; address_zip: string; address_country?: string }
  /** Inline return address (the tenant's), or a saved Lob address id. */
  from?: Record<string, string> | string
  /** Letter: the document template id. Postcard: the FRONT template id. */
  templateId: string
  /** Postcard: the BACK template id — must differ from the front. */
  backTemplateId?: string
  mergeVariables: Record<string, string>
  color?: boolean
  size?: string
}

export interface LobProofData {
  id: string | null
  /** The signed proof PDF URL Lob rendered. */
  url: string | null
  thumbnails: string[]
  expectedDeliveryDate: string | null
}

export async function createLobProof(testApiKey: string, params: LobProofParams): Promise<AdapterResult<LobProofData>> {
  if (!testApiKey) return { ok: false, status: null, data: null, error: "unconfigured: no Lob test API key (LOB_TEST_API_KEY)" }
  if (!testApiKey.startsWith("test_")) {
    return { ok: false, status: null, data: null, error: "refused: a proof is rendered only with a Lob TEST key (test_…) — a live key would print, mail and charge" }
  }
  if (params.pieceType === "postcard" && (!params.backTemplateId || params.backTemplateId === params.templateId)) {
    return { ok: false, status: null, data: null, error: "refused: a postcard proof needs a back template distinct from its front" }
  }
  try {
    const c = client(testApiKey)
    const common = { to: { address_country: "US", ...params.to }, ...(params.from ? { from: params.from } : {}), merge_variables: params.mergeVariables }
    const raw = params.pieceType === "postcard"
      ? await c.postcards.create({ ...common, front: params.templateId, back: params.backTemplateId, size: params.size ?? "4x6" })
      : await c.letters.create({ ...common, file: params.templateId, color: params.color ?? false })
    const d = (raw ?? {}) as { id?: string; url?: string; thumbnails?: Array<Record<string, string>>; expected_delivery_date?: string }
    const thumbnails = (d.thumbnails ?? []).map((t) => t.large ?? t.medium ?? t.small ?? "").filter(Boolean)
    return { ok: true, status: 200, data: { id: d.id ?? null, url: d.url ?? null, thumbnails, expectedDeliveryDate: d.expected_delivery_date ?? null }, error: null }
  } catch (err) {
    return mapError(err)
  }
}
