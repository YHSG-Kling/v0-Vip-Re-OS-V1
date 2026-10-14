// lib/crm/providers/followupboss.ts
// Follow Up Boss CRM sync-OUT connector. Egress only — pushes/updates a contact's details.
// Routes through the single connector-gateway (no bespoke fetch). FUB auth is HTTP Basic
// with the API key as the username and an empty password; POST /people upserts by email.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

const FUB_BASE = "https://api.followupboss.com/v1"

export interface CrmContactInput {
  firstName: string
  lastName: string
  email?: string
  phone?: string
  source?: string
  tags?: string[]
}

export interface CrmSyncOutResult {
  success: boolean
  contactId?: string
  action?: "created" | "updated"
  error?: string
  requiresConfiguration?: boolean
}

/** Who the push is made FOR (wave 141, lane 141D): the tenant whose CRM this is. It lands on the
 *  gateway's api_response_logs row (brokerage_id), so a tenant's own-CRM traffic and provider
 *  health are attributable to that tenant — usage BOOKED, not platform-scope by omission. The
 *  tenant's credential is theirs; there is no platform cost to meter, only the attribution. */
export interface CrmSyncOutScope { brokerageId?: string | null }

export async function syncContactToFollowUpBoss(contact: CrmContactInput, apiKey: string | null, scope: CrmSyncOutScope = {}): Promise<CrmSyncOutResult> {
  if (!apiKey) return { success: false, requiresConfiguration: true, error: "Follow Up Boss not connected (missing API key)" }

  const res = await callConnector<{ id?: number | string }>({
    connector: "followupboss",
    baseUrl: FUB_BASE,
    path: "people",
    method: "POST",
    brokerageId: scope.brokerageId ?? null,
    auth: { style: "basic", username: apiKey, password: "" },
    body: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      emails: contact.email ? [{ value: contact.email, type: "work" }] : [],
      phones: contact.phone ? [{ value: contact.phone, type: "mobile" }] : [],
      source: contact.source ?? "VIP RE OS",
      tags: contact.tags ?? [],
    },
    shape: { connector: "followupboss", fields: [{ canonical: "id", aliases: ["personId", "contactId"], required: true }] },
  })

  if (!res.ok) return { success: false, error: res.error ?? "Follow Up Boss sync failed" }
  // FUB upserts on email — 201 created vs 200 merged. We report a stable contactId either way.
  return { success: true, contactId: res.data?.id != null ? String(res.data.id) : undefined, action: res.status === 201 ? "created" : "updated" }
}
