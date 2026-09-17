// lib/providers/hubspot/client.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE HUBSPOT SERVER ADAPTER (wave 71A, owner ruling: "for any of our
// providers for platform, if there is an sdk option, we should use that…
// keeping pricing in mind"). HubSpot's official Node SDK is
// `@hubspot/api-client` (not previously installed — lib/crm/providers/
// hubspot.ts and lib/crm/import-pull.ts hand-built both CRM contact calls
// through the connector gateway). The SDK does not change per-call price
// (same v3 CRM endpoints, same per-tenant private-app token) — it removes the
// hand-built batch-upsert / paging request shapes.
//
// Credential is TENANT-scoped (the brokerage's own HubSpot private-app access
// token, resolved by the caller — this adapter never resolves it itself, same
// as the pre-migration callConnector call sites).
//
// NOT import "server-only" — every caller of this adapter is itself a server
// action / API route / cron-only lib file (never a client component), and this
// repo's proof scripts (scripts/*.ts) load modules directly via tsx outside
// Next's webpack build, where "server-only" throws unconditionally rather than
// only-when-client-bundled (see lib/providers/apify/client.ts for the fuller
// version of this note).
import { Client } from "@hubspot/api-client"

export interface AdapterResult<T> {
  ok: boolean
  status: number | null
  data: T | null
  error: string | null
}

// NO per-token cache: every caller hands a DIFFERENT tenant's private-app
// token (this is a per-brokerage BYO credential, never the platform's own),
// so caching by token would only grow a Map across many tenants for no
// benefit — Client construction does no network I/O.
function client(accessToken: string): Client {
  return new Client({ accessToken })
}

function mapError(err: unknown): AdapterResult<any> {
  // @hubspot/api-client's HTTP errors carry { code, body, headers, message }
  // (verified live: a rejected call from this SDK surfaces exactly these keys).
  const e = err as { code?: number; body?: unknown; message?: string }
  const bodyStr = typeof e?.body === "string" ? e.body : e?.body ? JSON.stringify(e.body) : ""
  return {
    ok: false,
    status: typeof e?.code === "number" ? e.code : null,
    data: null,
    error: bodyStr || e?.message || "HubSpot request failed",
  }
}

export interface UpsertContactData {
  id?: string
}

/** `POST /crm/v3/objects/contacts/batch/upsert` (idProperty=email) — the SDK
 *  equivalent of the batch-upsert call syncContactToHubSpot used for a contact
 *  WITH an email. */
export async function upsertContactByEmail(
  accessToken: string,
  email: string,
  properties: Record<string, string>,
): Promise<AdapterResult<{ results?: UpsertContactData[] }>> {
  if (!accessToken) return { ok: false, status: null, data: null, error: "unconfigured: no HubSpot access token" }
  try {
    const res = await client(accessToken).crm.contacts.batchApi.upsert({
      inputs: [{ idProperty: "email", id: email, properties }],
    })
    return { ok: true, status: 200, data: res as unknown as { results?: UpsertContactData[] }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

/** `POST /crm/v3/objects/contacts` — the SDK equivalent of the plain-create
 *  call syncContactToHubSpot used for a contact WITHOUT an email. */
export async function createContact(
  accessToken: string,
  properties: Record<string, string>,
): Promise<AdapterResult<{ id?: string }>> {
  if (!accessToken) return { ok: false, status: null, data: null, error: "unconfigured: no HubSpot access token" }
  try {
    const res = await client(accessToken).crm.contacts.basicApi.create({ properties, associations: [] })
    return { ok: true, status: 201, data: { id: res.id }, error: null }
  } catch (err) {
    return mapError(err)
  }
}

export interface ContactPage {
  results: Array<{ properties?: Record<string, string | null> }>
  paging?: { next?: { after?: string } }
}

/** `GET /crm/v3/objects/contacts` (paged) — the SDK equivalent of the import
 *  puller's pullHubSpot page fetch. `properties` matches the exact field list
 *  the caller already reads (firstname/lastname/email/phone/mobilephone/
 *  address/city/state/zip/lifecyclestage). */
export async function listContactsPage(
  accessToken: string,
  opts: { limit: number; after?: string | null; properties: string[] },
): Promise<AdapterResult<ContactPage>> {
  if (!accessToken) return { ok: false, status: null, data: null, error: "unconfigured: no HubSpot access token" }
  try {
    const res = await client(accessToken).crm.contacts.basicApi.getPage(
      opts.limit,
      opts.after ?? undefined,
      opts.properties,
    )
    return { ok: true, status: 200, data: res as unknown as ContactPage, error: null }
  } catch (err) {
    return mapError(err)
  }
}
