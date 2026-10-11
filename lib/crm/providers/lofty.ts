// lib/crm/providers/lofty.ts
// Lofty (formerly Chime) CRM sync-OUT connector. Egress only — pushes/updates a lead's details
// through the single connector-gateway. The API base is overridable per connection (apiUrl)
// because Lofty issues partner-scoped hosts.
//
// WAVE 140 (lane 140I) — CONTRACT VERIFIED against developer.lofty.com (introduction, quickstart,
// 2026-10-11; VENDOR_CONTRACTS.lofty): base https://api.lofty.com with the /v1.0/ prefix (was /v1, a
// guess); an API KEY authenticates with `Authorization: token <api_key>` (Bearer is for OAuth access
// tokens — the connect form stores a personal API key, so the bearer header was refused); the CRM
// entity is LEADS (there is no "contacts" resource in the documented index — leads, tasks, listings,
// transactions, communications, webhooks). Response envelope: { code, msg, data: { total, list } };
// ids are 64-bit integers (kept as strings here). The lead BODY field names below are the pre-140
// shape (unverified against the Lead Management guide — published open item in the lane notes).

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { VENDOR_CONTRACTS } from "@/lib/agentic-os/connector-registry"
import type { CrmContactInput, CrmSyncOutResult } from "./followupboss"

/** ONE Lofty base URL (VENDOR_CONTRACTS.lofty) — read by the pull (lib/crm/import-pull.ts) too. */
export const LOFTY_API_BASE = VENDOR_CONTRACTS.lofty.baseUrl

/** The documented API-key header: `Authorization: token <api_key>` (developer.lofty.com/introduction). */
export function loftyAuth(apiKey: string): { style: "header"; name: "Authorization"; value: string } {
  return { style: "header", name: "Authorization", value: `token ${apiKey}` }
}

export async function syncContactToLofty(
  contact: CrmContactInput,
  apiKey: string | null,
  baseUrl?: string | null,
): Promise<CrmSyncOutResult> {
  if (!apiKey) return { success: false, requiresConfiguration: true, error: "Lofty not connected (missing API token)" }

  const res = await callConnector<{ id?: number | string; code?: number; data?: { id?: number | string } }>({
    connector: "lofty",
    baseUrl: baseUrl || LOFTY_API_BASE,
    path: "leads",
    method: "POST",
    auth: loftyAuth(apiKey),
    body: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      source: contact.source ?? "VIP RE OS",
      tags: contact.tags ?? [],
    },
    shape: { connector: "lofty", fields: [{ canonical: "id", aliases: ["leadId", "contactId"], required: false }] },
  })

  if (!res.ok) return { success: false, error: res.error ?? "Lofty sync failed" }
  const id = res.data?.id ?? res.data?.data?.id
  return { success: true, contactId: id != null ? String(id) : undefined, action: res.status === 201 ? "created" : "updated" }
}
