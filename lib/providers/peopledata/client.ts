// lib/providers/peopledata/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PEOPLE DATA LABS SERVER ADAPTER (wave 71A, owner ruling: "for any of
// our providers for platform, if there is an sdk option, we should use that…
// keeping pricing in mind"). PDL's official Node SDK is `peopledatalabs` (not
// previously installed — lib/external/peopledata-client.ts hand-built both PDL
// calls through the connector gateway). The SDK does not change per-call price
// (same person/enrich billing, same $ per match) — it removes the hand-built
// request/response mapping for the enrichment call.
//
// SCOPE — person/enrich ONLY. `validateEmailViaPeopleData` (GET email/validate)
// has NO SDK method: the installed `peopledatalabs@14.6.0` client exposes
// person.{enrichment,enrichmentPreview,search,identify,retrieve,changelog},
// company.*, school/location.cleaner, autocomplete, jobTitle, jobPosting, ip —
// no `email` namespace at all (confirmed by reading dist/index.cjs — no
// "email" token in the whole bundle). That call site is left on the
// connector-gateway REST path in lib/external/peopledata-client.ts, documented
// there with the same reasoning as this comment.
//
// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled. A static import of this adapter from a file a proof
// script statically reaches would crash that proof for a directive with no live
// client-bundling risk to guard against here (see lib/providers/apify/client.ts
// for the fuller version of this note).
import PDLJS from "peopledatalabs"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// One client per API key (platform-owned — effectively one key for the process
// lifetime, but keyed defensively rather than assuming a singleton).
const clients = new Map<string, InstanceType<typeof PDLJS>>()
function client(apiKey: string): InstanceType<typeof PDLJS> {
  let c = clients.get(apiKey)
  if (!c) {
    c = new PDLJS({ apiKey })
    clients.set(apiKey, c)
  }
  return c
}

function mapError(err: unknown): AdapterResult<any> {
  // The SDK's rejection shape (see dist/index.cjs's `o()` helper): { status, message, rateLimit }.
  const e = err as { status?: number; message?: string }
  return {
    ok: false,
    status: typeof e?.status === "number" ? e.status : null,
    data: null,
    error: e?.message ?? "PeopleDataLabs request failed",
  }
}

export interface PersonEnrichParams {
  name?: string
  phone?: string
  email?: string
  /** PDL's `location` free-text param. */
  location?: string
  minLikelihood?: number
  /** PDL's `required` boolean-expression string, e.g. "emails OR phones". */
  required?: string
}

/** `person.enrichment` — the SDK equivalent of `POST /v5/person/enrich`.
 *  Response shape is the PDL envelope spread with `rateLimit` (status, data,
 *  likelihood, …) — same shape skipTraceWithPeopleData already parses. */
export async function enrichPerson(apiKey: string, params: PersonEnrichParams): Promise<AdapterResult<any>> {
  // FAIL CLOSED: no key means no network call at all — the SDK's own 64-char
  // key-length check would reject an empty string anyway, but this short-circuits
  // before even constructing the client so a proof stubbing global fetch never
  // sees a call for an unconfigured tenant.
  if (!apiKey) return { ok: false, status: null, data: null, error: "unconfigured: no PeopleDataLabs API key" }
  try {
    const data = await client(apiKey).person.enrichment({
      name: params.name,
      phone: params.phone,
      email: params.email,
      location: params.location,
      min_likelihood: params.minLikelihood,
      required: params.required,
    })
    return { ok: true, status: 200, data, error: null }
  } catch (err) {
    return mapError(err)
  }
}
