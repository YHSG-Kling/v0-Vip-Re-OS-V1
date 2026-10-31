// lib/crm/providers/hubspot.ts
// HubSpot CRM sync-OUT connector. Egress only — pushes/updates a contact's details. Wave 71A:
// routes through the official `@hubspot/api-client` SDK adapter (lib/providers/hubspot/client.ts)
// instead of the connector-gateway. HubSpot auth is a Bearer private-app access token. We upsert
// by email via the batch upsert endpoint (idProperty=email); with no email we fall back to a
// plain create.

import { upsertContactByEmail, createContact } from "@/lib/providers/hubspot/client"
import type { CrmContactInput, CrmSyncOutResult } from "./followupboss"

function toProperties(contact: CrmContactInput): Record<string, string> {
  const p: Record<string, string> = {
    firstname: contact.firstName,
    lastname: contact.lastName,
  }
  if (contact.email) p.email = contact.email
  if (contact.phone) p.phone = contact.phone
  if (contact.source) p.hs_analytics_source_data_1 = contact.source
  return p
}

export async function syncContactToHubSpot(contact: CrmContactInput, apiKey: string | null): Promise<CrmSyncOutResult> {
  if (!apiKey) return { success: false, requiresConfiguration: true, error: "HubSpot not connected (missing access token)" }

  const properties = toProperties(contact)

  // Upsert by email when we have one (HubSpot's idempotent contact identity), else create.
  if (contact.email) {
    const res = await upsertContactByEmail(apiKey, contact.email, properties)
    if (!res.ok) return { success: false, error: res.error ?? "HubSpot sync failed" }
    const id = res.data?.results?.[0]?.id
    return { success: true, contactId: id != null ? String(id) : undefined, action: "updated" }
  }

  const res = await createContact(apiKey, properties)
  if (!res.ok) return { success: false, error: res.error ?? "HubSpot sync failed" }
  return { success: true, contactId: res.data?.id != null ? String(res.data.id) : undefined, action: "created" }
}
