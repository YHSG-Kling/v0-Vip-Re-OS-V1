// lib/platform/service-catalogue-scope.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE SPELLING of "which service_status rows may this tenant read".
//
// WHY THIS FILE EXISTS (measured 2026-08-22 against hrvaqgvukzxfskkcrwbt):
//
//   select count(*), count(brokerage_id) from public.service_status;
//   → total 13, brokerage_id NOT NULL 0
//
// Every live row of `service_status` is a PLATFORM row (brokerage_id IS NULL):
// anthropic, apify, batchdata, docusign, dotloop, google_cse, quickbooks,
// sendgrid, stripe, supabase_db, twilio, xero, zenrows. Nothing in this
// repository ever inserts a per-tenant row — there is no INSERT INTO
// service_status in any .sql, and no `.from("service_status").insert(` anywhere
// in the tree. The catalogue is platform-only BY CONSTRUCTION, and the live RLS
// SELECT policy is written to match:
//
//   service_status_tenant_select USING
//     ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
//
// m406 ("the platform catalogue is read by all and written by its owner") and
// m409 both state the intent in words: service_status is "the surface tenants
// read to decide whether the platform is up", and only its WRITES are gated.
//
// THE DEFECT THIS CLOSES: every reader filtered `.eq("brokerage_id", <tenant>)`,
// which in PostgREST is `brokerage_id=eq.<uuid>` — SQL equality, which no NULL
// row can ever satisfy. So the System Health page, the /api/admin/health-status
// route and the tenant "platform status" card each read ZERO rows out of a
// 13-row table and rendered "No service is registered for this brokerage" to
// every brokerage admin, forever. The capability was fail-closed and honest,
// but it had never once worked.
//
// WHY THIS IS NOT A TENANT LEAK: a platform catalogue row carries a service
// name, a category, an is_critical flag and an up/down rollup for shared
// infrastructure (Stripe, Twilio, SendGrid, the database itself). It contains
// no tenant data of any kind, and it is the same row for every tenant. The
// filter below still admits NOTHING belonging to another brokerage — it widens
// only to the untenanted platform row, exactly as the RLS policy does.
//
// Genuinely tenant-scoped telemetry — system_health_checks, health_check_history,
// api_response_logs, message_provider_logs — keeps its strict
// `.eq("brokerage_id", ctx.brokerageId)` and MUST NOT use this helper.
// scripts/platform-ops-wiring-simulator.ts:205 (TENANT_READERS) enforces that
// split per table.

/**
 * PostgREST `.or()` argument mirroring the live `service_status_tenant_select`
 * policy: the untenanted platform catalogue row, plus this tenant's own rows if
 * any are ever created. Never another tenant's row.
 *
 * Usage:
 *   supabase.from("service_status").select("*").or(serviceCatalogueScope(id))
 */
export function serviceCatalogueScope(brokerageId: string): string {
  return `brokerage_id.is.null,brokerage_id.eq.${brokerageId}`
}
