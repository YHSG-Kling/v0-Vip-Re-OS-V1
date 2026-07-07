// lib/crm/import-pull.ts
// ─────────────────────────────────────────────────────────────────────────────
// CRM IMPORT — the INBOUND direction (sync-out existed; migration didn't).
// DESIGN RULE (the owner's line): imported data NEVER bypasses the gate. These
// fetchers pull from the tenant's old CRM (Follow Up Boss / Lofty / HubSpot /
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

import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type CrmImportProvider = "followupboss" | "lofty" | "hubspot" | "gohighlevel"
export const CRM_IMPORT_PROVIDERS: CrmImportProvider[] = ["followupboss", "lofty", "hubspot", "gohighlevel"]

export interface CrmPullPage {
  rows: Record<string, unknown>[]
  nextCursor: string | null
  error?: string
}

const PAGE_SIZE = 100

// ── PURE mappers: vendor record → CSV-export-shaped row ──────────────────────
// Keys deliberately match IMPORT_FIELD_ALIASES; anything else keeps its vendor
// key so the field steward routes it to notes (the gate, not a bypass).

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
    Type: p.stage ?? "",
    // Vendor-specific context → notes via the steward (never onto the contact).
    "FUB Source": p.source ?? "",
    "FUB Tags": Array.isArray(p.tags) ? p.tags.join(", ") : "",
  }
}

export function hubspotToRow(c: any): Record<string, unknown> {
  const p = c.properties ?? {}
  return {
    "First Name": p.firstname ?? "",
    "Last Name": p.lastname ?? "",
    Email: p.email ?? "",
    Phone: p.phone ?? p.mobilephone ?? "",
    Address: p.address ?? "",
    City: p.city ?? "",
    State: p.state ?? "",
    Zip: p.zip ?? "",
    Type: p.lifecyclestage ?? "",
    "HubSpot Owner": p.hubspot_owner_id ?? "",
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
    Type: c.leadType ?? c.type ?? "",
    "Lofty Stage": c.stage ?? "",
    "Lofty Tags": Array.isArray(c.tags) ? c.tags.join(", ") : "",
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
    Type: c.type ?? "",
    "GHL Tags": Array.isArray(c.tags) ? c.tags.join(", ") : "",
  }
}

// ── Fetchers (one page each; cursor-resumable) ────────────────────────────────

export async function pullFollowUpBoss(apiKey: string, cursor: string | null): Promise<CrmPullPage> {
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

export async function pullHubSpot(token: string, cursor: string | null): Promise<CrmPullPage> {
  const res = await callConnector<{ results?: any[]; paging?: { next?: { after?: string } } }>({
    connector: "hubspot", baseUrl: "https://api.hubapi.com",
    path: "/crm/v3/objects/contacts", method: "GET",
    query: {
      limit: String(PAGE_SIZE),
      properties: "firstname,lastname,email,phone,mobilephone,address,city,state,zip,lifecyclestage",
      ...(cursor ? { after: cursor } : {}),
    },
    auth: { style: "bearer", token },
  })
  if (!res.ok) return { rows: [], nextCursor: null, error: res.error ?? `HubSpot pull failed (${res.status})` }
  return { rows: (res.data?.results ?? []).map(hubspotToRow), nextCursor: res.data?.paging?.next?.after ?? null }
}

export async function pullLofty(apiKey: string, baseUrl: string | null, cursor: string | null): Promise<CrmPullPage> {
  const offset = Number(cursor ?? 0)
  const res = await callConnector<{ contacts?: any[]; data?: any[] }>({
    connector: "lofty", baseUrl: baseUrl || "https://api.lofty.com/v1",
    path: "contacts", method: "GET",
    query: { limit: String(PAGE_SIZE), offset: String(offset) },
    auth: { style: "bearer", token: apiKey },
  })
  if (!res.ok) return { rows: [], nextCursor: null, error: res.error ?? `Lofty pull failed (${res.status})` }
  const contacts = res.data?.contacts ?? res.data?.data ?? []
  return { rows: contacts.map(loftyToRow), nextCursor: contacts.length === PAGE_SIZE ? String(offset + PAGE_SIZE) : null }
}

export async function pullGoHighLevel(apiKey: string, locationId: string | null, cursor: string | null): Promise<CrmPullPage> {
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
    case "hubspot": return pullHubSpot(cred.apiKey, cursor)
    case "lofty": return pullLofty(cred.apiKey, cred.apiUrl ?? null, cursor)
    case "gohighlevel": return pullGoHighLevel(cred.apiKey, cred.locationId ?? null, cursor)
  }
}
