// lib/kernel/tenant-operating-baseline.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TENANT OPERATING BASELINE (wave 140, lanes D+E — owner: "every subscriber
// automatically gets: canonical snapshot (versioned, evidenced), baseline website
// (tenant-owned, usable URL, branding defaults, default pages, no duplicates on
// retry), tenant settings/policies/entitlements/feature flags/manager config/
// operating defaults … repair/retry never overwrites tenant customization").
//
// NOTHING NEW IS INITIALIZED HERE. Each item below is an EXISTING initializer the
// provisioner already ran once, inline, inside lib/kernel/tenant-creation.ts
// createTenantCore (steps 6, 8a, 8b, 8d) — this module is the ONE idempotent,
// fill-absent re-runnable spelling of those steps so the provisioner (lane 140C)
// and the readiness repair (lanes 140B/K, lib/kernel/tenant-readiness.ts) call
// the same function and a retry can never overwrite what a tenant customized.
//
// CENSUS (what a tenant needs ROWS for vs what is default-by-absence) lives in
// docs/architecture/READINESS-MATRIX.md §"Operating baseline (lanes 140D+E)".
// Everything classified default-by-absence there (brokerage_settings policy keys,
// ai_isa_settings, assignment_rules, cadence policies, notification toggles,
// autonomy budgets, healing policy, entitlements by tier, feature_flags by tier,
// manager authority, morning standup, exception center, finance, gamification,
// portal) needs NO row: its reader resolves the platform default when the row is
// absent, and writing a row would turn "platform default" into a frozen copy.
//
// ITEMS (every one idempotent — present → untouched):
//   website   brokerages.slug — the storefront app/site/[slug] serves from live
//             tables (resolveUniqueTenantSlug; absent → minted, present → kept)
//   snapshot  the tier's canonical snapshot (lib/platform/trial-funnel.ts
//             snapshotForTier: newest platform_config_snapshots row recommending
//             the tier = the VERSION) applied in `fill_absent` mode
//   evidence  brokerage_settings.settings.operating_baseline — which snapshot
//             version initialized this tenant, when, by whom (written ONCE through
//             the one settings writer mergeBrokerageSettings; later fills append
//             last_filled only when something was actually filled)
//   isa_actor the tenant's AI-ISA system user (brokerages.ai_isa_system_user_id)
//   assistant the day-one assistant identity (ai_identity_profiles, seedStarterAssistant)
//   education the onboarding library assignment for the tenant admin
//             (learning_assignments, upsert ignoreDuplicates — the 8d idiom)
//   reactivation the AI-ISA reactivation campaign_sequence (ensureReactivationSequence)
//
// TENANT (CLAUDE.md §4): brokerageId is the id the caller minted (provisioner) or
// resolved from its contract (readiness repair) — never a request body. Every
// write carries that id; a refused read FAILS CLOSED (reported, nothing written).
// EVIDENCE (LAW 5): every item reports present | created | filled | skipped |
// refused with its detail; the snapshot version lands on the tenant's own row.
//
// READINESS HOOK (integrator): lib/kernel/tenant-readiness.ts `snapshot`, `website`,
// `settings` and `managers` checks read the items this returns and route a
// REPAIRABLE gap back to this function (playbook "tenant_operating_baseline");
// createTenantCore calls it after the subscription row exists (step 6).

import { tenantWebsitePath, resolveUniqueTenantSlug } from "@/lib/kernel/tenant-creation"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

export const OPERATING_BASELINE_EVIDENCE_KEY = "operating_baseline"

export type TenantBaselineItemKey = "website" | "snapshot" | "evidence" | "isa_actor" | "assistant" | "education" | "reactivation"
export type TenantBaselineItemStatus = "present" | "created" | "filled" | "skipped" | "refused"

export interface TenantBaselineItem {
  key: TenantBaselineItemKey
  status: TenantBaselineItemStatus
  detail: string
  evidence?: Record<string, unknown>
}

export interface TenantOperatingBaselineResult {
  ok: boolean
  brokerageId: string
  /** `/site/<slug>` once the website item is present or created; null when the tenant could not be read. */
  websitePath: string | null
  /** `<snapshot id>@<created_at>` or `platform_defaults` when no snapshot recommends the tier. */
  snapshotVersion: string | null
  items: TenantBaselineItem[]
  refused: string[]
  /** `<table>.<key>` values a fill-absent apply left as the tenant holds them. */
  preserved: string[]
}

/** The EXISTING initializers, injectable so an in-memory proof can pin each one's
 *  idempotency contract without the env (auth admin, image generation) they need live. */
export interface TenantBaselineDeps {
  snapshotForTier: (tier: string, svc: any) => Promise<{ id: string; name: string; createdAt: string; payload: unknown } | null>
  applySnapshotPayload: (payload: any, brokerageId: string, actorUserId: string, svc: any, opts: { mode: "fill_absent" }) => Promise<{ applied: string[]; refused: string[]; preserved: string[] }>
  provisionIsaActor: (args: { brokerageId: string; brokerageName?: string; brokerageSlug?: string | null }) => Promise<{ userId: string; created: boolean }>
  seedStarterAssistant: (svc: any, brokerageId: string) => Promise<{ seeded: boolean; withPhoto: boolean; reason?: string }>
  ensureReactivationSequence: (brokerageId: string, svc: any) => Promise<{ sequenceId: string | null; created: boolean; error?: string }>
  mergeBrokerageSettings: (svc: any, brokerageId: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  now: () => Date
}

async function defaultDeps(): Promise<TenantBaselineDeps> {
  const [{ snapshotForTier }, { applySnapshotPayload }, { provisionIsaActorForBrokerage }, { seedStarterAssistant }, { ensureReactivationSequence }, { mergeBrokerageSettings }] = await Promise.all([
    import("@/lib/platform/trial-funnel"),
    import("@/lib/platform/config-snapshots"),
    import("@/lib/auth/provision-isa-actor"),
    import("@/lib/kernel/assistant-starter"),
    import("@/lib/lead-pipeline/reactivation-sequence-installer"),
    import("@/lib/settings/brokerage-settings-merge"),
  ])
  return {
    snapshotForTier,
    applySnapshotPayload: (payload, brokerageId, actor, svc, opts) => applySnapshotPayload(payload, brokerageId, actor, svc, opts),
    provisionIsaActor: provisionIsaActorForBrokerage,
    seedStarterAssistant,
    ensureReactivationSequence,
    mergeBrokerageSettings: (svc, brokerageId, patch) => mergeBrokerageSettings(svc, brokerageId, patch),
    now: () => new Date(),
  }
}

/** PURE: the version string the evidence row carries for a snapshot (or none). */
export function snapshotVersionOf(snap: { id: string; createdAt: string } | null): string {
  return snap ? `${snap.id}@${snap.createdAt}` : "platform_defaults"
}

/**
 * Initialize (or re-verify) a tenant's operating baseline. Idempotent and fill-absent:
 * calling it twice with customizations present changes nothing the second time.
 * `svc` is the service client the caller already gated; `actorUserId` is the staff
 * actor, the owner, or null for an autonomous repair (recorded as "system").
 */
export async function initializeTenantOperatingBaseline(
  svc: any,
  brokerageId: string,
  opts: { actorUserId?: string | null; deps?: Partial<TenantBaselineDeps> } = {},
): Promise<TenantOperatingBaselineResult> {
  const items: TenantBaselineItem[] = []
  const refused: string[] = []
  const preserved: string[] = []
  const deps: TenantBaselineDeps = { ...(await defaultDeps()), ...(opts.deps ?? {}) }
  const actor = opts.actorUserId ?? null
  const fail = (reason: string): TenantOperatingBaselineResult => ({ ok: false, brokerageId, websitePath: null, snapshotVersion: null, items, refused: [...refused, reason], preserved })

  if (!brokerageId) return fail("No brokerage id — the operating baseline needs the tenant the caller minted or resolved; nothing was written.")

  // 0. THE TENANT — read first, fail closed on a refusal (an unreadable tenant is not "a new one").
  const { data: brokerage, error: bErr } = await svc
    .from("brokerages").select("id, name, slug, plan_tier, ai_isa_system_user_id").eq("id", brokerageId).is("deleted_at", null).maybeSingle()
  if (bErr) return fail(`Brokerage ${brokerageId} could not be read (${bErr.message}) — baseline NOT initialized.`)
  if (!brokerage) return fail(`Brokerage ${brokerageId} not found — baseline NOT initialized.`)
  const b = brokerage as { id: string; name: string; slug: string | null; plan_tier: string | null; ai_isa_system_user_id: string | null }
  const nowIso = deps.now().toISOString()

  // 1. WEBSITE — the slug IS the storefront (app/site/[slug] assembles the default
  //    pages — hero, listings, agents, blog, recruiting — from this tenant's rows only).
  let slug = (b.slug ?? "").trim() || null
  if (slug) items.push({ key: "website", status: "present", detail: `storefront ${tenantWebsitePath(slug)}`, evidence: { slug } })
  else {
    const res = await resolveUniqueTenantSlug(svc, b.name)
    if (!res.ok) { refused.push(res.error); items.push({ key: "website", status: "refused", detail: res.error }) }
    else {
      // Written only where the slug is STILL null — a concurrent creation that landed first keeps its slug.
      const { data: rows, error } = await svc.from("brokerages").update({ slug: res.slug, updated_at: nowIso }).eq("id", brokerageId).is("slug", null).select("id")
      if (error) { refused.push(`website slug: ${error.message}`); items.push({ key: "website", status: "refused", detail: error.message }) }
      else if ((rows ?? []).length !== 1) {
        const { data: again } = await svc.from("brokerages").select("slug").eq("id", brokerageId).maybeSingle()
        slug = ((again as { slug?: string | null } | null)?.slug ?? "").trim() || null
        items.push({ key: "website", status: slug ? "present" : "refused", detail: slug ? `storefront ${tenantWebsitePath(slug)} (written concurrently)` : "slug write matched no row" })
        if (!slug) refused.push("website slug: write matched no row and none exists")
      } else { slug = res.slug; items.push({ key: "website", status: "created", detail: `storefront ${tenantWebsitePath(slug)}`, evidence: { slug, retried: res.retried } }) }
    }
  }

  // 2. SNAPSHOT — the tier's canonical (newest) snapshot, fill-absent only.
  let snap: { id: string; name: string; createdAt: string; payload: unknown } | null = null
  let snapshotApplied: string[] = []
  try {
    snap = b.plan_tier ? await deps.snapshotForTier(b.plan_tier, svc) : null
    if (!snap) items.push({ key: "snapshot", status: "skipped", detail: `no platform_config_snapshots row recommends tier ${b.plan_tier ?? "(none)"} — platform defaults (readers fall back by absence)` })
    else {
      const r = await deps.applySnapshotPayload(snap.payload, brokerageId, actor ?? "system", svc, { mode: "fill_absent" })
      snapshotApplied = r.applied
      preserved.push(...r.preserved)
      refused.push(...r.refused.map((x) => `snapshot ${x}`))
      items.push({
        key: "snapshot", status: r.refused.length ? "refused" : r.applied.length ? "filled" : "present",
        detail: r.refused.length ? r.refused.join("; ") : r.applied.length ? `filled: ${r.applied.join(", ")}` : `every carried key already held (${r.preserved.length} preserved)`,
        evidence: { snapshot_id: snap.id, snapshot_name: snap.name, version: snapshotVersionOf(snap), applied: r.applied, preserved: r.preserved },
      })
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? "snapshot apply threw"
    refused.push(`snapshot: ${msg}`); items.push({ key: "snapshot", status: "refused", detail: msg })
  }
  const snapshotVersion = snapshotVersionOf(snap)

  // 3. EVIDENCE — written once on the tenant's own settings row; a later run that
  //    filled something appends last_filled (a run that filled nothing writes nothing).
  const { data: settingsRow, error: sErr } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (sErr) { refused.push(`evidence read: ${sErr.message}`); items.push({ key: "evidence", status: "refused", detail: sErr.message }) }
  else {
    const current = (((settingsRow as { settings?: unknown } | null)?.settings ?? {}) as Record<string, unknown>)
    const existing = current[OPERATING_BASELINE_EVIDENCE_KEY] as Record<string, unknown> | undefined
    if (!existing) {
      const evidence = { version: snapshotVersion, snapshot_id: snap?.id ?? null, snapshot_name: snap?.name ?? null, snapshot_created_at: snap?.createdAt ?? null, initialized_at: nowIso, initialized_by: actor ?? "system", applied: snapshotApplied }
      const m = await deps.mergeBrokerageSettings(svc, brokerageId, { [OPERATING_BASELINE_EVIDENCE_KEY]: evidence })
      if (!m.ok) { refused.push(`evidence: ${m.error ?? "settings merge refused"}`); items.push({ key: "evidence", status: "refused", detail: m.error ?? "settings merge refused" }) }
      else items.push({ key: "evidence", status: "created", detail: `operating_baseline ${snapshotVersion}`, evidence })
    } else if (snapshotApplied.length) {
      const next = { ...existing, last_filled: { version: snapshotVersion, at: nowIso, by: actor ?? "system", applied: snapshotApplied } }
      const m = await deps.mergeBrokerageSettings(svc, brokerageId, { [OPERATING_BASELINE_EVIDENCE_KEY]: next })
      if (!m.ok) { refused.push(`evidence: ${m.error ?? "settings merge refused"}`); items.push({ key: "evidence", status: "refused", detail: m.error ?? "settings merge refused" }) }
      else items.push({ key: "evidence", status: "filled", detail: `operating_baseline ${String(existing.version)} (last_filled ${snapshotVersion})`, evidence: next })
    } else items.push({ key: "evidence", status: "present", detail: `operating_baseline ${String(existing.version)}`, evidence: existing })
  }

  // 4. ISA ACTOR — idempotent on brokerages.ai_isa_system_user_id.
  if (b.ai_isa_system_user_id) items.push({ key: "isa_actor", status: "present", detail: "ai_isa_system_user_id set" })
  else {
    try {
      const r = await deps.provisionIsaActor({ brokerageId, brokerageName: b.name, brokerageSlug: slug })
      items.push({ key: "isa_actor", status: r.created ? "created" : "present", detail: `ai_isa_system_user_id ${r.userId}` })
    } catch (err) { const msg = (err as Error)?.message ?? "ISA actor provisioning threw"; refused.push(`isa_actor: ${msg}`); items.push({ key: "isa_actor", status: "refused", detail: msg }) }
  }

  // 5. ASSISTANT IDENTITY — seedStarterAssistant never overwrites an existing profile.
  try {
    const r = await deps.seedStarterAssistant(svc, brokerageId)
    if (r.seeded) items.push({ key: "assistant", status: "created", detail: r.withPhoto ? "starter identity with headshot" : "starter identity (no headshot yet)" })
    else if (/exists/i.test(r.reason ?? "")) items.push({ key: "assistant", status: "present", detail: r.reason ?? "profile exists" })
    else { refused.push(`assistant: ${r.reason ?? "seed refused"}`); items.push({ key: "assistant", status: "refused", detail: r.reason ?? "seed refused" }) }
  } catch (err) { const msg = (err as Error)?.message ?? "assistant seed threw"; refused.push(`assistant: ${msg}`); items.push({ key: "assistant", status: "refused", detail: msg }) }

  // 6. EDUCATION — the onboarding library for the tenant admin (the provisioner's 8d idiom:
  //    upsert on (agent_user_id, module_id), ignoreDuplicates). No admin yet → skipped, named:
  //    the admin user is the readiness contract's own item, never minted here.
  const { data: admins, error: aErr } = await svc.from("users").select("id").eq("brokerage_id", brokerageId).in("user_type", Array.from(TENANT_ADMIN_USER_TYPES)).order("created_at", { ascending: true }).limit(1)
  if (aErr) { refused.push(`education (admin read): ${aErr.message}`); items.push({ key: "education", status: "refused", detail: aErr.message }) }
  else if (!(admins ?? []).length) items.push({ key: "education", status: "skipped", detail: "no tenant admin user yet (readiness item adminUser) — library assigned once one exists" })
  else {
    const adminId = (admins as Array<{ id: string }>)[0].id
    const { data: have, error: hErr } = await svc.from("learning_assignments").select("id").eq("brokerage_id", brokerageId).eq("agent_user_id", adminId).eq("signal_source", "subscriber_onboarding").limit(1)
    if (hErr) { refused.push(`education (read): ${hErr.message}`); items.push({ key: "education", status: "refused", detail: hErr.message }) }
    else if ((have ?? []).length) items.push({ key: "education", status: "present", detail: "onboarding library assigned" })
    else {
      const { data: mods, error: mErr } = await svc.from("learning_modules").select("id").is("brokerage_id", null).eq("status", "published").overlaps("audience_roles", ["agent", "broker"]).order("display_priority", { ascending: false }).limit(3)
      if (mErr) { refused.push(`education (modules): ${mErr.message}`); items.push({ key: "education", status: "refused", detail: mErr.message }) }
      else if (!(mods ?? []).length) items.push({ key: "education", status: "skipped", detail: "no published platform learning_modules for agent/broker — nothing to assign" })
      else {
        let assigned = 0
        const errs: string[] = []
        for (const m of mods as Array<{ id: string }>) {
          const { error } = await svc.from("learning_assignments").upsert({ brokerage_id: brokerageId, module_id: m.id, agent_user_id: adminId, status: "open", signal_source: "subscriber_onboarding" }, { onConflict: "agent_user_id,module_id", ignoreDuplicates: true })
          if (error) errs.push(error.message); else assigned += 1
        }
        if (errs.length) refused.push(`education: ${errs.join("; ")}`)
        items.push({ key: "education", status: errs.length ? "refused" : "created", detail: errs.length ? errs.join("; ") : `${assigned} onboarding module(s) assigned`, evidence: { assigned, admin_user_id: adminId } })
      }
    }
  }

  // 7. REACTIVATION SEQUENCE — ensureReactivationSequence is idempotent per brokerage.
  try {
    const r = await deps.ensureReactivationSequence(brokerageId, svc)
    if (r.error) { refused.push(`reactivation: ${r.error}`); items.push({ key: "reactivation", status: "refused", detail: r.error }) }
    else items.push({ key: "reactivation", status: r.created ? "created" : "present", detail: `campaign_sequence ${r.sequenceId ?? "(none)"}` })
  } catch (err) { const msg = (err as Error)?.message ?? "reactivation installer threw"; refused.push(`reactivation: ${msg}`); items.push({ key: "reactivation", status: "refused", detail: msg }) }

  if (refused.length) console.error(`[tenant-operating-baseline] ${brokerageId}: ${refused.length} item(s) refused — ${refused.join(" | ")}`)
  return { ok: refused.length === 0, brokerageId, websitePath: slug ? tenantWebsitePath(slug) : null, snapshotVersion, items, refused, preserved }
}
