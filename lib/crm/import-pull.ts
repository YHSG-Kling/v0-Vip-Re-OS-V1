// lib/crm/import-pull.ts
// ─────────────────────────────────────────────────────────────────────────────
// CRM IMPORT — the INBOUND direction (sync-out existed; migration didn't).
// DESIGN RULE (the owner's line): imported data NEVER bypasses the gate. These
// fetchers pull from the tenant's old CRM (Follow Up Boss / Lofty /
// GoHighLevel) and emit rows shaped EXACTLY like that vendor's CSV export —
// the same keys IMPORT_FIELD_ALIASES already matches — then the ONE gated
// pipeline (processImportRows → field steward → Data Steward enum normalizer →
// captureContact) decides what lands: name/email/phone/address onto the
// contact, everything unrecognized routed to NOTES, consent flags NEVER
// imported as true (a vendor's "opted in" claim is not our proof — TCPA
// consent is earned on OUR rail). The AI managers' automations stay clean.
//
// All egress via the connector gateway; per-tenant credentials from
// platform_credentials; every fetcher returns { rows, nextCursor } so runs are
// resumable and honestly report "more remain".
//
// TOMBSTONE (wave 72A, owner ruling verbatim: "hubspot is only sync out to
// hubspot."): HubSpot is NOT a member of this inbound-pull set. There was a
// `pullHubSpot` fetcher (+ `hubspotToRow` mapper) here that called
// lib/providers/hubspot/client.ts::listContactsPage — both retired. Survivor:
// lib/crm/providers/hubspot.ts:25 (`syncContactToHubSpot`, sync-OUT only,
// via the same adapter's `upsertContactByEmail` / `createContact`).

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type CrmImportProvider = "followupboss" | "lofty" | "gohighlevel"
export const CRM_IMPORT_PROVIDERS: CrmImportProvider[] = ["followupboss", "lofty", "gohighlevel"]

export interface CrmPullPage {
  rows: Record<string, unknown>[]
  nextCursor: string | null
  error?: string
}

const PAGE_SIZE = 100

// ── PURE mappers: vendor record → CSV-export-shaped row ──────────────────────
// THE EXPLICIT MAPPING (wave 141, lane 141D; owner: "External schemas never
// write canonical fields directly"). Every key a mapper emits is a CSV-export
// spelling the ONE parser (lib/platform/tenant-import-parser.ts) resolves onto
// a field of the ONE registry (lib/kernel/schema-adaptation.ts
// CRM_CONTACT_INGRESS_CONTRACT). Vendor-specific context — a stage, a lead type,
// anything that is a VENDOR enum — is never offered under a canonical enum key:
// it is written as TEXT into `Notes` ("<Vendor> stage: X"), where the human and
// the Data Steward can read it and nothing downstream trusts it as a vocabulary.
// The old CRM's own `source` label rides `Source` (→ contacts.source_subtype,
// preserved as-is); tags ride `Tags` (the one segmentation that maps 1:1).
//
// TOMBSTONE (141D): the vendor-keyed context ("FUB Source", "FUB Tags",
// "Lofty Stage", "Lofty Tags", "GHL Tags") and the bare `Type` key are gone.
// They were written for the retired processImportRows path, whose field steward
// routed unknown keys to notes; on the survivor pipeline (importParsedContacts)
// an unknown key is DROPPED and only surfaced as `unmappedHeaders`, so every
// migrated book silently lost its tags and stages. `Notes`/`Tags`/`Source` are
// the keys the parser actually lands. scripts/crm-boundaries-guard.ts proves
// every mapper key resolves (zero unmapped) and that a vendor-keyed row does not.

/** PURE: vendor context lines → one Notes text (empty values dropped, "" when nothing). */
function vendorNotes(vendor: string, pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== "")
    .map(([k, v]) => `${vendor} ${k}: ${String(v).trim()}`)
    .join("\n")
}

export function fubToRow(p: any): Record<string, unknown> {
  return {
    "First Name": p.firstName ?? "",
    "Last Name": p.lastName ?? "",
    Email: p.emails?.[0]?.value ?? "",
    Phone: p.phones?.[0]?.value ?? "",
    Address: p.addresses?.[0]?.street ?? "",
    City: p.addresses?.[0]?.city ?? "",
    State: p.addresses?.[0]?.state ?? "",
    Zip: p.addresses?.[0]?.code ?? "",
    // The old CRM's own source label → contacts.source_subtype (preserved, never trusted as ours).
    Source: p.source ?? "",
    Tags: Array.isArray(p.tags) ? p.tags.join(", ") : "",
    // A vendor STAGE is a vendor enum: text in notes, never a canonical status/type.
    Notes: vendorNotes("Follow Up Boss", [["stage", p.stage]]),
  }
}

export function loftyToRow(c: any): Record<string, unknown> {
  return {
    "First Name": c.firstName ?? c.first_name ?? "",
    "Last Name": c.lastName ?? c.last_name ?? "",
    Email: c.email ?? c.emails?.[0] ?? "",
    Phone: c.phone ?? c.phones?.[0] ?? "",
    Address: c.address ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.zipCode ?? c.zip ?? "",
    Source: c.source ?? "",
    Tags: Array.isArray(c.tags) ? c.tags.join(", ") : "",
    Notes: vendorNotes("Lofty", [["lead type", c.leadType ?? c.type], ["stage", c.stage]]),
  }
}

export function ghlToRow(c: any): Record<string, unknown> {
  return {
    "First Name": c.firstName ?? "",
    "Last Name": c.lastName ?? "",
    Email: c.email ?? "",
    Phone: c.phone ?? "",
    Address: c.address1 ?? "",
    City: c.city ?? "",
    State: c.state ?? "",
    Zip: c.postalCode ?? "",
    Source: c.source ?? "",
    Tags: Array.isArray(c.tags) ? c.tags.join(", ") : "",
    Notes: vendorNotes("GoHighLevel", [["type", c.type]]),
  }
}

/**
 * PURE — the CONTROLLED-COMMIT token (wave 141, lane 141D). A run may land rows only when it
 * carries the token the PREVIEW handed back for the same target tenant, the same provider and the
 * same explicit mapping (header → canonical) + ignored keys. The run recomputes it from the first
 * page it pulls, so what was previewed is provably what lands; a mapper or vendor change between
 * preview and import makes the token miss and the run refuses before touching a row. Not a
 * secret (no HMAC): it binds the commit to a preview, it does not authenticate the caller — the
 * staff gate does that.
 */
export function crmImportPreviewToken(input: {
  provider: CrmImportProvider
  brokerageId: string
  mapping: Record<string, string>
  ignoredKeys: string[]
}): string {
  const lines = [
    `provider=${input.provider}`,
    `brokerage=${input.brokerageId}`,
    ...Object.entries(input.mapping).map(([k, v]) => `map:${k}=${v}`).sort(),
    ...[...input.ignoredKeys].map((k) => `ignore:${k}`).sort(),
  ]
  // FNV-1a 64-bit over the canonical line list — deterministic, dependency-free, client-safe.
  let h = 0xcbf29ce484222325n
  for (const ch of lines.join("\n")) {
    h ^= BigInt(ch.codePointAt(0) ?? 0)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return `pv1-${h.toString(16).padStart(16, "0")}`
}

// ── Fetchers (one page each; cursor-resumable) ────────────────────────────────

// internal helper — called in-file by pullCrmPage
async function pullFollowUpBoss(apiKey: string, cursor: string | null): Promise<CrmPullPage> {
  const offset = Number(cursor ?? 0)
  const res = await callConnector<{ people?: any[] }>({
    connector: "followupboss", baseUrl: "https://api.followupboss.com/v1",
    path: "people", method: "GET",
    query: { limit: String(PAGE_SIZE), offset: String(offset) },
    auth: { style: "basic", username: apiKey, password: "" },
  })
  if (!res.ok) return { rows: [], nextCursor: null, error: res.error ?? `FUB pull failed (${res.status})` }
  const people = res.data?.people ?? []
  return { rows: people.map(fubToRow), nextCursor: people.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null }
}

// internal helper — called in-file by pullCrmPage
async function pullLofty(apiKey: string, baseUrl: string | null, cursor: string | null): Promise<CrmPullPage> {
  const offset = Number(cursor ?? 0)
  // Wave 140 (140I): the verified contract — GET {base}/leads with `Authorization: token <key>`, envelope
  // { code, msg, data: { total, list } } (developer.lofty.com/quickstart) — ONE base URL (LOFTY_API_BASE).
  const { LOFTY_API_BASE, loftyAuth } = await import("@/lib/crm/providers/lofty")
  const res = await callConnector<{ data?: { list?: any[] } | any[]; list?: any[] }>({
    connector: "lofty", baseUrl: baseUrl || LOFTY_API_BASE,
    path: "leads", method: "GET",
    query: { limit: String(PAGE_SIZE), offset: String(offset) },
    auth: loftyAuth(apiKey),
  })
  if (!res.ok) return { rows: [], nextCursor: null, error: res.error ?? `Lofty pull failed (${res.status})` }
  const envelope = res.data?.data
  const contacts: any[] = Array.isArray(envelope) ? envelope : envelope?.list ?? res.data?.list ?? []
  return { rows: contacts.map(loftyToRow), nextCursor: contacts.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null }
}

// internal helper — called in-file by pullCrmPage
async function pullGoHighLevel(apiKey: string, locationId: string | null, cursor: string | null): Promise<CrmPullPage> {
  const res = await callConnector<{ contacts?: any[]; meta?: { nextPageUrl?: string; startAfterId?: string } }>({
    connector: "ghl", baseUrl: "https://rest.gohighlevel.com/v1",
    path: "/contacts/", method: "GET",
    query: {
      limit: String(PAGE_SIZE),
      ...(locationId ? { locationId } : {}),
      ...(cursor ? { startAfterId: cursor } : {}),
    },
    auth: { style: "bearer", token: apiKey },
  })
  if (!res.ok) return { rows: [], nextCursor: null, error: res.error ?? `GoHighLevel pull failed (${res.status})` }
  const contacts = res.data?.contacts ?? []
  const last = contacts[contacts.length - 1]
  return { rows: contacts.map(ghlToRow), nextCursor: contacts.length === PAGE_SIZE && last?.id ? String(last.id) : null }
}

/** One page from any provider — the single dispatch the action layer uses. */
export async function pullCrmPage(
  provider: CrmImportProvider,
  cred: { apiKey: string; apiUrl?: string | null; locationId?: string | null },
  cursor: string | null,
): Promise<CrmPullPage> {
  switch (provider) {
    case "followupboss": return pullFollowUpBoss(cred.apiKey, cursor)
    case "lofty": return pullLofty(cred.apiKey, cred.apiUrl ?? null, cursor)
    case "gohighlevel": return pullGoHighLevel(cred.apiKey, cred.locationId ?? null, cursor)
  }
}
