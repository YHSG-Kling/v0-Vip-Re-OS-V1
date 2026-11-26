// scripts/platform-ops-simulator.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM OPS GAPS simulator — proves the l24-s01 sweep end to end:
//   1. DUNNING: pure ladder/step/compose/anchor matrix + cron wiring + live
//      ledger round-trip (event insert → dedupe honored → cleanup==0).
//   2. STRIPE TAX: pure config fragment (flag off → {}) + checkout wiring.
//   3. SUPPORT SLA/CSAT: pure deadline/breach/at-risk/rating matrix + queue
//      and cron wiring + live rating round-trip on a seeded ticket.
//   4. IMAGE LIBRARY: pure Pexels normalize/validate + platform-scope gating
//      wiring + video-create background de-hardcode + live platform-scoped asset
//      round-trip (insert brokerage_id NULL → listed → cleanup==0).
// Layers: pure (always), source (readFileSync), live (SUPABASE_SERVICE_ROLE_KEY-
// gated; seeds real rows on real tables and cleans to count==0).

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DUNNING_LADDER, planNextDunningStep, composeDunningMessage, episodeAnchor, daysBetween,
} from "../lib/billing/dunning"
import { buildCheckoutTaxConfig } from "../lib/billing/subscription-activation"
import { evaluateTicketSla, canRateTicket, rollupCsat, SLA_TARGETS_HOURS } from "../lib/support/support-sla"
import { normalizePexelsPhoto, validateLibrarySave, canShareToTenants } from "../lib/marketing/image-library"
import { MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: dunning ladder ──")
{
  check("ladder is 4 steps at day 0/3/7/14", DUNNING_LADDER.map((s) => s.afterDays).join(",") === "0,3,7,14")
  const s1 = planNextDunningStep(0, [])
  check("day 0, nothing sent → step 1", s1?.step === 1)
  check("day 5, step 1+2 sent → null (step 3 not due)", planNextDunningStep(5, [1, 2]) === null)
  check("day 9, only step 1 sent → step 3 (highest due, no stale backlog)", planNextDunningStep(9, [1])?.step === 3)
  check("day 20, all sent → null (ladder exhausted)", planNextDunningStep(20, [1, 2, 3, 4]) === null)
  const msg = composeDunningMessage(DUNNING_LADDER[0], "Acme Realty", 29900)
  check("compose substitutes brokerage + amount", msg.subject.includes("Acme Realty") && msg.body.includes("$299"))
  const msgNoAmt = composeDunningMessage(DUNNING_LADDER[1], "Acme", null)
  check("compose omits amount clause when unknown", !msgNoAmt.body.includes("$") && msgNoAmt.body.includes("Acme"))
  const anchor = episodeAnchor({ updated_at: "2026-07-01T00:00:00Z" }, [
    { invoice_date: "2026-06-20", due_date: null }, { invoice_date: "2026-06-10", due_date: "2026-06-25" },
  ])
  check("anchor = oldest open invoice date (due_date preferred)", anchor === "2026-06-20")
  check("anchor falls back to sub updated_at with no invoices", episodeAnchor({ updated_at: "2026-07-01T00:00:00Z" }, []) === "2026-07-01T00:00:00Z")
  check("daysBetween floors + never negative", daysBetween("2026-07-05T00:00:00Z", "2026-07-07T23:00:00Z") === 2 && daysBetween("2026-07-08T00:00:00Z", "2026-07-07T00:00:00Z") === 0)
}

console.log("\n── PURE: Stripe Tax config ──")
{
  check("flag OFF → empty fragment (no tax fields ever hardcoded on)", Object.keys(buildCheckoutTaxConfig(false)).length === 0)
  const on = buildCheckoutTaxConfig(true) as any
  check("flag ON → automatic_tax + customer_update + tax_id_collection", on.automatic_tax?.enabled === true && on.customer_update?.address === "auto" && on.tax_id_collection?.enabled === true)
}

console.log("\n── PURE: support SLA + CSAT ──")
{
  const now = new Date("2026-07-07T12:00:00Z")
  const urgent = evaluateTicketSla({ created_at: "2026-07-07T09:00:00Z", priority: "urgent", status: "open", first_response_at: null, resolved_at: null }, now)
  check("urgent 3h old, no reply → first_response breached (1h target)", urgent.breaches.includes("first_response"))
  check("urgent 3h old → resolution (8h) not yet breached", !urgent.breaches.includes("resolution"))
  const responded = evaluateTicketSla({ created_at: "2026-07-07T09:00:00Z", priority: "urgent", status: "in_progress", first_response_at: "2026-07-07T09:30:00Z", resolved_at: null }, now)
  check("first response inside target → no first_response breach", !responded.breaches.includes("first_response"))
  const resolved = evaluateTicketSla({ created_at: "2026-07-01T00:00:00Z", priority: "urgent", status: "resolved", first_response_at: null, resolved_at: "2026-07-01T01:00:00Z" }, now)
  check("resolved ticket NEVER breaches", resolved.breaches.length === 0)
  const low = evaluateTicketSla({ created_at: "2026-07-06T17:00:00Z", priority: "low", status: "open", first_response_at: null, resolved_at: null }, now)
  check("low 19h old (24h target) in final 25% → at risk, not breached", low.atRisk && low.breaches.length === 0)
  check("unknown priority defaults to medium targets", evaluateTicketSla({ created_at: "2026-07-07T00:00:00Z", priority: "bogus", status: "open", first_response_at: null, resolved_at: null }, now).firstResponseDueAt === new Date(new Date("2026-07-07T00:00:00Z").getTime() + SLA_TARGETS_HOURS.medium.firstResponse * 3_600_000).toISOString())
  check("cannot rate an open ticket", !canRateTicket({ status: "open", satisfaction_rating: null }, 5).ok)
  check("cannot rate twice", !canRateTicket({ status: "resolved", satisfaction_rating: 4 }, 5).ok)
  check("rating must be integer 1–5", !canRateTicket({ status: "resolved", satisfaction_rating: null }, 6).ok && !canRateTicket({ status: "resolved", satisfaction_rating: null }, 0).ok)
  check("resolved + unrated + 1–5 → ok", canRateTicket({ status: "resolved", satisfaction_rating: null }, 5).ok)
  const csat = rollupCsat([{ satisfaction_rating: 5 }, { satisfaction_rating: 3 }, { satisfaction_rating: null }])
  check("CSAT rollup averages rated only (4.0 over 2)", csat.average === 4 && csat.rated === 2)
  check("CSAT with no ratings → null, not NaN", rollupCsat([{ satisfaction_rating: null }]).average === null)
}

console.log("\n── PURE: image library ──")
{
  const img = normalizePexelsPhoto({ src: { large2x: "https://images.pexels.com/x-2x.jpg", medium: "https://images.pexels.com/x-m.jpg" }, alt: "Modern kitchen", photographer: "Jane Doe", photographer_url: "https://pexels.com/@jane" })
  check("pexels normalize: url/thumb/attribution/license carried", img?.url.endsWith("2x.jpg") === true && img?.thumbnailUrl.endsWith("m.jpg") === true && img?.photographer === "Jane Doe" && (img?.licenseNote ?? "").includes("Pexels"))
  check("pexels normalize: no src → null (never a broken row)", normalizePexelsPhoto({ alt: "x" }) === null)
  check("save validation: bad url rejected", !(validateLibrarySave({ name: "a", url: "not-a-url", scope: "platform" }) as any).ok)
  check("save validation: bogus scope rejected", !(validateLibrarySave({ name: "a", url: "https://x.com/a.jpg", scope: "global" }) as any).ok)
  const okSave = validateLibrarySave({ name: " Kitchen ", url: "https://x.com/a.jpg", scope: "platform", source: "owned" })
  check("save validation: trims + accepts platform scope for OWNED content", okSave.ok && (okSave as any).name === "Kitchen")
  // LICENSE LINE: stock licenses cover each user's own use, NOT redistribution.
  check("stock CANNOT be shared platform-wide (redistribution blocked)", !(validateLibrarySave({ name: "a", url: "https://x.com/a.jpg", scope: "platform", source: "stock:pexels" }) as any).ok)
  check("stock CAN be saved tenant-scoped (the tenant's own pick)", (validateLibrarySave({ name: "a", url: "https://x.com/a.jpg", scope: "brokerage", source: "stock:pexels" }) as any).ok)
  check("canShareToTenants: ai/owned yes, stock/unknown no", canShareToTenants("ai_image") && canShareToTenants("owned") && !canShareToTenants("stock:pexels") && !canShareToTenants(null))
}

console.log("\n── SOURCE: wiring ──")
{
  const cron = src("lib/kernel/cron-dispatch.ts")
  check("billing-dunning cron registered (daily)", /billing-dunning/.test(cron))
  check("support-sla cron registered (hourly)", /support-sla/.test(cron))
  const dunning = src("lib/billing/dunning.ts")
  check("dunning email is SendGrid-creds-gated (honest no-op)", dunning.includes("SENDGRID_API_KEY"))
  check("dunning records every step to platform_dunning_events", dunning.includes('from("platform_dunning_events")'))
  const billing = src("app/actions/billing.ts")
  check("checkout reads platform_settings.collect_tax (never hardcoded)", billing.includes("collect_tax") && billing.includes("buildCheckoutTaxConfig"))
  const console_ = src("app/actions/superadmin/support-console.ts")
  check("support queue evaluates SLA + rolls up CSAT", console_.includes("evaluateTicketSla") && console_.includes("rollupCsat"))
  const supportPage = src("app/dashboard/superadmin/support/page.tsx")
  check("queue UI badges SLA breach/at-risk + shows CSAT", supportPage.includes("SLA breached") && supportPage.includes("csatAverage"))
  const supportActions = src("app/actions/support.ts")
  check("tenant CSAT action gated by canRateTicket (own ticket only)", supportActions.includes("rateMyTicket") && supportActions.includes("canRateTicket"))
  const slaCron = src("app/api/cron/support-sla/route.ts")
  check("SLA cron rides verifyCronAuth + cron-kernel bookkeeping", slaCron.includes("verifyCronAuth") && slaCron.includes("recordCronSuccessAction"))
  const libActions = src("app/actions/marketing/image-library.ts")
  check("platform-scope library writes gated to marketing capability", libActions.includes("platformStaffCan") && libActions.includes('"Forbidden — platform marketing staff only"'))
  check("library list unions platform + tenant scope", libActions.includes("visibility_scope.eq.platform"))
  // Was asserted against app/dashboard/videos/components/BackgroundPicker.tsx —
  // a component nothing ever rendered. Deleted 2026-09-01 (§1.1); the library
  // loading it carried was merged into the LIVE video create wizard, which is
  // what this assertion must hold to.
  const videoCreate = src("app/dashboard/videos/create/video-create-client.tsx")
  check("video create wizard de-hardcoded (no unsplash demo URLs; loads library)", !videoCreate.includes("images.unsplash.com") && videoCreate.includes("listImageLibraryAction"))
  const growthPage = src("app/dashboard/superadmin/growth/page.tsx")
  check("platform library card mounted on the growth board", growthPage.includes("ImageLibraryCard"))
  const exportLib = src("lib/platform/tenant-export.ts")
  check("tenant export names its tables + never deletes (honest scope)", exportLib.includes("TENANT_EXPORT_TABLES") && exportLib.includes("does not delete"))
  const exportRoute = src("app/api/superadmin/tenant-export/[brokerageId]/route.ts")
  // ASSERT THE CONSTRUCT, NOT THE SPELLING. This used to require the literal
  // `!== "superadmin"` in the route — which pinned the DEFECT in place. That
  // predicate tested users.user_type, and no live row carries that value (the
  // platform superadmin is platform_role='superadmin', user_type='admin'), so
  // the assertion was proving the presence of a gate that refused everyone,
  // this route's own 403 included. What matters is that the route routes
  // through the ONE shared superadmin guard — which reads both identity
  // columns — and still audit-logs the export.
  check("export route superadmin-gated + audit-logged",
    exportRoute.includes("requireSuperadmin") &&
    exportRoute.includes("@/lib/auth/platform-guard") &&
    exportRoute.includes("superadmin_audit_log"))
  const brokeragePage = src("app/dashboard/superadmin/brokerages/[id]/page.tsx")
  check("offboarding panel on the brokerage detail page", brokeragePage.includes("tenant-export") && brokeragePage.includes("Offboarding"))
  for (const key of ["billing_dunning", "support_sla_csat", "shared_image_library", "tenant_offboarding_export"]) {
    check(`registry burn domain ${key}`, key in MAINTENANCE_DOMAINS)
  }
  check("platform_dunning_events owned by finance_manager", (TABLE_MANAGER as any).platform_dunning_events === "finance_manager")
}

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.log("\n  ⏭  live skipped (no creds)"); return }
  const { createClient } = await import("@supabase/supabase-js")
  const svc = createClient(url, key)
  console.log("\n── LIVE: seeded round-trips ──")

  // Image library: platform-scoped row (brokerage_id NULL) now legal.
  const { data: asset, error: aErr } = await svc.from("marketing_assets").insert({
    brokerage_id: null, visibility_scope: "platform", asset_type: "image",
    asset_name: "SIM platform library image", asset_url: "https://example.com/sim.jpg",
    source_table: "image_library", approval_status: "approved",
    metadata: { asset_kind: "library_image", source: "stock:pexels", photographer: "Sim" },
  }).select("id").single()
  check("live: platform-scoped image asset inserts (brokerage_id NULL)", !aErr && !!asset, aErr?.message)
  if (asset) {
    const { count } = await svc.from("marketing_assets").select("id", { count: "exact", head: true })
      .eq("visibility_scope", "platform").eq("asset_type", "image").eq("asset_name", "SIM platform library image")
    check("live: platform asset visible to the union list", (count ?? 0) === 1)
    await svc.from("marketing_assets").delete().eq("id", (asset as any).id)
  }

  // Dunning ledger round-trip on a real brokerage id (no notification side effects).
  const { data: anyBrk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (anyBrk) {
    const { data: ev, error: eErr } = await svc.from("platform_dunning_events").insert({
      brokerage_id: (anyBrk as any).id, subscription_id: null, step: 1, channel: "in_app", detail: "SIM dunning event",
    }).select("id, created_at").single()
    check("live: dunning event records", !eErr && !!ev, eErr?.message)
    if (ev) {
      const { data: since } = await svc.from("platform_dunning_events").select("step")
        .eq("brokerage_id", (anyBrk as any).id).gte("created_at", "2000-01-01")
      const sent = ((since ?? []) as any[]).filter((e) => e.detail !== undefined || true).map((e) => e.step)
      check("live: dedupe input sees the recorded step", sent.includes(1))
      check("live: planNextDunningStep honors the ledger (day 0, step 1 sent → null)", planNextDunningStep(0, sent) === null)
      await svc.from("platform_dunning_events").delete().eq("id", (ev as any).id)
    }
  }

  // CSAT round-trip on a seeded ticket.
  if (anyBrk) {
    // `lane` stated, never defaulted — support_tickets.lane is NOT NULL with no
    // default (m468) so a writer that omits it fails at the insert. CSAT is a
    // property of a ticket in either lane; this seeds the platform one.
    const { data: ticket, error: tErr } = await svc.from("support_tickets").insert({
      brokerage_id: (anyBrk as any).id, lane: "tenant_to_platform",
      subject: "SIM csat ticket", status: "resolved",
      priority: "low", resolved_at: new Date().toISOString(),
    }).select("id").single()
    check("live: ticket seeds", !tErr && !!ticket, tErr?.message)
    if (ticket) {
      const { error: rErr } = await svc.from("support_tickets").update({
        satisfaction_rating: 5, satisfaction_comment: "SIM great", satisfaction_at: new Date().toISOString(),
      }).eq("id", (ticket as any).id)
      check("live: CSAT columns accept a 1–5 rating", !rErr, rErr?.message)
      const { error: badErr } = await svc.from("support_tickets").update({ satisfaction_rating: 9 }).eq("id", (ticket as any).id)
      check("live: CHECK rejects rating 9", !!badErr)
      await svc.from("support_tickets").delete().eq("id", (ticket as any).id)
    }
  }

  // Cleanup verification — count==0 for every sim artifact.
  const [{ count: c1 }, { count: c2 }, { count: c3 }] = await Promise.all([
    svc.from("marketing_assets").select("id", { count: "exact", head: true }).eq("asset_name", "SIM platform library image"),
    svc.from("platform_dunning_events").select("id", { count: "exact", head: true }).eq("detail", "SIM dunning event"),
    svc.from("support_tickets").select("id", { count: "exact", head: true }).eq("subject", "SIM csat ticket"),
  ])
  check("live: cleanup complete (count==0)", (c1 ?? 0) === 0 && (c2 ?? 0) === 0 && (c3 ?? 0) === 0)
}

live().then(() => {
  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ PLATFORM_OPS_FAIL"); process.exit(1) }
  console.log(" ✅ PLATFORM_OPS_PASS")
})
