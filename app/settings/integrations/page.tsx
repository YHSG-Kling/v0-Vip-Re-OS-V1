import { redirect } from "next/navigation"

/**
 * KEEP-ONE (2026-07 walkthrough [28] "Integrations — another provider list"):
 * this page duplicated the Connection Center's provider list with a narrower
 * crm/listing/social/voice tab set. The Connection Center is the ONE tenant
 * provider hub — full domain coverage (email, phone/SMS, calendar, social,
 * CRM sync-out with api-key connect + "Sync a contact now", IDX/listings,
 * financial, transaction, e-sign, showings, podcast) with real
 * connect/disconnect machinery. Voice/AI-calling setup lives at
 * /dashboard/settings/isa-calling; direct mail at /settings/direct-mail.
 * Inbound links to this route keep working via this redirect. (The admin
 * credential surface at /dashboard/settings/integrations — platform
 * credentials, provider overrides, IDX Broker, lead sources — is a DIFFERENT
 * surface and stays.)
 */
export default function IntegrationsRedirect() {
  redirect("/settings/connections")
}
