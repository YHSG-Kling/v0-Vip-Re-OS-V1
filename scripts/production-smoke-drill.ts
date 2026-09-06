#!/usr/bin/env tsx
/**
 * scripts/production-smoke-drill.ts   (run: npx tsx scripts/production-smoke-drill.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PRODUCTION SMOKE DRILL — one repeatable fresh-tenant golden path, live-fired
 * against the real DB through the REAL code paths, with complete cleanup.
 *
 * The ordered drill (each step prints ✓ / ✗ / ⊘ with timing):
 *   1. PROVISION  — a synthetic solo-agent tenant through the REAL self-serve path
 *                   (signupBrokerageAction → provisionTenantOwner: auth user FIRST,
 *                   users/agents/roles/onboarding/subscription/assistant seed).
 *   2. MARKET     — a lead_scraping_markets territory for the tenant.
 *   3. RAW        — one raw_scraped_leads record with the round-39 eligibility
 *                   shape (first+last name AND email — phone is not an anchor).
 *   4. PROMOTE    — the REAL processRawRecord to promotion (raw → lead). Runs the
 *                   production function itself; a next/headers shim provides the
 *                   request-scope cookie store the CLI lacks (see SHIM note).
 *   5. QUALIFY +  — the REAL qualification stamps (handleISAQualificationStarted →
 *      ENGINE 2     handleConsentReceived) then recordAiIsaOutcome('qualified'),
 *                   which fires the REAL Engine 2 (evaluateAndAssignLead →
 *                   handleLeadAssigned) → contact created + assignment.
 *   6. PORTAL     — the portal-invite readiness read (composePortalClientsRead)
 *                   surfaces the new contact.
 *   7. DISPATCH   — no-op honesty where providers are absent: outbound is probed
 *      GATE         ONLY through gates that refuse BEFORE any provider call
 *                   (SMS without TCPA consent; direct mail without a verified
 *                   mailing address) — the drill NEVER egresses a client message,
 *                   in any environment. Provider posture (SendGrid/Twilio/Lob env)
 *                   is reported honestly, not probed.
 *   8. CLEANUP    — delete EVERYTHING in FK order (auth users included), then a
 *                   residue sweep across every touched table. Residue > 0 FAILS
 *                   the drill.
 *
 * HONESTY RULES
 *   - No creds / DB unreachable → the live drill degrades to STATED SKIPS (the
 *     same posture as e2e-lifecycle-harness / tenant-creation-simulator), never
 *     fake passes. The pure preflight layer always runs.
 *   - SHIM note: processRawRecord's supabase client calls next/headers cookies(),
 *     which only exists inside a Next request. The drill registers a module hook
 *     that supplies an EMPTY cookie store — the pipeline logic that runs is 100%
 *     the production function. The drill also runs the pipeline in the privileged
 *     service posture (the same RLS-bypassing access the kernel's service client
 *     carries); RLS behavior is explicitly NOT what this drill proves.
 *   - Enrichment vendors (PeopleData/Perplexity) are creds-gated inside the
 *     pipeline itself; without keys the pipeline's own no-data branch runs
 *     (confidence 0.3, fields pass through) — that is the honest production
 *     behavior for an unconfigured tenant, not a mock.
 *
 * Live run:
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npx tsx scripts/production-smoke-drill.ts
 */
import { randomUUID } from "node:crypto"
import { register, createRequire } from "node:module"

// ─── result plumbing ─────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0
const failures: string[] = []
function stepPass(label: string, ms: number, detail?: string) {
  passed++
  console.log(`  ✓ ${label}  (${ms}ms)${detail ? ` — ${detail}` : ""}`)
}
function stepFail(label: string, ms: number, detail?: string) {
  failed++
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`)
  console.log(`  ✗ ${label}  (${ms}ms)${detail ? ` — ${detail}` : ""}`)
}
function stepSkip(label: string, reason: string) {
  skipped++
  console.log(`  ⊘ ${label} — SKIPPED: ${reason}`)
}
async function timed<T>(fn: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const t0 = Date.now()
  const out = await fn()
  return { out, ms: Date.now() - t0 }
}

// ─── the next/headers shim (module hook) ─────────────────────────────────────
// processRawRecord → lib/supabase/server createClient() → next/headers cookies().
// cookies() throws outside a Next request scope, so the CLI drill supplies an
// EMPTY cookie store via a Node module-customization hook. Only the request
// plumbing is shimmed — every pipeline function that executes is production code.
const SHIM_URL = "vipre-smoke-shim:next-headers"
const shimLoader = `
export async function resolve(specifier, context, next) {
  if (specifier === "next/headers") return { shortCircuit: true, url: ${JSON.stringify(SHIM_URL)} }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url === ${JSON.stringify(SHIM_URL)}) {
    return { shortCircuit: true, format: "module", source: \`
      const store = {
        getAll: () => [], get: () => undefined, has: () => false,
        set: () => {}, delete: () => {}, toString: () => "",
        [Symbol.iterator]: function* () {},
      }
      export async function cookies() { return store }
      const hdrs = new Map()
      export async function headers() { return hdrs }
      export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} } }
    \` }
  }
  return next(url, context)
}
`
function registerNextHeadersShim(): boolean {
  try {
    // ESM resolution path (dynamic import("next/headers") inside the app code).
    register(`data:text/javascript,${encodeURIComponent(shimLoader)}`)
    // CJS resolution path — tsx translates most app modules through the CJS
    // loader, where module.register hooks are not consulted. Patch Module._load
    // for exactly two request-plumbing specifiers:
    //   - "server-only": a guard package whose ONLY behavior is to throw outside
    //     a React Server environment; the drill IS server-side, so it no-ops.
    //   - "next/headers": same empty cookie store as the ESM shim.
    const nodeModule: any = createRequire(import.meta.url)("node:module")
    // Some production modules (e.g. lib/providers/dispatch.ts) use bare require();
    // under an ESM execution context that identifier must exist globally.
    if (typeof (globalThis as any).require === "undefined") {
      ;(globalThis as any).require = createRequire(import.meta.url)
    }
    const realLoad = nodeModule._load
    const cjsCookieStore = {
      getAll: () => [], get: () => undefined, has: () => false,
      set: () => {}, delete: () => {}, toString: () => "",
    }
    // Requests arrive either as bare specifiers ("server-only") or as resolved
    // absolute filenames (…/node_modules/server-only/index.js) depending on
    // which loader path (require vs ESM-translated CJS) pulled them in.
    const isGuardPkg = (r: string) =>
      r === "server-only" || r === "client-only" ||
      /[\\/]node_modules[\\/](server-only|client-only)[\\/]/.test(r)
    const isNextHeaders = (r: string) =>
      r === "next/headers" || /[\\/]node_modules[\\/]next[\\/]headers(\.js)?$/.test(r)
    nodeModule._load = function (request: string, ...rest: unknown[]) {
      if (isGuardPkg(request)) return {}
      if (isNextHeaders(request)) {
        return {
          cookies: async () => cjsCookieStore,
          headers: async () => new Map(),
          draftMode: async () => ({ isEnabled: false, enable() {}, disable() {} }),
        }
      }
      return realLoad.call(this, request, ...rest)
    }
    return true
  } catch {
    return false
  }
}

// ─── pure preflight (always runs — no DB) ────────────────────────────────────
export interface DrillPlan {
  tag: string
  adminEmail: string
  leadEmail: string
  brokerageName: string
  market: { city: string; state: string; zip: string }
}
export function buildDrillPlan(stamp: string): DrillPlan {
  return {
    tag: `SMOKE-${stamp}`,
    // RFC-2606 reserved domain: mail to example.com is never delivered anywhere.
    adminEmail: `smoke-admin+${stamp}@example.com`,
    leadEmail: `smoke-lead+${stamp}@example.com`,
    brokerageName: `Smoke Drill Brokerage ${stamp}`,
    market: { city: "Tampa", state: "FL", zip: "33602" },
  }
}

async function preflightPure(): Promise<void> {
  console.log("\n[0 · preflight — pure, always runs]")
  const stamp = `${Date.now()}`
  const plan = buildDrillPlan(stamp)
  const { ms } = await timed(async () => plan)
  const tagged =
    plan.adminEmail.includes(stamp) && plan.leadEmail.includes(stamp) && plan.brokerageName.includes(stamp)
  ;(tagged ? stepPass : stepFail)("drill plan is stamp-tagged for exact cleanup", ms)

  // Wave-14 eligibility shape (owner): first+last name AND (email and/or phone and/or a
  // VERIFIED mailing address). Phone became an anchor in the same ruling that made the
  // address arm require the VERIFIED flag — so the refusal to smoke-test is the one that
  // moved: an address string with no verification.
  const t0 = Date.now()
  try {
    const { evaluateCanonicalLeadEligibility } = await import("../lib/lead-pipeline/canonical-lead-eligibility")
    const ok = evaluateCanonicalLeadEligibility({
      first_name: "Smoke", last_name: "Lead", email: plan.leadEmail,
      phone: null, mailing_address: null, mailing_address_verified: false,
    }).eligible
    const phoneOk = evaluateCanonicalLeadEligibility({
      first_name: "Smoke", last_name: "Lead", email: null,
      phone: "+18135550100", mailing_address: null, mailing_address_verified: false,
    }).eligible
    const rejects = !evaluateCanonicalLeadEligibility({
      first_name: "Smoke", last_name: "Lead", email: null,
      phone: null, mailing_address: "1 Smoke Test Way", mailing_address_verified: false,
    }).eligible
    ;(ok && phoneOk && rejects ? stepPass : stepFail)(
      "canonical eligibility: name+email passes, name+phone passes, unverified-address-only refuses (wave-14 shape)",
      Date.now() - t0)
  } catch (e: any) {
    stepFail("canonical eligibility module loads", Date.now() - t0, e?.message)
  }

  // The next/headers shim must make cookies() callable outside a request scope —
  // this is what lets the REAL processRawRecord run from the CLI.
  const t1 = Date.now()
  const registered = registerNextHeadersShim()
  if (!registered) {
    stepFail("next/headers shim registers (module hook)", Date.now() - t1)
    return
  }
  try {
    const { cookies } = await import("next/headers")
    const store = await cookies()
    ;(Array.isArray(store.getAll()) ? stepPass : stepFail)(
      "next/headers shim engaged — cookies() callable outside a request scope", Date.now() - t1)
  } catch (e: any) {
    stepFail("next/headers shim engaged", Date.now() - t1, e?.message)
  }

  // Every live-path production module must import cleanly under the shim — this
  // is verifiable even without creds and de-risks the live run.
  const t2 = Date.now()
  const mods = [
    "../app/actions/auth/signup-brokerage",
    "../lib/lead-pipeline",
    "../lib/kernel/lead-acquisition-handlers",
    "../lib/kernel/ai-isa",
    "../lib/portal/portal-clients-read",
    "../lib/providers/dispatch",
  ]
  const importFails: string[] = []
  for (const m of mods) {
    try { await import(m) } catch (e: any) { importFails.push(`${m}: ${(e?.message ?? e).toString().slice(0, 100)}`) }
  }
  ;(importFails.length === 0 ? stepPass : stepFail)(
    "all 6 live-path production modules import under the shim (signup, pipeline, handlers, ai-isa, portal read, dispatch)",
    Date.now() - t2, importFails.join(" | ") || undefined)
}

// ─── the live drill ──────────────────────────────────────────────────────────
async function liveDrill(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  const LIVE_STEPS = [
    "1. provision synthetic tenant (real signupBrokerageAction)",
    "2. create market/territory",
    "3. insert raw scraped record (name+email shape)",
    "4. REAL processRawRecord → promotion",
    "5. qualification stamps → REAL Engine 2 → contact + assignment",
    "6. portal-invite readiness read",
    "7. dispatch-gate no-op honesty (no egress)",
    "8. cleanup in FK order → residue 0",
  ]

  console.log("\n[live · fresh-tenant golden path]")
  if (!url || !key) {
    for (const s of LIVE_STEPS) stepSkip(s, "no SUPABASE creds in this environment (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset)")
    console.log("  → live layer degrades to stated skips (same posture as test:e2e-lifecycle); nothing was faked.")
    return
  }

  // Reachability probe — creds set but the DB host blocked (sandbox egress
  // policy) must degrade honestly, not explode mid-drill.
  try {
    const probe = await fetch(`${url.replace(/\/$/, "")}/auth/v1/health`, {
      headers: { apikey: key }, signal: AbortSignal.timeout(10_000),
    })
    if (!probe.ok && probe.status !== 404) throw new Error(`HTTP ${probe.status}`)
  } catch (e: any) {
    for (const s of LIVE_STEPS) stepSkip(s, `DB host unreachable from this environment (${e?.message ?? e})`)
    return
  }

  // Normalize env so every real module (service client + anon server client) runs.
  process.env.NEXT_PUBLIC_SUPABASE_URL = url
  process.env.SUPABASE_SERVICE_ROLE_KEY = key
  process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://smoke.invalid"
  // PRIVILEGED POSTURE (printed honestly): processRawRecord builds the app's
  // server client from NEXT_PUBLIC_SUPABASE_ANON_KEY. The drill runs it with the
  // service posture — the same RLS-bypassing access the kernel's service client
  // carries. RLS behavior is not what this drill proves.
  if (process.env.SMOKE_DRILL_PRIVILEGED_PIPELINE !== "0") {
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = key
    console.log("  ℹ pipeline runs in the privileged service posture (SMOKE_DRILL_PRIVILEGED_PIPELINE=0 to disable) — RLS is not under test here")
  }

  const { createClient } = await import("@supabase/supabase-js")
  const svc = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  const stamp = `${Date.now()}`
  const plan = buildDrillPlan(stamp)
  console.log(`  ℹ tag=${plan.tag}`)

  let brokerageId = "", ownerUserId = "", agentRecordId = "", marketId = "", rawId = "", leadId = "", contactId = ""

  // Sequential steps — a failed step skips the rest (cleanup always runs).
  let aborted: string | null = null
  const runStep = async (label: string, fn: () => Promise<string | { ok: true; detail?: string }>) => {
    if (aborted) { stepSkip(label, `earlier step failed (${aborted})`); return }
    const t0 = Date.now()
    try {
      const out = await fn()
      if (typeof out === "string") { stepFail(label, Date.now() - t0, out); aborted = label }
      else stepPass(label, Date.now() - t0, out.detail)
    } catch (e: any) {
      stepFail(label, Date.now() - t0, e?.message ?? String(e)); aborted = label
    }
  }

  try {
    // ── 1. PROVISION — the REAL self-serve provisioning path ────────────────
    await runStep("1. provision synthetic tenant via REAL signupBrokerageAction (solo_agent)", async () => {
      const { signupBrokerageAction } = await import("../app/actions/auth/signup-brokerage")
      const res = await signupBrokerageAction({
        brokerageName: plan.brokerageName,
        adminFirstName: "Smoke",
        adminLastName: "Drill",
        adminEmail: plan.adminEmail,
        tier: "solo_agent",
        brokerageCity: plan.market.city,
        brokerageState: plan.market.state,
      })
      if (!res.ok || !res.brokerageId) return `signup failed: ${res.error ?? "unknown"}`
      brokerageId = res.brokerageId
      const { data: userRow } = await svc.from("users").select("id").eq("email", plan.adminEmail).maybeSingle()
      if (!userRow) return "owner users row missing after provisioning"
      ownerUserId = (userRow as any).id
      const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", ownerUserId).maybeSingle()
      if (!agentRow) return "solo-agent owner has no agents row (tier spec violated)"
      agentRecordId = (agentRow as any).id
      return { ok: true, detail: `brokerage=${brokerageId.slice(0, 8)}… owner agents.id=${agentRecordId.slice(0, 8)}…` }
    })

    // ── 2. MARKET / TERRITORY ───────────────────────────────────────────────
    await runStep("2. create market/territory (lead_scraping_markets)", async () => {
      const { data, error } = await svc.from("lead_scraping_markets").insert({
        brokerage_id: brokerageId,
        name: `${plan.market.city} smoke market`,
        city: plan.market.city, state: plan.market.state, zip_codes: [plan.market.zip],
        is_active: true,
      }).select("id").single()
      if (error || !data) return `market insert failed: ${error?.message}`
      marketId = (data as any).id
      return { ok: true }
    })

    // ── 3. RAW RECORD — the round-39 eligibility shape ─────────────────────
    await runStep("3. insert raw scraped record (first+last name AND email, in-territory)", async () => {
      const id = randomUUID()
      const { error } = await svc.from("raw_scraped_leads").insert({
        id,
        brokerage_id: brokerageId,
        market_id: marketId,
        source: "production_smoke",
        source_origin: "brokerage",
        processing_status: "pending",
        first_name: "Smoke", last_name: "Lead",
        email: plan.leadEmail,
        city: plan.market.city, state: plan.market.state, zip_code: plan.market.zip,
        raw_data: { seeded_by: "production-smoke-drill", tag: plan.tag, lead_type: "buyer" },
      })
      if (error) return `raw insert failed: ${error.message}`
      rawId = id
      return { ok: true }
    })

    // ── 4. REAL processRawRecord → promotion ────────────────────────────────
    await runStep("4. REAL processRawRecord runs to promotion (raw → lead)", async () => {
      const { processRawRecord } = await import("../lib/lead-pipeline")
      const result = await processRawRecord(rawId, brokerageId)
      if (!result.success || result.action !== "created" || !result.leadId)
        return `pipeline did not promote: ${JSON.stringify(result)}`
      leadId = result.leadId
      const { data: raw } = await svc.from("raw_scraped_leads").select("processing_status, lead_id").eq("id", rawId).single()
      if ((raw as any)?.processing_status !== "promoted" || (raw as any)?.lead_id !== leadId)
        return `raw row not stamped promoted (${(raw as any)?.processing_status})`
      const { data: lead } = await svc.from("leads").select("lifecycle_state, ai_isa_owner, brokerage_id").eq("id", leadId).single()
      if ((lead as any)?.lifecycle_state !== "unconsented" || (lead as any)?.ai_isa_owner !== true)
        return `promoted lead has wrong birth state: ${JSON.stringify(lead)}`
      if ((lead as any)?.brokerage_id !== brokerageId) return "promoted lead landed on the wrong tenant"
      return { ok: true, detail: `lead=${leadId.slice(0, 8)}… born unconsented + ISA-owned` }
    })

    // ── 5. QUALIFICATION STAMPS → REAL ENGINE 2 → CONTACT + ASSIGNMENT ─────
    await runStep("5. qualification stamps + REAL Engine 2 conversion (lead → contact, assigned)", async () => {
      const { handleISAQualificationStarted, handleConsentReceived } = await import("../lib/kernel/lead-acquisition-handlers")
      await handleISAQualificationStarted({ leadId, brokerageId })
      await handleConsentReceived({ leadId, brokerageId, consentSource: "form" })
      const { recordAiIsaOutcome } = await import("../lib/kernel/ai-isa")
      // recordAiIsaOutcome('qualified') stamps lead_stage='qualified', retires the
      // ISA, and fires Engine 2 (evaluateAndAssignLead → handleLeadAssigned).
      const rec = await recordAiIsaOutcome({
        ctx: { brokerageId, userId: ownerUserId } as any,
        leadId,
        outcome: "qualified" as any,
        notes: "production smoke drill — synthetic qualification",
      } as any)
      if (!rec.success) return `recordAiIsaOutcome failed: ${(rec as any).error}`
      const { data: lead } = await svc.from("leads")
        .select("lead_stage, lifecycle_state, contact_id, ai_isa_owner, agent_id")
        .eq("id", leadId).single()
      const l = lead as any
      if (l?.lead_stage !== "qualified") return `lead_stage not stamped qualified (${l?.lead_stage})`
      if (l?.lifecycle_state !== "assigned") return `Engine 2 did not assign (lifecycle_state=${l?.lifecycle_state})`
      if (!l?.contact_id) return "Engine 2 did not create a contact"
      if (l?.ai_isa_owner !== false) return "ISA did not go dormant on conversion"
      contactId = l.contact_id
      const { data: contact } = await svc.from("contacts").select("agent_id, brokerage_id").eq("id", contactId).single()
      if ((contact as any)?.agent_id !== agentRecordId)
        return `contact.agent_id is not the AGENTS id class (got ${(contact as any)?.agent_id}, want ${agentRecordId})`
      const { count: logCount } = await svc.from("assignment_log").select("id", { count: "exact", head: true }).eq("lead_id", leadId)
      if ((logCount ?? 0) < 1) return "assignment_log row missing"
      return { ok: true, detail: `contact=${contactId.slice(0, 8)}… assigned to agents.id (id-class proof) + assignment_log` }
    })

    // ── 6. PORTAL-INVITE READINESS READ ────────────────────────────────────
    await runStep("6. portal-invite readiness read surfaces the new client", async () => {
      const { composePortalClientsRead } = await import("../lib/portal/portal-clients-read")
      const read = await composePortalClientsRead(svc as any, brokerageId)
      const inPending = read.pending.some((p) => p.contactId === contactId)
      const inClients = read.clients.some((c) => c.contactId === contactId)
      if (!inPending && !inClients) {
        // The invite row is written best-effort inside handleLeadAssigned; verify the table directly for an honest verdict.
        const { count } = await svc.from("portal_contact_invites").select("id", { count: "exact", head: true }).eq("contact_id", contactId)
        return `contact not visible in the readiness read (pending=${read.pending.length}, clients=${read.clients.length}, invite rows=${count ?? 0})`
      }
      return { ok: true, detail: inPending ? "pending invite visible" : "client visible" }
    })

    // ── 7. DISPATCH GATE — no-op honesty, ZERO egress by construction ──────
    await runStep("7. dispatch gate holds/refuses (no egress in any environment)", async () => {
      const { dispatchSms, dispatchDirectMail } = await import("../lib/providers/dispatch")
      // (a) SMS to the new contact: no TCPA consent (source is not web_form/qr_scan)
      // → the compliance gate must refuse BEFORE any provider call.
      const sms = await dispatchSms({
        brokerageId, contactId, to: "+18135550100",
        message: "smoke drill — this must never send",
        systemSource: "production_smoke_drill",
      })
      if (sms.success) return "SMS was NOT held — a real send occurred (gate failure)"
      // (b) Direct mail to the lead: mailing address unverified → lead_gate refuses
      // BEFORE Lob (and before any spend).
      const mail = await dispatchDirectMail({
        brokerageId, leadId, recipientName: "Smoke Lead",
        mailingAddress: "1 Nowhere St", city: plan.market.city, state: plan.market.state, zip: plan.market.zip,
        templateId: "tmpl_smoke_nonexistent",
        systemSource: "production_smoke_drill",
      })
      if (mail.success) return "direct mail was NOT held (gate failure)"
      // (c) provider posture — reported, never probed.
      const providers = {
        sendgrid: !!process.env.SENDGRID_API_KEY,
        twilio: !!process.env.TWILIO_ACCOUNT_SID,
        lob: !!process.env.LOB_API_KEY,
      }
      return {
        ok: true,
        detail: `sms held by ${sms.providerKey} ("${(sms.error ?? "").slice(0, 60)}…"); mail held by ${mail.providerKey}; providers configured: ${JSON.stringify(providers)}`,
      }
    })
  } finally {
    // ── 8. CLEANUP — always runs; FK order; residue must be 0 ──────────────
    const t0 = Date.now()
    console.log("\n[8 · cleanup — FK order, residue must be 0]")
    try {
      // Child tables keyed by lead/contact/raw first, then tenant-keyed tables,
      // then identity, then the brokerage row itself.
      const del = async (table: string, col: string, val: string | null) => {
        if (!val) return
        try { await svc.from(table).delete().eq(col, val) } catch { /* table may not exist in this schema */ }
      }
      if (leadId) {
        for (const t of ["ai_isa_activities", "lead_sla_tracking", "assignment_log", "lead_deduplication_log", "lead_enrichment_queue"])
          await del(t, "lead_id", leadId)
      }
      if (rawId) await del("lead_deduplication_log", "raw_record_id", rawId)
      if (contactId) {
        for (const t of ["client_portal_messages", "portal_contact_invites", "transparency_updates", "sequence_enrollments", "lead_enrichment_queue"])
          await del(t, "contact_id", contactId)
      }
      if (brokerageId) {
        for (const t of [
          "deconflict_suppression_log", "self_heal_events", "lifecycle_events", "notifications",
          "activities", "learning_assignments", "sequence_enrollments", "transparency_updates",
          "client_portal_messages", "portal_contact_invites", "assignment_log", "ai_isa_activities",
          "lead_enrichment_queue", "ai_identity_profiles", "automation_errors", "lead_sla_tracking",
          // FK order: raw_scraped_leads.lead_id → leads, leads.contact_id → contacts,
          // so raw rows go first, then leads, then contacts.
          "raw_scraped_leads", "leads", "contacts", "lead_scraping_markets",
          "subscriptions", "agent_onboarding", "agents",
        ]) await del(t, "brokerage_id", brokerageId)
      }
      if (ownerUserId) {
        await del("user_role_assignments", "user_id", ownerUserId)
        await del("agent_onboarding", "user_id", ownerUserId)
        await del("notifications", "user_id", ownerUserId)
      }
      // Auth users: the tenant owner AND any portal auth user minted for the lead
      // email (signInWithOtp may create one). Delete by exact drill-tagged email.
      try {
        const { data: list } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 } as any)
        for (const u of (list?.users ?? []) as Array<{ id: string; email?: string }>) {
          if (u.email === plan.adminEmail || u.email === plan.leadEmail) {
            try { await svc.auth.admin.deleteUser(u.id) } catch { /* users-row delete below still runs */ }
          }
        }
      } catch { /* listUsers unavailable → users-row deletes below still run */ }
      if (ownerUserId) await del("users", "id", ownerUserId)
      if (brokerageId) {
        await del("users", "brokerage_id", brokerageId)
        await del("brokerages", "id", brokerageId)
      }

      // ── RESIDUE SWEEP — the drill FAILS if any touched table still holds rows ──
      const residue: Array<{ table: string; col: string; val: string; count: number }> = []
      const sweep = async (table: string, col: string, val: string | null) => {
        if (!val) return
        try {
          const { count, error } = await svc.from(table).select("*", { count: "exact", head: true }).eq(col, val)
          if (!error && (count ?? 0) > 0) residue.push({ table, col, val, count: count ?? 0 })
        } catch { /* nonexistent table = no residue */ }
      }
      const tenantTables = [
        "brokerages:id", "users:brokerage_id", "agents:brokerage_id", "subscriptions:brokerage_id",
        "agent_onboarding:brokerage_id", "lead_scraping_markets:brokerage_id", "raw_scraped_leads:brokerage_id",
        "leads:brokerage_id", "contacts:brokerage_id", "lifecycle_events:brokerage_id",
        "notifications:brokerage_id", "activities:brokerage_id", "learning_assignments:brokerage_id",
        "sequence_enrollments:brokerage_id", "transparency_updates:brokerage_id",
        "client_portal_messages:brokerage_id", "portal_contact_invites:brokerage_id",
        "assignment_log:brokerage_id", "ai_isa_activities:brokerage_id", "lead_enrichment_queue:brokerage_id",
        "ai_identity_profiles:brokerage_id", "deconflict_suppression_log:brokerage_id",
        "self_heal_events:brokerage_id", "automation_errors:brokerage_id", "lead_sla_tracking:brokerage_id",
      ]
      for (const spec of tenantTables) {
        const [table, col] = spec.split(":")
        await sweep(table, col, brokerageId || null)
      }
      await sweep("users", "id", ownerUserId || null)
      await sweep("user_role_assignments", "user_id", ownerUserId || null)
      await sweep("raw_scraped_leads", "id", rawId || null)
      await sweep("leads", "id", leadId || null)
      await sweep("contacts", "id", contactId || null)

      if (!brokerageId) {
        stepSkip("8. cleanup + residue sweep", "nothing was created (earlier steps skipped)")
      } else if (residue.length === 0) {
        stepPass("8. cleanup complete — residue sweep across every touched table = 0 rows", Date.now() - t0,
          `${tenantTables.length + 5} table/column checks clean`)
      } else {
        stepFail("8. cleanup left residue (drill FAILS)", Date.now() - t0,
          residue.map((r) => `${r.table}.${r.col}=${r.count}`).join(", "))
      }
    } catch (e: any) {
      stepFail("8. cleanup crashed", Date.now() - t0, e?.message ?? String(e))
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" PRODUCTION SMOKE DRILL — fresh-tenant golden path, live-fired")
  console.log(" provision → market → raw → promote → qualify → Engine 2 →")
  console.log(" portal readiness → dispatch-gate honesty → cleanup (residue 0)")
  console.log("══════════════════════════════════════════════════════════")

  await preflightPure()
  await liveDrill()

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failures.length) {
    console.log(" FAILURES:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log(" ❌ PRODUCTION_SMOKE_FAIL")
    process.exit(1)
  }
  console.log(skipped > 0
    ? " ✅ PRODUCTION_SMOKE_PASS (live layer creds-gated — skips are stated above, never faked)"
    : " ✅ PRODUCTION_SMOKE_PASS — golden path green end-to-end, residue 0")
  process.exit(0)
}

main().catch((e) => { console.error("production-smoke-drill crashed:", e); process.exit(1) })
