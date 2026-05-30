// lib/crm/providers/lofty.ts
// Lofty (formerly Chime) CRM sync-OUT connector. Egress only — pushes/updates a contact's
// details through the single connector-gateway. Lofty uses a bearer API token; the API base
// is overridable per connection (apiUrl) because Lofty issues partner-scoped hosts.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import type { CrmContactInput, CrmSyncOutResult } from "./followupboss"

const LOFTY_DEFAULT_BASE = "https://api.lofty.com/v1"

export async function syncContactToLofty(
  contact: CrmContactInput,
  apiKey: string | null,
  baseUrl?: string | null,
): Promise<CrmSyncOutResult> {
  if (!apiKey) return { success: false, requiresConfiguration: true, error: "Lofty not connected (missing API token)" }

  const res = await callConnector<{ id?: number | string }>({
    connector: "lofty",
    baseUrl: baseUrl || LOFTY_DEFAULT_BASE,
    path: "contacts",
    method: "POST",
    auth: { style: "bearer", token: apiKey },
    body: {
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      source: contact.source ?? "VIP RE OS",
      tags: contact.tags ?? [],
    },
    shape: { connector: "lofty", fields: [{ canonical: "id", aliases: ["contactId", "leadId"], required: true }] },
  })

  if (!res.ok) return { success: false, error: res.error ?? "Lofty sync failed" }
  return { success: true, contactId: res.data?.id != null ? String(res.data.id) : undefined, action: res.status === 201 ? "created" : "updated" }
}
