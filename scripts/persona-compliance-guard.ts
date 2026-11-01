/**
 * scripts/persona-compliance-guard.ts — `npm run test:persona-compliance`
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 148, LANE 148C — owner ruling 1 (2026-11-01), verbatim: "the read of protected or prohibited can be used to determine the
 * person's persona so users can create ads and posts, etc. around that persona. The admin, platform, agent, team lead, broker,
 * compliance, support, etc. should be able to read."
 *
 * WHAT IS EXECUTED (on the in-memory client, through the REAL modules — only `server-only`, the service-client factory and the
 * model are stubbed; the model is injected per case so a HOSTILE answer can be fed to the firewall):
 *   1  the READER: every role the owner named reads through the role × purpose × scope matrix — admitted where the matrix says,
 *      refused where it does not, tenant-bound (no session tenant / another tenant refused), scope-bound (an agent's other-agent
 *      contact, a team lead's off-team contact refused), justification-bound (platform + support), data-rights + field-minimised
 *      per purpose — and EVERY read and refusal is on the ledger with its purpose and role class, never a value.
 *   2  a NEEDS-BASED persona: derivePersona studies stated / behavioural / inferred evidence and the research layer; a hostile
 *      model answer (unknown need, research-cited need, "perfect for families", "top schools", "church", "spanish-speaking", a
 *      research VALUE) is cut element by element; the persisted row keeps the five layers apart and holds no research value; the
 *      needs-based persona is written to contacts.contact_persona and a derived-persona audience on it passes every gate.
 *   3  a PROTECTED PROXY NEVER REACHES AN AUDIENCE: research-only evidence yields no audience-eligible persona and no
 *      contact_persona write; a staff-entered protected persona is never mapped or overwritten; a derived-persona audience on a
 *      protected persona is refused; proxy words in an audience rule are refused at SELECTION.
 *   4  DELIVERY: proxy interests, ZIP targeting (Meta + Google), Google age / gender narrowing and an ungated targeted audience
 *      are violations; the launch assembler re-gates the targeted slot (look-alike, proxy rule, raw platform id refused; a
 *      governed needs-based audience delivered).
 *   5  census (stripped source) + the migrations agree with the code + the prompt carries every section the standard requires.
 * Every absence has a POSITIVE CONTROL (the finder is shown to see the thing it counts).
 *
 * BLIND SPOTS (published): the model is stubbed (its real output quality is not measured here — the firewall that judges any
 * output is); memSupabase enforces no CHECK (m913's CHECKs are proven equal to the code on text); the server actions and the
 * panel are proven by source census (their session gate needs the live app); Meta / Google receive nothing (the payload is
 * built and validated, never sent); the proxy vocabulary is English and finite — a novel proxy word passes until it is added.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments, stringLiterals } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

const G = globalThis as any
G.__148C = { svc: null as MemClient | null }
const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__148C.svc",
  "@/lib/supabase/server": "export const createClient = async () => globalThis.__148C.svc",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/ai/models": "export async function generateTextRouted(){ throw new Error('no model in the proof — inject one') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const ROOT = process.cwd()
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))
const rows = (c: MemClient, t: string) => (c.tables[t] ?? []) as any[]

const B = "00000000-0000-4000-8000-0000000000b1"
const B2 = "00000000-0000-4000-8000-0000000000b2"
const AG1 = "00000000-0000-4000-8000-00000000a001"
const AG2 = "00000000-0000-4000-8000-00000000a002"
const TEAM = "00000000-0000-4000-8000-00000000c001"
const C1 = "00000000-0000-4000-8000-000000000c01" // needs-based: relocation said + search behaviour, protected research present
const C2 = "00000000-0000-4000-8000-000000000c02" // research-only (no stated / behavioural evidence)
const C3 = "00000000-0000-4000-8000-000000000c03" // staff-entered protected persona (senior)
const C4 = "00000000-0000-4000-8000-000000000c04" // another agent's contact, on no team
const NOW = new Date("2026-11-01T12:00:00Z")
const RECENT = "2026-10-25T12:00:00Z"
const PROTECTED_VALUES = ["Catholic", "R-Value-Modeled", "65-74", "married", "Spanish"]

function seed(): MemClient {
  const stamp = (source: string) => ({ source, capability: "person.enrich", retrievedAt: "2026-10-01T00:00:00Z", matchConfidence: "0.9", purpose: "enrichment" })
  return memSupabase({
    brokerages: [{ id: B, name: "Alpha Realty" }, { id: B2, name: "Beta Homes" }],
    users: [],
    agents: [{ id: AG1, brokerage_id: B, user_id: "u-agent" }, { id: AG2, brokerage_id: B, user_id: "u-agent2" }, { id: "00000000-0000-4000-8000-00000000a0tl", brokerage_id: B, user_id: "u-tl" }],
    teams: [{ id: TEAM, brokerage_id: B, team_lead_id: "u-tl", name: "North" }],
    contacts: [
      { id: C1, brokerage_id: B, agent_id: AG1, team_id: TEAM, first_name: "Rae", contact_type: "buyer", contact_persona: null, home_owner_status: "renter",
        gender: "female", marital_status: "married", age_range: "65-74", email: "rae@example.com", preferred_language: "en",
        enrichment_profile: { field_provenance: { gender: stamp("batchdata"), marital_status: stamp("peopledata"), age_range: stamp("peopledata") } } },
      { id: C2, brokerage_id: B, agent_id: AG1, team_id: TEAM, first_name: "Sam", contact_type: null, contact_persona: null, age_range: "65-74", marital_status: "married",
        enrichment_profile: { field_provenance: { age_range: stamp("peopledata"), marital_status: stamp("peopledata") } } },
      { id: C3, brokerage_id: B, agent_id: AG1, team_id: TEAM, first_name: "Lee", contact_persona: "senior", enrichment_profile: { field_provenance: { contact_persona: { source: "staff", retrievedAt: "2026-09-01T00:00:00Z" } } } },
      { id: C4, brokerage_id: B, agent_id: AG2, team_id: null, first_name: "Kim", contact_persona: null, gender: "male", enrichment_profile: {} },
    ],
    protected_research_attributes: [
      { id: "pr-1", brokerage_id: B, contact_id: C1, provider: "versium", capability: "person.online_audience", source_field: "Religion", attribute_value: "Catholic", attribute_class: "religion", basis: "vendor_modeled", match_confidence: "household", retrieved_at: "2026-09-01T00:00:00Z" },
      { id: "pr-2", brokerage_id: B, contact_id: C1, provider: "versium", capability: "person.online_audience", source_field: "Language", attribute_value: "Spanish", attribute_class: "language", basis: "self_identified", match_confidence: "individual", retrieved_at: "2026-09-01T00:00:00Z" },
      { id: "pr-3", brokerage_id: B, contact_id: C1, provider: "mystery_vendor", capability: "x", source_field: "Ethnicity", attribute_value: "R-Value-Modeled", attribute_class: "race_color_national_origin", basis: "vendor_modeled", match_confidence: null, retrieved_at: "2026-09-01T00:00:00Z" },
      { id: "pr-4", brokerage_id: B, contact_id: C2, provider: "versium", capability: "person.online_audience", source_field: "Children", attribute_value: "3", attribute_class: "familial_status", basis: "vendor_modeled", match_confidence: "household", retrieved_at: "2026-09-01T00:00:00Z" },
    ],
    property_preferences: [{ id: "pp-1", brokerage_id: B, contact_id: C1, inferred_cities: ["Austin"], inferred_must_have_features: ["acreage"], criteria_provenance: {
      cities: { source: "said", value: ["Austin"], evidence: "we're relocating to Austin for my job", channel: "voice", at: RECENT, reason: null },
      mustHaveFeatures: { source: "said", value: ["acreage"], evidence: "we want an acre or two", channel: "voice", at: RECENT, reason: null } } }],
    saved_properties: [{ id: "sp-1", brokerage_id: B, contact_id: C1, saved_at: RECENT, dismissed: false }, { id: "sp-2", brokerage_id: B, contact_id: C1, saved_at: RECENT, dismissed: false }],
    showing_requests: [{ id: "sr-1", brokerage_id: B, contact_id: C1, created_at: RECENT, status: "requested" }],
    client_detailed_personas: [], contact_consent_events: [], person_identities: [], person_identity_evidence: [], agent_action_ledger: [],
    facebook_custom_audiences: [], ad_campaigns: [], ad_creative_variations: [],
  }, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } })
}

async function main() {
  const store = await import("../lib/enrichment/protected-research-store")
  const layers = await import("../lib/contacts/persona-layers")
  const builder = await import("../lib/contacts/persona-builder")
  const basis = await import("../lib/ads/audience-persona-basis")
  const pcs = await import("../lib/lead-governance/protected-class-signals")
  const proxy = await import("../lib/compliance-rules/audience-compliance")
  const payload = await import("../lib/ads/connectors/ad-payload")
  const fh = await import("../lib/compliance-rules/fair-housing-patterns")

  // ── 1 ──────────────────────────────────────────────────────────────────────
  console.log("\n[1 — the reader: every named role, through role × purpose × scope; every read and refusal logged with its purpose]")
  const db = seed()
  G.__148C.svc = db
  const ledger = () => rows(db, "agent_action_ledger")
  type Case = { name: string; role: string; req: Parameters<typeof store.readProtectedAttributes>[1]; expect: "ok" | string }
  const tenantSeat = (userId: string, userType: string, brokerageId: string | null = B) => ({ userId, userType, brokerageId })
  const cases: Case[] = [
    { name: "broker reads for research (tenant scope)", role: "broker", req: { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-broker", "broker") }, expect: "ok" },
    { name: "compliance officer reads for compliance_audit", role: "compliance", req: { brokerageId: B, contactId: C1, purpose: "compliance_audit", actor: tenantSeat("u-co", "compliance_officer") }, expect: "ok" },
    { name: "tenant admin reads for persona_derivation", role: "tenant_admin", req: { brokerageId: B, contactId: C1, purpose: "persona_derivation", actor: tenantSeat("u-admin", "admin") }, expect: "ok" },
    { name: "tenant admin is NOT a research reader (least privilege by purpose)", role: "tenant_admin", req: { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-admin", "admin") }, expect: "role_not_admitted" },
    { name: "agent reads their OWN contact for persona_derivation (assigned scope)", role: "agent", req: { brokerageId: B, contactId: C1, purpose: "persona_derivation", actor: tenantSeat("u-agent", "agent") }, expect: "ok" },
    { name: "agent reads ANOTHER agent's contact → out_of_scope", role: "agent", req: { brokerageId: B, contactId: C4, purpose: "persona_derivation", actor: tenantSeat("u-agent", "agent") }, expect: "out_of_scope" },
    { name: "agent is NOT a research reader", role: "agent", req: { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-agent", "agent") }, expect: "role_not_admitted" },
    { name: "team lead reads a TEAM contact for customer_service (team scope)", role: "team_lead", req: { brokerageId: B, contactId: C1, purpose: "customer_service", actor: tenantSeat("u-tl", "team_lead") }, expect: "ok" },
    { name: "team lead reads an OFF-TEAM contact → out_of_scope", role: "team_lead", req: { brokerageId: B, contactId: C4, purpose: "customer_service", actor: tenantSeat("u-tl", "team_lead") }, expect: "out_of_scope" },
    { name: "tenant support investigates WITH a case reference", role: "tenant_support", req: { brokerageId: B, contactId: C1, purpose: "support_investigation", purposeNote: "ticket SUP-1042: wrong language on portal", actor: tenantSeat("u-sup", "support") }, expect: "ok" },
    { name: "tenant support WITHOUT a case reference → justification_required", role: "tenant_support", req: { brokerageId: B, contactId: C1, purpose: "support_investigation", actor: tenantSeat("u-sup", "support") }, expect: "justification_required" },
    { name: "platform admin reads for compliance_audit WITH a justification (any tenant)", role: "platform_admin", req: { brokerageId: B, contactId: C1, purpose: "compliance_audit", purposeNote: "HUD inquiry 2026-11 audience audit", actor: { userId: "u-padmin", userType: null, platformRole: "admin", brokerageId: null } }, expect: "ok" },
    { name: "platform admin WITHOUT a justification → justification_required", role: "platform_admin", req: { brokerageId: B, contactId: C1, purpose: "research", actor: { userId: "u-padmin", userType: null, platformRole: "superadmin", brokerageId: null } }, expect: "justification_required" },
    { name: "platform support reads for customer_service WITH a justification", role: "platform_support", req: { brokerageId: B, contactId: C1, purpose: "customer_service", purposeNote: "escalated chat: accessibility request", actor: { userId: "u-psup", userType: null, platformRole: "support", brokerageId: null } }, expect: "ok" },
    { name: "platform MARKETING staff read nothing (marketing is the restricted act)", role: "platform_marketing", req: { brokerageId: B, contactId: C1, purpose: "research", purposeNote: "campaign planning for Q1 season", actor: { userId: "u-pmkt", userType: null, platformRole: "marketing", brokerageId: null } }, expect: "role_not_admitted" },
    { name: "the autonomous study (system) reads for persona_derivation, tenant-bound", role: "system", req: { brokerageId: B, contactId: C1, purpose: "persona_derivation", actor: { userId: null, userType: null, brokerageId: B, systemSource: "enrichment_pipeline" } }, expect: "ok" },
    { name: "the autonomous study WITHOUT its tenant → tenant_unverified", role: "system", req: { brokerageId: B, contactId: C1, purpose: "persona_derivation", actor: { userId: null, userType: null, systemSource: "enrichment_pipeline" } }, expect: "tenant_unverified" },
    { name: "a tenant seat with NO session brokerage → tenant_unverified (never bound from the request)", role: "broker", req: { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-broker", "broker", null) }, expect: "tenant_unverified" },
    { name: "a seat of ANOTHER tenant → not_in_tenant", role: "broker", req: { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-broker2", "broker", B2) }, expect: "not_in_tenant" },
    { name: "ad_audience is PROHIBITED for every seat (even the broker)", role: "broker", req: { brokerageId: B, contactId: C1, purpose: "ad_audience", actor: tenantSeat("u-broker", "broker") }, expect: "prohibited_purpose" },
    { name: "steering is PROHIBITED for platform staff too", role: "platform_admin", req: { brokerageId: B, contactId: C1, purpose: "steering", purposeNote: "this is a long justification", actor: { userId: "u-padmin", userType: null, platformRole: "admin", brokerageId: null } }, expect: "prohibited_purpose" },
  ]
  const logged: Array<{ name: string; ok: boolean }> = []
  for (const k of cases) {
    const before = ledger().length
    const r = await store.readProtectedAttributes(db, k.req, { now: NOW })
    const outcome = r.ok ? "ok" : r.refused
    check(`${k.name} → ${k.expect}`, outcome === k.expect, `got ${outcome}${r.ok ? "" : ` (${r.reason})`}`)
    const row = ledger()[ledger().length - 1]
    const isLogged = ledger().length === before + 1 && row?.detail?.purpose === k.req.purpose && row?.detail?.role_class === (k.role === "platform_marketing" ? null : k.role)
      && row?.action === (r.ok ? "research.protected_attribute.read" : "research.protected_attribute.refuse") && r.evidenced === true
    logged.push({ name: k.name, ok: isLogged })
  }
  const unlogged = logged.filter((l) => !l.ok)
  check(`EVERY one of the ${cases.length} reads / refusals is ON THE LEDGER with its purpose and role class (evidenced)`, unlogged.length === 0, unlogged.map((u) => u.name).join("; "))
  const rolesSeen = new Set(cases.map((c) => c.role))
  check("every role the owner named was exercised (admin, platform, agent, team lead, broker, compliance, support + the autonomous study)",
    ["tenant_admin", "platform_admin", "platform_support", "agent", "team_lead", "broker", "compliance", "tenant_support", "system"].every((r) => rolesSeen.has(r)))
  // POSITIVE CONTROL for the logging check: the same predicate on a fake ledger with a missing row / a missing purpose fails.
  const fakeOk = (l: any[], before: number, purpose: string) => l.length === before + 1 && l[l.length - 1]?.detail?.purpose === purpose
  check("POSITIVE CONTROL — the logging check sees a missing row and a missing purpose", !fakeOk([{ detail: { purpose: "research" } }], 1, "research") && !fakeOk([{ detail: {} }], 0, "research") && fakeOk([{ detail: { purpose: "research" } }], 0, "research"))
  check("the ledger carries field NAMES / purposes / justifications only — never a protected value",
    PROTECTED_VALUES.every((v) => !JSON.stringify(ledger()).includes(`"${v}"`)) && ledger().some((l) => l.detail?.justification === "ticket SUP-1042: wrong language on portal"))
  const cs = await store.readProtectedAttributes(db, { brokerageId: B, contactId: C1, purpose: "customer_service", actor: tenantSeat("u-tl", "team_lead") }, { now: NOW })
  check("customer_service is FIELD-MINIMISED: only the self-identified language comes back; the modeled religion, the unclassified ethnicity and the demographic columns are NAMED in withheld, never valued",
    cs.ok && cs.attributes.length === 1 && cs.attributes[0].field === "Language" && cs.withheld.some((w) => w.field === "Religion") && cs.withheld.some((w) => w.field === "gender") && JSON.stringify(cs.withheld).indexOf("Catholic") < 0, JSON.stringify(cs.ok ? { a: cs.attributes.map((a) => a.field), w: cs.withheld.map((w) => w.field) } : cs))
  const pd = await store.readProtectedAttributes(db, { brokerageId: B, contactId: C1, purpose: "persona_derivation", actor: tenantSeat("u-agent", "agent") }, { now: NOW })
  const rs = await store.readProtectedAttributes(db, { brokerageId: B, contactId: C1, purpose: "research", actor: tenantSeat("u-broker", "broker") }, { now: NOW })
  check("DATA RIGHTS per purpose: an unclassified-source value is withheld from persona_derivation but read for research (the audit sees everything held)",
    pd.ok && rs.ok && !pd.attributes.some((a) => a.field === "Ethnicity") && pd.withheld.some((w) => w.field === "Ethnicity" && /unclassified/.test(w.reason)) && rs.attributes.some((a) => a.field === "Ethnicity"))
  check("the matrix is DERIVED for research from the named-subtraction roster (broker tier + compliance), and platform marketing appears in no row",
    store.PROTECTED_RESEARCH_READER_USER_TYPES.has("broker") && store.PROTECTED_RESEARCH_READER_USER_TYPES.has("compliance_officer") && !store.PROTECTED_RESEARCH_READER_USER_TYPES.has("team_lead")
    && Object.values(store.PROTECTED_READ_MATRIX).every((row) => !("platform_marketing" in row)))
  console.log("\n  ROLE × PURPOSE MATRIX (rendered from PROTECTED_READ_MATRIX):")
  const roleCols = ["agent", "team_lead", "broker", "tenant_admin", "compliance", "tenant_support", "platform_support", "platform_admin", "system"] as const
  console.log(`    | purpose | ${roleCols.join(" | ")} |`)
  for (const [p, row] of Object.entries(store.PROTECTED_READ_MATRIX)) console.log(`    | ${p} | ${roleCols.map((r) => (row as Record<string, string>)[r] ?? "—").join(" | ")} |`)

  // ── 2 ──────────────────────────────────────────────────────────────────────
  console.log("\n[2 — a NEEDS-BASED persona: the study, a hostile model answer cut element by element, five layers persisted apart]")
  const hostile = JSON.stringify({
    serviceProfile: { summary: "Rae is Catholic and prefers calm, step-by-step explanations.", howToHelp: ["Send a relocation checklist with commute options", "Offer weekday video tours"], openQuestions: ["Which part of town is closest to work?"] },
    marketingPersona: {
      headline: "Retirees relocating near a church",
      needs: [
        { need: "senior_living", confidence: 0.9, evidenceRefs: ["E2-1"], why: "age band" },
        { need: "downsizing", confidence: 0.95, evidenceRefs: ["R1-1"], why: "modeled household" },
        { need: "relocation_research", confidence: 0.99, evidenceRefs: ["E2-1"], why: "Perfect for families moving here" },
        { need: "acreage_and_land", confidence: 0.8, evidenceRefs: ["E2-3"], why: "said they want an acre or two" },
      ],
      messaging: { angles: ["Top schools near your new home", "A neighbourhood-by-neighbourhood guide for newcomers"], educationTopics: ["Comparing neighbourhoods from a distance"], tone: "warm and practical",
        platformHooks: { facebook: "Perfect for families like yours", instagram: "New to Austin? Compare neighbourhoods before you land.", linkedin: "Relocating for work? The questions to ask first.", tiktok: "Spanish-speaking buyers welcome" } },
    },
    escalate: null,
  })
  const agentSeat = { userId: "u-agent", userType: "agent", brokerageId: B }
  const res1 = await builder.derivePersona(db, { brokerageId: B, contactId: C1, actor: agentSeat, agentId: AG1 }, { now: NOW, generate: async () => hostile })
  const p1 = res1.persona
  const row1 = rows(db, "client_detailed_personas").find((r) => r.contact_id === C1)
  check("the study ran, persisted, and its marketing layer passed the final independent check", res1.ok && res1.written && res1.marketingSafe && !!p1, JSON.stringify({ ok: res1.ok, err: res1.error, notes: res1.notes }))
  const needs1 = (p1?.marketing.needs ?? []).map((n) => n.need)
  check("needs come ONLY from the vocabulary and ONLY with Layer 2–4 evidence: the unknown need and the research-cited need are CUT; relocation + acreage stand",
    needs1.includes("relocation_research") && needs1.includes("acreage_and_land") && !needs1.includes("downsizing" as never) && !(needs1 as string[]).includes("senior_living") && (p1?.marketing.needs ?? []).every((n) => n.evidenceRefs.every((id) => !/^R1-/.test(id))), JSON.stringify(p1?.marketing.needs))
  const refused1 = p1?.firewall.refused ?? []
  check("every hostile element is recorded as a firewall refusal (headline, the families 'why', the schools angle, both hooks, the research value, the unknown + research-cited needs)",
    ["marketingPersona.headline", "marketingPersona.needs[2].why", "marketingPersona.messaging.angles[0]", "marketingPersona.messaging.platformHooks.facebook", "marketingPersona.messaging.platformHooks.tiktok", "serviceProfile.summary", "marketingPersona.needs[0]", "marketingPersona.needs[1]"].every((path) => refused1.some((r) => r.path === path)),
    JSON.stringify(refused1.map((r) => r.path)))
  const marketingText = JSON.stringify(p1?.marketing ?? {})
  check("no protected word, proxy or copy-pattern survives anywhere in the marketing layer (headline, angles, hooks, whys)",
    !/church|famil(y|ies)\b|school|spanish|retiree|catholic/i.test(marketingText.replace(/"avoid":\[[^\]]*\]/, "")), marketingText.slice(0, 400))
  check("the persisted row keeps the FIVE layers apart (stated / behaviour / inferred / research NAMES / marketing) and the legacy columns carry the marketing-safe layer",
    !!row1 && Array.isArray(row1.stated_needs) && row1.stated_needs.length >= 2 && Array.isArray(row1.behavioural_evidence) && row1.behavioural_evidence.length >= 1 && Array.isArray(row1.inferred_interests)
    && Array.isArray(row1.research_layer?.fields) && row1.research_layer.fields.length >= 1 && row1.marketing_safe === true && row1.marketing_persona?.campaignPersona === "relocated"
    && Array.isArray(row1.buying_triggers) && row1.buying_triggers.includes("relocation_research") && JSON.stringify(row1.demographics) === "{}")
  check("NO research VALUE is persisted anywhere on the persona row (the research layer is names / classes / rights only)",
    !!row1 && PROTECTED_VALUES.every((v) => !JSON.stringify(row1).includes(v)) && row1.research_layer.fields.every((f: Record<string, unknown>) => !("value" in f)), PROTECTED_VALUES.filter((v) => JSON.stringify(row1 ?? {}).includes(v)).join(","))
  check("the legacy pain points are needs-based (no familial / marital proxy such as school_district_constraints)", !!row1 && !row1.pain_points.some((p: string) => /school|household|famil(y|ies)\b|child/.test(p)) && row1.pain_points.includes("unfamiliar_market"), JSON.stringify(row1?.pain_points))
  const c1 = rows(db, "contacts").find((c) => c.id === C1)
  check("the needs-based persona reaches the EXISTING audience path: contacts.contact_persona = relocated (was empty), recorded as the study's own write", c1?.contact_persona === "relocated" && res1.contactPersonaWritten === "relocated" && row1?.derivation?.wrote_contact_persona === "relocated")
  check("the study and its research read are both ledgered (contact.persona.derive executed; research read with purpose persona_derivation)",
    ledger().some((l) => l.action === "contact.persona.derive" && l.status === "executed") && ledger().some((l) => l.action === "research.protected_attribute.read" && l.detail?.purpose === "persona_derivation" && l.detail?.role_class === "agent"))
  const derivedRule = { type: "persona_segment", basis: "derived_persona", filters: { personas: ["relocated"] } }
  const ruleOk = basis.resolveAudiencePersonaBasis(derivedRule)
  let defineThrew = false
  try { pcs.assertAudienceSegmentationAllowed(derivedRule, "Persona — Relocation research"); basis.assertAudiencePersonaBasis(derivedRule, "Persona — Relocation research") } catch { defineThrew = true }
  check("POSITIVE — a derived-persona custom audience on the needs-based persona passes BOTH selection gates (define + populate run the same two)", ruleOk.ok && !defineThrew && pcs.protectedClassSegmentationIn(derivedRule).length === 0)
  const again = await builder.derivePersona(db, { brokerageId: B, contactId: C1, actor: agentSeat, agentId: AG1 }, { now: NOW, generate: async () => "not json at all" })
  check("a model that answers with no JSON leaves the DETERMINISTIC floor standing (still needs-based, still safe) and its own prior write is updatable",
    again.ok && again.persona?.source === "deterministic" && again.marketingSafe && (again.persona?.marketing.needs ?? []).some((n) => n.need === "relocation_research") && rows(db, "client_detailed_personas").filter((r) => r.contact_id === C1).length === 1)

  // ── 3 ──────────────────────────────────────────────────────────────────────
  console.log("\n[3 — a PROTECTED PROXY never reaches an audience]")
  const proxyModel = JSON.stringify({ serviceProfile: { summary: "Keep it simple." }, marketingPersona: { headline: "Downsizing", needs: [{ need: "downsizing", confidence: 0.9, evidenceRefs: ["R1-1"], why: "age band" }, { need: "more_space", confidence: 0.9, evidenceRefs: ["R1-2"], why: "children" }], messaging: {} }, escalate: null })
  const res2 = await builder.derivePersona(db, { brokerageId: B, contactId: C2, actor: agentSeat, agentId: AG1 }, { now: NOW, generate: async () => proxyModel })
  const c2 = rows(db, "contacts").find((c) => c.id === C2)
  check("research-ONLY evidence (age, marital status, modeled children) yields NO audience-eligible persona: both research-cited needs are cut",
    res2.ok && !(res2.persona?.marketing.audienceEligible) && !(res2.persona?.marketing.needs ?? []).some((n) => n.need === "downsizing" || n.need === "more_space"), JSON.stringify(res2.persona?.marketing))
  check("…so contacts.contact_persona is NOT written — the person is in no persona audience", c2?.contact_persona === null && res2.contactPersonaWritten === null)
  check("…and the study escalates for a human to ASK (insufficient_evidence) rather than guess", res2.persona?.escalate === "insufficient_evidence")
  const res3 = await builder.derivePersona(db, { brokerageId: B, contactId: C3, actor: agentSeat, agentId: AG1 }, { now: NOW, generate: async () => "{}" })
  const c3 = rows(db, "contacts").find((c) => c.id === C3)
  check("a STAFF-ENTERED protected persona (senior) is never mapped to a marketing need and never overwritten",
    res3.ok && (res3.persona?.firewall.withheldFromMarketing ?? []).some((w) => /senior/.test(w)) && c3?.contact_persona === "senior" && res3.persona?.marketing.campaignPersona === null)
  const derivedSenior = basis.resolveAudiencePersonaBasis({ type: "persona_segment", basis: "derived_persona", filters: { personas: ["senior"] } })
  check("a DERIVED-persona audience on a protected-characteristic persona is REFUSED (protected_characteristic)", !derivedSenior.ok && derivedSenior.refusalKind === "protected_characteristic")
  check("POSITIVE CONTROL — the 2026-08-23 staff situation-persona path is NOT silently reversed (no basis → inclusion admitted; recorded for the owner)", basis.resolveAudiencePersonaBasis({ type: "persona_segment", filters: { personas: ["senior"] } }).ok)
  check("PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS is COMPUTED by the classifier (probate, military, divorce, senior — investor is not)",
    [...layers.PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS].sort().join(",") === "divorce,military,probate,senior" && !layers.PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS.includes("investor" as never))
  const proxyRules = [
    { type: "contact_list", filters: { contact_tags: ["young-families"] } },
    { type: "contact_list", filters: { contact_tags: ["spanish-speakers"] } },
    { type: "contact_list", filters: { contact_tags: ["church-goers"] } },
    { type: "website_visitors", filters: { url_pattern: "/good-schools" } },
    { type: "contact_list", filters: { contact_tags: ["affluent-buyers"] } },
  ]
  const missed = proxyRules.filter((r) => pcs.protectedClassSegmentationIn(r).length === 0)
  check(`SELECTION: proxy words in an audience rule are refused (${proxyRules.length} shapes: families, spanish-speakers, church, schools, affluent)`, missed.length === 0, JSON.stringify(missed))
  let threw = false
  try { pcs.assertAudienceSegmentationAllowed({ type: "contact_list", filters: { contact_tags: ["young-families"] } }, "Spring") } catch { threw = true }
  check("…and the define / populate assertion THROWS on one (all four audience doors call it)", threw)
  check("POSITIVE CONTROL — property facts and plain tags are NOT proxies: 'Single Family Residential', 'multi-family', 'open-house-2026', 'acreage'",
    pcs.protectedClassSegmentationIn({ type: "contact_list", filters: { contact_tags: ["open-house-2026", "acreage"], property_type: "Single Family Residential", segment: "multi-family" } }).length === 0)
  check("POSITIVE CONTROL — the proxy finder sees phrase, hyphen and camelCase spellings; a comment-like neutral word is not one",
    proxy.audienceProxyHits("Young Families").length > 0 && proxy.audienceProxyHits("youngFamilies").length > 0 && proxy.audienceProxyHits("near-good-schools").length > 0 && proxy.audienceProxyHits("relocation research").length === 0)

  // ── 4 ──────────────────────────────────────────────────────────────────────
  console.log("\n[4 — DELIVERY: the spec handed to a platform, and the launch door's re-gate of the targeted slot]")
  const base = (over: Record<string, unknown> = {}, t: Record<string, unknown> = {}) => ({
    platform: "facebook", objective: "leads", campaignName: "Spring", dailyBudgetUsd: 50, pageId: "p1", leadFormId: "f1",
    creative: { headline: "h", primaryText: "t", mediaAssetUrl: "https://x/y.jpg", destinationUrl: "https://x/lp" },
    targeting: { locations: [{ city: "Austin", state: "TX" }], ...t }, specialAdCategory: "HOUSING", ...over,
  }) as any
  check("a proxy interest is a delivery VIOLATION ('Parenting'); a needs interest is not ('home buying')",
    payload.validateAdReadiness(base({}, { interests: ["Parenting"] })).violations.some((v) => /Parenting/.test(v)) && payload.validateAdReadiness(base({}, { interests: ["home buying", "real estate"] })).violations.length === 0)
  check("a statutory-word interest is a violation too ('Christianity' is caught by the proxy list, 'children' by the classifier)",
    payload.validateAdReadiness(base({}, { interests: ["Christian music", "children's books"] })).violations.length === 2)
  check("ZIP targeting is a violation on Meta HOUSING and on Google", payload.validateAdReadiness(base({}, { locations: [{ zip: "78701" }] })).violations.some((v) => /ZIP/.test(v)) && payload.validateAdReadiness(base({ platform: "google" }, { locations: [{ zip: "78701" }] })).violations.some((v) => /ZIP/.test(v)))
  check("Google housing: age and gender narrowing are violations (the branch checked none of it before)", payload.validateAdReadiness(base({ platform: "google" }, { ageMin: 25 })).violations.some((v) => /age/.test(v)) && payload.validateAdReadiness(base({ platform: "google" }, { genders: ["female"] })).violations.some((v) => /gender/.test(v)))
  check("a TARGETED audience that was never gated at delivery is a violation; the same audience gated is ready",
    payload.validateAdReadiness(base({}, { audienceExternalIds: ["fb-1"] })).violations.some((v) => /never gated at delivery/.test(v)) && payload.validateAdReadiness(base({}, { audienceExternalIds: ["fb-1"], inclusionGovernance: "gated" })).ready)

  const asm = await import("../lib/ads/launch-assembler")
  const ldb = seed()
  G.__148C.svc = ldb
  ldb.tables.facebook_custom_audiences.push(
    { id: "aud-ok", brokerage_id: B, audience_name: "Persona — Relocation research", audience_type: "persona_segment", external_audience_id: "fb-ok", status: "synced", source_rule: derivedRule },
    { id: "aud-look", brokerage_id: B, audience_name: "Look-alike of buyers", audience_type: "lookalike", external_audience_id: "fb-look", status: "synced", source_rule: { type: "lookalike_seed", filters: {} } },
    { id: "aud-proxy", brokerage_id: B, audience_name: "Young families", audience_type: "custom", external_audience_id: "fb-proxy", status: "synced", source_rule: { type: "contact_list", filters: { contact_tags: ["young-families"] } } },
    { id: "aud-senior", brokerage_id: B, audience_name: "Derived senior", audience_type: "persona_segment", external_audience_id: "fb-senior", status: "synced", source_rule: { type: "persona_segment", basis: "derived_persona", filters: { personas: ["senior"] } } },
  )
  const camp = (id: string, tc: Record<string, unknown>) => {
    ldb.tables.ad_campaigns.push({ id, brokerage_id: B, platform: "facebook", objective: "leads", campaign_name: id, daily_budget: 40, status: "draft", targeting_config: { locations: [{ city: "Austin", state: "TX" }], page_id: "p1", lead_form_id: "f1", ...tc } })
    ldb.tables.ad_creative_variations.push({ id: `cr-${id}`, ad_campaign_id: id, brokerage_id: B, approval_status: "approved", headline: "New to Austin?", primary_text: "Compare neighbourhoods before you land.", media_asset_url: "https://x/y.jpg", destination_url: "https://x/lp", updated_at: RECENT })
  }
  camp("camp-ok", { custom_audience_ids: ["aud-ok"] })
  camp("camp-look", { custom_audience_ids: ["aud-look"] })
  camp("camp-proxy", { custom_audience_ids: ["aud-proxy"] })
  camp("camp-senior", { custom_audience_ids: ["aud-senior"] })
  camp("camp-raw-bad", { audience_external_id: "fb-built-in-ads-manager" })
  camp("camp-raw-ok", { audience_external_id: "fb-ok" })
  camp("camp-interest", { interests: ["Parenting"] })
  const ok = await asm.assembleAdFromCampaign("camp-ok", ldb as never)
  check("POSITIVE — a governed needs-based persona audience is DELIVERED: assembled, inclusion gated, and the payload is ready",
    ok.ok && ok.input?.targeting.inclusionGovernance === "gated" && (ok.input?.targeting.audienceExternalIds ?? []).includes("fb-ok") && payload.validateAdReadiness(ok.input!).ready, JSON.stringify(ok.ok ? payload.validateAdReadiness(ok.input!) : ok.error))
  const look = await asm.assembleAdFromCampaign("camp-look", ldb as never)
  check("a platform LOOK-ALIKE in a housing ad is refused at delivery (no look-alike model for housing)", !look.ok && /look-alike/.test(look.error ?? ""), look.error)
  const prx = await asm.assembleAdFromCampaign("camp-proxy", ldb as never)
  check("an audience whose rule selects by a PROXY is refused at delivery even though it already synced", !prx.ok && /protected class/.test(prx.error ?? ""), prx.error)
  const sen = await asm.assembleAdFromCampaign("camp-senior", ldb as never)
  check("a derived-persona audience edited onto a protected persona is refused at delivery", !sen.ok && /PROTECTED CHARACTERISTIC/.test(sen.error ?? ""), sen.error)
  const rawBad = await asm.assembleAdFromCampaign("camp-raw-bad", ldb as never)
  check("a RAW platform audience id that is not a governed audience of this tenant is refused (the ungoverned door is closed)", !rawBad.ok && /not a governed audience/.test(rawBad.error ?? ""), rawBad.error)
  const rawOk = await asm.assembleAdFromCampaign("camp-raw-ok", ldb as never)
  check("…and a raw id that IS a governed, gate-passing audience still delivers (capability kept)", rawOk.ok && rawOk.input?.targeting.inclusionGovernance === "gated", rawOk.error)
  const intr = await asm.assembleAdFromCampaign("camp-interest", ldb as never)
  check("the operator's proxy interest now reaches the validator (refused in words, not silently dropped)", intr.ok && payload.validateAdReadiness(intr.input!).violations.some((v) => /Parenting/.test(v)))

  // ── 5 ──────────────────────────────────────────────────────────────────────
  console.log("\n[5 — census (stripped source), migrations, and the prompt standard]")
  const walk = (d: string, out: string[] = []) => { if (!existsSync(join(ROOT, d))) return out; for (const n of readdirSync(join(ROOT, d))) { const p = `${d}/${n}`; if (statSync(join(ROOT, p)).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p) } return out }
  const targeting = [...walk("lib/ads"), ...walk("lib/audiences"), ...walk("lib/providers"), ...walk("lib/campaigns"), ...walk("lib/marketing"), "lib/kernel/ads.ts"]
  const layerNames = /\b(research_layer|service_profile|stated_needs|behavioural_evidence|inferred_interests)\b|persona-builder|protected-research-store|readProtectedAttributes/
  const reachesLayers = (t: string) => layerNames.test(stripComments(t)) || stringLiterals(t).some((l) => /persona-builder$|protected-research-store$/.test(l.text))
  const offenders = targeting.filter((f) => reachesLayers(raw(f)))
  check(`no ads / audience / provider / campaign / marketing module reads a non-marketing persona layer, the persona study or the research reader (${targeting.length} files)`, offenders.length === 0, offenders.join(", "))
  check("POSITIVE CONTROL — the layer finder sees a column read and an import; a comment is not one",
    reachesLayers(`svc.from("client_detailed_personas").select("research_layer")`) && reachesLayers(`await import("@/lib/contacts/persona-builder")`) && !reachesLayers("// research_layer is names only"))
  const builderSrc = src("lib/contacts/persona-builder.ts")
  const proxyPains = /school_district_constraints|growing_household_space_needs|"Family"|life_event:/
  check("the persona writer no longer derives familial / marital / life-event proxies into outbound columns (stripped source)", !proxyPains.test(builderSrc))
  check("POSITIVE CONTROL — the proxy-pain finder sees the old shapes", proxyPains.test(`pains.push("school_district_constraints")`) && proxyPains.test(`triggers.push(\`life_event:\${ev}\`)`))
  const m913 = raw("supabase/migrations/m913-client-detailed-personas-five-layers.sql")
  const m914 = raw("supabase/migrations/m914-protected-research-reads-only-through-the-ledgered-reader.sql")
  const stampOk = (t: string) => /^-- WRITTEN, NOT APPLIED \(wave 148, lane 148C\)/.test(t.split("\n")[0] ?? "") || /^-- ── APPLIED LIVE /.test(t.split("\n")[0] ?? "")
  check("m913 + m914 carry a valid line-1 stamp (the lane stamp, or APPLIED LIVE once applied — the rule, not the waypoint)", stampOk(m913) && stampOk(m914))
  const sql913 = m913.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  const listed = [...(sql913.match(/NOT IN \(([^)]*)\)/)?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
  check("m913's needs-based CHECK names EXACTLY the classifier's protected-characteristic personas (derived, compared — never a pinned list)", listed.join(",") === [...layers.PROTECTED_CHARACTERISTIC_CAMPAIGN_PERSONAS].sort().join(","), listed.join(","))
  check("m913 adds the five layers + service profile + derivation, holds 'marketing persona only when safe' and 'no research value' in the database",
    ["stated_needs", "behavioural_evidence", "inferred_interests", "research_layer", "marketing_persona", "marketing_safe", "service_profile", "derivation", "derived_at"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS ${c}\\b`).test(sql913))
    && /marketing_persona IS NULL OR marketing_safe = true/.test(sql913) && /jsonb_path_exists\(research_layer/.test(sql913))
  const sql914 = m914.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  check("m914 retires the unaudited direct SELECT (policy dropped, grant revoked) so the ledgered reader is the only read path", /DROP POLICY IF EXISTS protected_research_attributes_research_read/.test(sql914) && /REVOKE SELECT ON public\.protected_research_attributes FROM authenticated/.test(sql914) && !/CREATE POLICY/.test(sql914))
  const prompt = layers.buildPersonaDerivationPrompt({ brokerageName: "Alpha Realty", agentName: "Jo", firstName: "Rae", evidence: layers.derivePersonaDeterministic({ view: null, criteria: null, research: [] }).evidence, research: [], service: { preferredChannel: null, preferredLanguage: null, bestTime: null, accessibility: null } })
  const sections = [/Persona Strategist/, /MANDATE/, /FACTS YOU MAY RELY ON/, /NEVER INVENT/, /COMPLIANCE BOUNDARY/, /3604\(c\)/, /ESCALATION/, /CREATIVE BRIEF/, /OUTPUT CONTRACT/, /Alpha Realty/, /LAYER 1 — RESEARCH ATTRIBUTES \(SERVICE-ONLY/]
  const missing = sections.filter((re) => !re.test(prompt.system + "\n" + prompt.prompt))
  check(`the persona prompt carries every section of the wave-148 standard (${sections.length}: role, mandate, facts, never-invent, compliance, escalation, creative brief, typed contract, brand, the Layer-1 fence)`, missing.length === 0, missing.map(String).join(" "))
  check("POSITIVE CONTROL — the firewall's three screens each see their own shape (classifier: 'children'; proxy: 'young families'; copy pattern: 'perfect for families')",
    !!pcs.protectedClassReasonFor("children nearby") && !!proxy.audienceProxyReasonFor("young families") && fh.detectFairHousingViolations("perfect for families").length > 0)
  const doorFiles = ["app/actions/contact-persona.ts", "app/crm/contacts/[contactId]/components/persona-panel.tsx"]
  check("the contact-card door is a session-gated 'use server' module (every export async, actor from resolveCallerIdentity) and the panel is mounted on the contact page",
    /^"use server"/.test(raw(doorFiles[0])) && !/export\s+(?!async\s+function)(const|function|let|class)\s/.test(src(doorFiles[0])) && /resolveCallerIdentity\(\)/.test(src(doorFiles[0]))
    && /<PersonaPanel contactId=\{contactId\} \/>/.test(src("app/crm/contacts/[contactId]/page.tsx")))

  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail === 0 ? " ✅ PERSONA_COMPLIANCE_PASS" : ""}`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
