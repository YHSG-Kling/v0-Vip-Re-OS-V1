/**
 * lib/migration-status.ts — the AIRTABLE → SUPABASE / n8n → SERVER-ACTIONS record.
 *
 * WHAT THIS IS, and what it stopped being (2026-08-29, lane K4)
 * ────────────────────────────────────────────────────────────
 * Two files point a reader here in prose —
 *   app/dashboard/superadmin/engagement/page.tsx:37  "… deleted — see lib/migration-status.ts."
 *   scripts/complete-migration.ts:11                 "… for the current state."
 * — and what they want is the narrative half below: which service was removed,
 * what its named survivor is, and the one capability that was NOT ported.
 * `verifyVendorInsurance` in particular is an OPEN PRODUCT GAP recorded nowhere
 * else, so this module is documentation with real readers, not an orphan.
 *
 * WHAT WAS DELETED FROM IT: every COUNT and every frozen list.
 *   · `supabaseSchema.tablesCreated: 40`, `status: "complete"`, and a 25-name
 *     table list. The live schema exposes 757 relations (scripts/live-tables.ts,
 *     generated 2026-08-28 from public.live_schema_json()). The claim was wrong
 *     by nearly twenty times and had been wrong for as long as nobody read it.
 *   · `supabaseService.cruds: 80`, `apiRoutes.count: 25`,
 *     `serverActions.workflows: 15`, `components.updated: 37`.
 *
 * All six are WAYPOINTS — true for one afternoon of a multi-step migration and
 * permanently false afterwards — which is the exact shape CLAUDE.md §2 forbids
 * pinning anything to, and §3's "files are not the database" besides. A
 * hand-kept count of live tables cannot be right twice.
 *
 * SURVIVOR for every schema fact: scripts/live-tables.ts `LIVE_TABLES` (and
 * scripts/schema-snapshot.ts for the queried subset) — MACHINE-WRITTEN caches of
 * the live database, regenerated with `npm run schema:regen` and held honest by
 * scripts/schema-cache-drift-guard.ts. Ask them what exists; they can answer,
 * and this file never could.
 */

// DE-CODED (§1.3 + §2, 2026-08-31, lane M4): `export const migrationStatus`
// is now the PROSE below. Both of its readers are prose pointers at this FILE
// (app/dashboard/superadmin/engagement/page.tsx:37, scripts/
// complete-migration.ts:11); no code ever imported the const, so the object
// literal was documentation wearing an export — the exact shape K4's header
// ruling stripped the counts from. Every fact it carried survives verbatim:
//
//   supabaseSchema   COMPLETE. Schema facts live in the generated cache —
//                    scripts/live-tables.ts (LIVE_TABLES), machine-written,
//                    `npm run schema:regen`.
//   supabaseService  COMPLETE. services/supabaseService.ts carries the CRUD
//                    surface for contacts, leads, listings and the rest.
//   apiRoutes        COMPLETE. API routes query Supabase directly; no route
//                    reads Airtable.
//   serverActions    COMPLETE. n8n workflows replaced by native Server
//                    Actions on the Vercel AI SDK.
//   components       COMPLETE. Pages and components read supabaseService;
//                    airtableService is gone.
//   airtableService  REMOVED. services/airtableService.ts no longer exists.
//                    All reads/writes go through services/supabaseService.ts.
//                    The only surviving mentions are in
//                    scripts/complete-migration.ts, the codemod that performed
//                    the rewrite.
//   n8nService       REMOVED. services/workflowService.ts (which also exported
//                    the n8nService alias) has been DELETED. The named
//                    survivor is app/actions/workflows.ts — every non-stub
//                    method on the shim was a lossy 1:1 pass-through to the
//                    same-named export there (triggerCMAPackage dropped
//                    beds/baths/sqft/upgrades; several hardcoded the actor as
//                    "system"), and the remainder returned fabricated
//                    constants.
//                    KNOWN GAP: verifyVendorInsurance was the one capability
//                    with no real implementation anywhere — the shim returned
//                    complianceScore 100 / isCompliant true unconditionally.
//                    Nothing was ported because a function returning constants
//                    has no implementation to preserve. Vendor insurance
//                    verification is an OPEN PRODUCT GAP.
//
// This file intentionally exports nothing.
export {}
