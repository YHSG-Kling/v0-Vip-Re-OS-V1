#!/usr/bin/env tsx
/**
 * scripts/seed-showcase-tenant.ts   (npm run seed:showcase-tenant [-- --remove])
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHOWCASE TENANT + THE PLATFORM'S OWN LIVE-AGENT PRESENTER, seeded from
 * the environment. Lane 78D, blind spot (8) — lane 77B recorded two open
 * items: "the platform presenter is a SETTING with no default: until a platform
 * staffer sets a D-ID Expressive presenter id on the brand kit, /get-started
 * and /demo show only the text chat" and "the platform live agent meters under
 * the showcase tenant; if that tenant has not been seeded … the session route
 * returns 503". Owner: test data is allowed if it is removed — hence `--remove`.
 *
 * ALREADY EXISTED — REUSED (CLAUDE.md §1, never a second implementation):
 *   · lib/platform/demo-tenant.ts  ensureDemoTenant / findDemoBrokerage /
 *     seedDemoData / DEMO_SEEDED_TABLES — THE is_demo tenant and its dataset
 *     (canonical signup path, hard-guarded on is_demo = true, deterministic
 *     ids → idempotent re-seed).
 *   · lib/platform/product-brand.ts loadProductBrand / resolveProductBrand /
 *     resolveProductLiveAgent — THE presenter setting (platform_settings.
 *     product_brand.liveAgent), written in the same row shape
 *     app/actions/superadmin/platform-brand.ts setProductBrandAction uses.
 *   · lib/kernel/tenant-creation-rollback.ts rollbackTenantCreation — THE
 *     tenant teardown (children then parent, counted, refusal-honest).
 *   · scripts/next-headers-shim.ts — the CLI shim the smoke drill already
 *     uses so signupBrokerageAction can run outside a Next request.
 *
 * IDEMPOTENT. A second run finds the tenant, re-seeds its deterministic
 * dataset, and re-applies the env presenter; nothing is created twice.
 *
 * `--remove` DELETES WHAT THIS SCRIPT CREATED AND NOTHING ELSE. Ownership is
 * stamped where it is written: brokerages.billing_metadata.showcase_seed on
 * the tenant (created_tenant: true only when THIS script provisioned it) and
 * product_brand.showcase_seed on the brand kit (with the PRIOR presenter
 * values, restored on removal). A tenant that existed before the seed, or a
 * presenter platform staff edited since (setProductBrandAction re-resolves
 * the jsonb and drops the stamp), is LEFT ALONE and reported — never guessed.
 *
 * REQUIRES NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (refuses
 * without them; nothing runs offline). Env read here and documented in
 * .env.example: PLATFORM_LIVE_AGENT_PRESENTER_ID, PLATFORM_LIVE_AGENT_VOICE_ID,
 * PLATFORM_LIVE_AGENT_NAME.
 */
import { registerNextHeadersShim } from "./next-headers-shim"

const SEED_BY = "scripts/seed-showcase-tenant.ts"
const REMOVE = process.argv.includes("--remove")

type Svc = any

interface TenantStamp { by: string; created_tenant: boolean; at: string }
interface BrandStamp { by: string; at: string; prior_live_agent: { presenterId: string | null; voiceId: string | null; name: string } }

function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`)
  process.exit(2)
}

async function audit(svc: Svc, action: string, targetId: string, details: Record<string, unknown>) {
  const { error } = await svc.from("superadmin_audit_log").insert({
    actor_user_id: null, actor_email: `script:${SEED_BY}`, action, target_type: "brokerage", target_id: targetId, details,
  })
  if (error) console.warn(`  ! audit insert refused (${action}): ${error.message}`)
}

// ── the brand-kit write, in the ONE row shape setProductBrandAction uses ─────
async function writeProductBrand(svc: Svc, productBrand: Record<string, unknown>): Promise<string | null> {
  const { data: row, error: readErr } = await svc.from("platform_settings").select("id").limit(1).maybeSingle()
  if (readErr) return readErr.message
  const write = row
    ? await svc.from("platform_settings").update({ product_brand: productBrand, updated_at: new Date().toISOString() }).eq("id", row.id)
    : await svc.from("platform_settings").insert({ product_brand: productBrand })
  return write.error?.message ?? null
}

async function readRawProductBrand(svc: Svc): Promise<Record<string, unknown>> {
  const { data, error } = await svc.from("platform_settings").select("product_brand").limit(1).maybeSingle()
  if (error) refuse(`platform_settings read refused: ${error.message}`)
  const raw = (data as { product_brand?: unknown } | null)?.product_brand
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

// ── seed ─────────────────────────────────────────────────────────────────────
async function seed(svc: Svc) {
  const demo = await import("../lib/platform/demo-tenant")
  const brandMod = await import("../lib/platform/product-brand")

  console.log("\n[1 · the showcase tenant (brokerages.is_demo = true)]")
  const before = await demo.findDemoBrokerage(svc)
  const ensured = before ? { ok: true as const, created: false, brokerage: before } : await demo.ensureDemoTenant()
  if (!ensured.ok || !ensured.brokerage) refuse(`showcase tenant could not be ensured: ${"error" in ensured ? ensured.error : "no brokerage returned"}`)
  const brokerageId = ensured.brokerage.id
  console.log(`  ${ensured.created ? "created" : "found"} ${ensured.brokerage.name} (${brokerageId}, slug ${ensured.brokerage.slug})`)

  // Ownership stamp — written ONCE, on whichever run first sees the tenant.
  const { data: bmRow, error: bmErr } = await svc.from("brokerages").select("billing_metadata").eq("id", brokerageId).maybeSingle()
  if (bmErr) refuse(`billing_metadata read refused: ${bmErr.message}`)
  const bm = ((bmRow as { billing_metadata?: unknown } | null)?.billing_metadata ?? {}) as Record<string, unknown>
  if (!bm.showcase_seed) {
    const stamp: TenantStamp = { by: SEED_BY, created_tenant: ensured.created, at: new Date().toISOString() }
    const { data: stamped, error: stampErr } = await svc.from("brokerages")
      .update({ billing_metadata: { ...bm, showcase_seed: stamp }, updated_at: new Date().toISOString() })
      .eq("id", brokerageId).eq("is_demo", true).select("id")
    if (stampErr || !stamped?.length) refuse(`ownership stamp not written (${stampErr?.message ?? "matched no is_demo row"}) — --remove could not know what to delete`)
    console.log(`  ownership stamped (created_tenant=${stamp.created_tenant})`)
  } else {
    console.log(`  ownership stamp already present (created_tenant=${(bm.showcase_seed as TenantStamp).created_tenant})`)
  }

  console.log("\n[2 · the showcase dataset (deterministic ids — wipe + re-seed)]")
  const seeded = await demo.seedDemoData(brokerageId)
  if (!seeded.ok) refuse(`dataset seed failed: ${seeded.error}`)
  console.log(`  ${Object.entries(seeded.counts ?? {}).map(([t, n]) => `${t}=${n}`).join(" · ")}`)
  await audit(svc, "demo_tenant.seeded", brokerageId, { by: SEED_BY, created: ensured.created, counts: seeded.counts })

  console.log("\n[3 · the platform live-agent presenter (platform_settings.product_brand.liveAgent)]")
  const presenterId = process.env.PLATFORM_LIVE_AGENT_PRESENTER_ID?.trim() || null
  const voiceId = process.env.PLATFORM_LIVE_AGENT_VOICE_ID?.trim() || null
  const name = process.env.PLATFORM_LIVE_AGENT_NAME?.trim() || null
  if (!presenterId && !voiceId && !name) {
    console.log("  ⊘ no PLATFORM_LIVE_AGENT_* env set — presenter left as it is (see .env.example)")
    return
  }
  const raw = await readRawProductBrand(svc)
  const current = brandMod.resolveProductBrand(raw)
  const wanted = { ...current.liveAgent, ...(presenterId ? { presenterId } : {}), ...(voiceId ? { voiceId } : {}), ...(name ? { name } : {}) }
  const resolvedAgent = brandMod.resolveProductLiveAgent(wanted)
  if (presenterId && resolvedAgent.presenterId !== presenterId) {
    refuse(`PLATFORM_LIVE_AGENT_PRESENTER_ID "${presenterId}" is not a D-ID presenter id shape (resolveProductLiveAgent rejected it) — nothing was written`)
  }
  const existingStamp = (raw.showcase_seed ?? null) as BrandStamp | null
  const stamp: BrandStamp = existingStamp ?? {
    by: SEED_BY, at: new Date().toISOString(),
    prior_live_agent: { presenterId: current.liveAgent.presenterId, voiceId: current.liveAgent.voiceId, name: current.liveAgent.name },
  }
  const next = brandMod.resolveProductBrand({ ...current, liveAgent: resolvedAgent })
  const writeErr = await writeProductBrand(svc, { ...next, showcase_seed: stamp })
  if (writeErr) refuse(`presenter write refused: ${writeErr}`)
  console.log(`  presenterId=${next.liveAgent.presenterId ?? "—"} voiceId=${next.liveAgent.voiceId ?? "—"} name=${next.liveAgent.name}`)
  await audit(svc, "demo_tenant.presenter_seeded", brokerageId, { by: SEED_BY, presenterId: next.liveAgent.presenterId, voiceId: next.liveAgent.voiceId, name: next.liveAgent.name })
}

// ── remove ───────────────────────────────────────────────────────────────────
async function remove(svc: Svc) {
  const demo = await import("../lib/platform/demo-tenant")
  const brandMod = await import("../lib/platform/product-brand")

  console.log("\n[1 · the presenter — restore what this script replaced]")
  const raw = await readRawProductBrand(svc)
  const brandStamp = (raw.showcase_seed ?? null) as BrandStamp | null
  if (brandStamp?.by === SEED_BY) {
    const current = brandMod.resolveProductBrand(raw)
    const restored = brandMod.resolveProductBrand({ ...current, liveAgent: { ...current.liveAgent, ...brandStamp.prior_live_agent } })
    const writeErr = await writeProductBrand(svc, { ...restored })
    if (writeErr) refuse(`presenter restore refused: ${writeErr}`)
    console.log(`  restored presenterId=${restored.liveAgent.presenterId ?? "—"} voiceId=${restored.liveAgent.voiceId ?? "—"} name=${restored.liveAgent.name}`)
  } else {
    console.log("  ⊘ presenter not stamped by this script (never seeded, or edited by platform staff since) — LEFT ALONE")
  }

  console.log("\n[2 · the showcase tenant]")
  const found = await demo.findDemoBrokerage(svc)
  if (!found) { console.log("  ⊘ no is_demo tenant exists — nothing to remove"); return }
  const { data: bmRow, error: bmErr } = await svc.from("brokerages").select("billing_metadata").eq("id", found.id).maybeSingle()
  if (bmErr) refuse(`billing_metadata read refused: ${bmErr.message}`)
  const stamp = (((bmRow as { billing_metadata?: unknown } | null)?.billing_metadata ?? {}) as Record<string, unknown>).showcase_seed as TenantStamp | undefined
  if (!stamp || stamp.by !== SEED_BY) {
    console.log(`  ⊘ ${found.name} (${found.id}) carries no ownership stamp from this script — LEFT ALONE (it was not created here)`)
    return
  }
  // The dataset this script (re)seeded is removed either way — it is the
  // deterministic showcase rows, scoped to the is_demo tenant and COUNTED.
  for (const table of demo.DEMO_SEEDED_TABLES) {
    const { data: gone, error } = await svc.from(table).delete().eq("brokerage_id", found.id).select("id")
    if (error) refuse(`dataset wipe refused on ${table}: ${error.message}`)
    console.log(`  ${table}: ${(gone ?? []).length} row(s) removed`)
  }
  if (!stamp.created_tenant) {
    console.log(`  ⊘ ${found.name} existed before this script ran (created_tenant=false) — the tenant row is LEFT; only the seeded dataset was removed`)
    await audit(svc, "demo_tenant.dataset_removed", found.id, { by: SEED_BY })
    return
  }
  const { rollbackTenantCreation } = await import("../lib/kernel/tenant-creation-rollback")
  const rb = await rollbackTenantCreation(svc, found.id)
  if (!rb.ok) refuse(`tenant rollback did not remove the brokerage: ${rb.error} (child refusals: ${rb.childRefusals.join("; ") || "none"})`)
  console.log(`  brokerage ${found.id} removed · children: ${Object.entries(rb.childrenRemoved).map(([t, n]) => `${t}=${n}`).join(" · ") || "none counted"}`)
  const after = await demo.findDemoBrokerage(svc)
  if (after) refuse(`an is_demo brokerage still exists after rollback (${after.id})`)
  console.log("  verified: no is_demo brokerage remains")
}

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(` Showcase tenant + platform presenter seed ${REMOVE ? "— REMOVE" : ""}`)
  console.log("══════════════════════════════════════════════════════════")
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) refuse("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required — nothing was seeded or removed")
  if (!registerNextHeadersShim()) refuse("the next/headers shim did not register — the canonical signup path cannot run from the CLI")
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  if (REMOVE) await remove(svc)
  else await seed(svc)
  console.log("\n ✅ done")
}

main().catch((e) => { console.error(e); process.exit(1) })
