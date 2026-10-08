#!/usr/bin/env tsx
/**
 * scripts/tenant-config-reads-simulator.ts   (npm run test:tenant-config-reads)
 * ─────────────────────────────────────────────────────────────────────────────
 * A SESSIONLESS CALLER READS THE TENANT'S BRAND VOICE AND PROVIDER CONFIG — lane 86C.
 *
 * THE DEFECT. lib/kernel/brand-voice.ts and lib/kernel/providers.ts built the COOKIE client
 * inside their resolvers. Live RLS (2026-09-27):
 *   · brand_voice_profile   brok_brand_voice_profile  brokerage_id = current_user_brokerage_id()
 *   · provider_overrides    po_select                 is_platform_admin()
 * So every sessionless caller — the voice webhook's stage creators (lib/kernel/content-creators.ts),
 * the sequence cron, the internal render routes, dispatch from crons — read as anon and got NO
 * ROWS: prohibited words never checked, every provider "resolved" to the system default. And
 * because provider_overrides is platform-admin-only, even a SIGNED-IN broker never read their
 * own override. Degraded, never refused.
 *
 * THE FIX. One core each, taking the client and pinning every read to the tenant:
 *   resolveBrandVoiceCore (brand-voice.ts), resolveProviderCore (providers.ts), and
 *   evaluateOutbound(params, { client }) (compliance.ts). The session doors call the same cores;
 *   the sessionless door is the server-only lib/kernel/tenant-config-reads.ts on the service client.
 *
 * LAYERS
 *   BEHAVIOUR: the REAL cores and doors against an in-memory PostgREST that models the live RLS
 *     for three clients — anon (no session), a tenant-A cookie session, and the service role.
 *   SOURCE (stripped via scripts/strip-comments.ts): every call to the three resolvers in the
 *     SESSIONLESS corpus passes a client or goes through the tenant door (denominator derived).
 *
 * POSITIVE CONTROLS
 *   · the anon client reads NO voice and NO provider — the defect reproduced by the same core
 *   · tenant B's rows never reach tenant A through the service client (and vice versa)
 *   · a team / user of another brokerage is not trusted for its override tier
 *   · a users id is not accepted as brand_voice_profile.agent_id (the pre-86C fallback)
 *   · the source finder flags a bare call in a fixture, and not a tombstone mentioning one
 *
 * Run: npx tsx --conditions=react-server scripts/tenant-config-reads-simulator.ts
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"

let pass = 0
let fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── The in-memory PostgREST, with the live RLS modelled per client ───────────
type Row = Record<string, any>
type Who = { kind: "anon" } | { kind: "session"; brokerageId: string; platformAdmin?: boolean } | { kind: "service" }

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const USER_A = "11111111-0000-4000-8000-00000000000a"
const USER_B = "22222222-0000-4000-8000-00000000000b"
const AGENT_A = "33333333-0000-4000-8000-00000000000a"
const TEAM_A = "44444444-0000-4000-8000-00000000000a"
const TEAM_B = "55555555-0000-4000-8000-00000000000b"

function seed(): Record<string, Row[]> {
  return {
    brand_voice_profile: [
      { id: "bv-a", brokerage_id: A, team_id: null, agent_id: null, tone: "warm", formality_level: "professional",
        prohibited_words: ["guaranteed"], preferred_words: ["neighbor"], key_brand_messages: ["Local since 1999"], tagline: null, mission_statement: null },
      { id: "bv-b", brokerage_id: B, team_id: null, agent_id: null, tone: "brash", formality_level: null,
        prohibited_words: ["cozy"], preferred_words: [], key_brand_messages: [], tagline: null, mission_statement: null },
      // Team B's voice filed under brokerage B — must never apply to A even if its id is passed.
      { id: "bv-tb", brokerage_id: B, team_id: TEAM_B, agent_id: null, tone: null, formality_level: null,
        prohibited_words: ["team-b-word"], preferred_words: [], key_brand_messages: [], tagline: null, mission_statement: null },
      // Agent A's own voice (agents-class id).
      { id: "bv-ag", brokerage_id: A, team_id: null, agent_id: AGENT_A, tone: null, formality_level: null,
        prohibited_words: ["steal of a deal"], preferred_words: [], key_brand_messages: [], tagline: null, mission_statement: null },
      // A row keyed by a USERS id in the agents slot — the shape the pre-86C fallback matched.
      { id: "bv-bad", brokerage_id: A, team_id: null, agent_id: USER_B, tone: null, formality_level: null,
        prohibited_words: ["users-id-word"], preferred_words: [], key_brand_messages: [], tagline: null, mission_statement: null },
    ],
    teams: [
      { id: TEAM_A, brokerage_id: A, member_overrides_json: { brand_voice: { prohibited_words: ["team-a-word"] } } },
      { id: TEAM_B, brokerage_id: B, member_overrides_json: { brand_voice: { prohibited_words: ["team-b-json"] } } },
    ],
    agents: [{ id: AGENT_A, user_id: USER_A, brokerage_id: A }],
    users: [{ id: USER_A, brokerage_id: A }, { id: USER_B, brokerage_id: B }],
    provider_overrides: [
      { id: "po-a", scope_type: "brokerage", scope_id: A, provider_type: "sms", provider_key: "telnyx", config: { from: "+15550001" }, enabled: true },
      { id: "po-ub", scope_type: "user", scope_id: USER_B, provider_type: "sms", provider_key: "user-b-vendor", config: {}, enabled: true },
      { id: "po-tb", scope_type: "team", scope_id: TEAM_B, provider_type: "email", provider_key: "team-b-vendor", config: {}, enabled: true },
      { id: "po-ta", scope_type: "team", scope_id: TEAM_A, provider_type: "email", provider_key: "team-a-vendor", config: {}, enabled: true },
      { id: "po-sa", scope_type: "superadmin", scope_id: "00000000-0000-0000-0000-000000000000", provider_type: "voice_clone", provider_key: "platform-voice", config: {}, enabled: true },
    ],
    contacts: [{ id: "66666666-0000-4000-8000-00000000000a", brokerage_id: A, dnc_status: false, email_opt_out: true }],
    compliance_events: [],
  }
}

/** Live RLS, as read from pg_policies (2026-09-27), for the tables this proof touches. */
function visible(who: Who, table: string, row: Row): boolean {
  if (who.kind === "service") return true
  if (who.kind === "anon") return false
  if (table === "provider_overrides") return !!who.platformAdmin
  if ("brokerage_id" in row) return row.brokerage_id === who.brokerageId
  return true
}

function makeClient(db: Record<string, Row[]>, who: Who, ops: string[]) {
  class Q {
    private filters: Array<(r: Row) => boolean> = []
    private insertRow: Row | null = null
    constructor(private table: string) {}
    select(_cols?: string) { return this }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
    is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this }
    insert(row: Row) { this.insertRow = row; return this }
    private rows() { return (db[this.table] ?? []).filter((r) => visible(who, this.table, r)).filter((r) => this.filters.every((f) => f(r))) }
    async maybeSingle() {
      ops.push(`${who.kind}:${this.table}`)
      const rows = this.rows()
      if (rows.length > 1) return { data: null, error: { message: "PGRST116 multiple rows" } }
      return { data: rows[0] ?? null, error: null }
    }
    async single() {
      ops.push(`${who.kind}:${this.table}:${this.insertRow ? "insert" : "read"}`)
      if (this.insertRow) {
        if (who.kind === "anon") return { data: null, error: { message: "new row violates row-level security policy" } }
        // compliance_events.actor_user_id / entity_id are uuid (live): a non-uuid refuses the row.
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        for (const col of ["actor_user_id", "entity_id"]) {
          const v = (this.insertRow as Row)[col]
          if (this.table === "compliance_events" && v != null && !UUID.test(String(v))) return { data: null, error: { code: "22P02", message: `invalid input syntax for type uuid: "${v}"` } }
        }
        const row = { id: `ce-${(db[this.table] ?? []).length + 1}`, ...this.insertRow }
        ;(db[this.table] ??= []).push(row)
        return { data: { id: row.id }, error: null }
      }
      const rows = this.rows()
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "PGRST116" } }
    }
  }
  return { from: (t: string) => new Q(t) } as any
}

async function main() {
  const bv = await import("../lib/kernel/brand-voice")
  const prov = await import("../lib/kernel/providers")
  const door = await import("../lib/kernel/tenant-config-reads")

  const params = (brokerageId: string, content: string, extra: Record<string, unknown> = {}) => ({
    brokerageId, actorRole: "agent", journeyType: "seller" as const, persona: "other", messageType: "email", content, ...extra,
  })
  const COPY = "This home is guaranteed to delight — a steal of a deal, team-a-word included."

  console.log("\n── 1. Brand voice: the sessionless door reads the tenant's voice ──")
  const db = seed()
  const ops: string[] = []
  const svc = makeClient(db, { kind: "service" }, ops)
  const anon = makeClient(db, { kind: "anon" }, ops)
  const cookieA = makeClient(db, { kind: "session", brokerageId: A }, ops)

  const viaDoor = await door.applyTenantBrandVoice(params(A, COPY), svc)
  ok("service door: tenant A's prohibited word is found", viaDoor.violations.some((v) => v.includes('"guaranteed"')), JSON.stringify(viaDoor.violations))
  ok("service door: tenant A's tone comes back", viaDoor.tone === "warm", String(viaDoor.tone))
  ok("service door: tenant A's key messages come back", (viaDoor.keyBrandMessages ?? []).includes("Local since 1999"))

  const viaAnon = await bv.applyBrandVoice(params(A, COPY), { client: anon })
  ok("POSITIVE CONTROL — the anon client (the pre-86C sessionless read) finds NOTHING", viaAnon.violations.length === 0 && viaAnon.tone == null,
    JSON.stringify(viaAnon.violations))

  const viaSession = await bv.applyBrandVoice(params(A, COPY), { client: cookieA })
  ok("the SESSION door reaches the same core and the same answer", JSON.stringify(viaSession.violations) === JSON.stringify(viaDoor.violations))

  console.log("\n── 2. Brand voice: every read is pinned to the tenant ──")
  const bForA = await door.applyTenantBrandVoice(params(B, COPY), svc)
  ok("tenant B's door does not see tenant A's voice", !bForA.violations.some((v) => v.includes("guaranteed")) && bForA.tone === "brash")
  const aWithForeignTeam = await door.applyTenantBrandVoice(params(A, "team-b-word team-b-json", { teamId: TEAM_B }), svc)
  ok("a team of another brokerage contributes nothing (json override or profile row)", aWithForeignTeam.violations.every((v) => !v.includes("team-b")),
    JSON.stringify(aWithForeignTeam.violations))
  const aWithOwnTeam = await door.applyTenantBrandVoice(params(A, "team-a-word", { teamId: TEAM_A }), svc)
  ok("POSITIVE CONTROL — the tenant's own team override DOES apply", aWithOwnTeam.violations.some((v) => v.includes("team-a-word")))
  const agentVoice = await door.applyTenantBrandVoice(params(A, "a steal of a deal", { actorUserId: USER_A }), svc)
  ok("the agent tier crosses users.id → agents.id and applies the agent's own voice", agentVoice.violations.some((v) => v.includes("steal of a deal")))
  const usersIdAsAgent = await door.applyTenantBrandVoice(params(A, "users-id-word", { actorUserId: USER_B }), svc)
  ok("a users id is never used as brand_voice_profile.agent_id (no agents row → no agent tier)",
    !usersIdAsAgent.violations.some((v) => v.includes("users-id-word")), JSON.stringify(usersIdAsAgent.violations))
  ok("an empty brokerageId reads nothing (fail closed, no unpinned read)",
    (await door.applyTenantBrandVoice(params("", COPY), svc)).violations.length === 0)

  console.log("\n── 3. Providers: the sessionless door reads the tenant's override ──")
  const ctx = (brokerageId: string, userId = "", teamId?: string) => ({ userId, brokerageId, teamId })
  const smsA = await door.resolveTenantProvider({ providerType: "sms", actorContext: ctx(A, USER_A) }, svc)
  ok("service door: tenant A's brokerage override answers (telnyx, scope brokerage)", smsA.providerKey === "telnyx" && smsA.scope === "brokerage", JSON.stringify(smsA))
  const smsAnon = await prov.resolveProvider({ providerType: "sms", actorContext: ctx(A, USER_A) }, { client: anon })
  ok("POSITIVE CONTROL — the anon client resolves to the system default (the defect)", smsAnon.providerKey === "twilio" && smsAnon.scope === "system_default")
  const smsCookie = await prov.resolveProvider({ providerType: "sms", actorContext: ctx(A, USER_A) }, { client: cookieA })
  ok("POSITIVE CONTROL — even tenant A's own COOKIE session reads nothing (po_select = is_platform_admin())",
    smsCookie.scope === "system_default")
  const smsB = await door.resolveTenantProvider({ providerType: "sms", actorContext: ctx(B) }, svc)
  ok("tenant B does not inherit tenant A's override", smsB.providerKey === "twilio" && smsB.scope === "system_default")
  const foreignUser = await door.resolveTenantProvider({ providerType: "sms", actorContext: ctx(A, USER_B) }, svc)
  ok("a user of another brokerage is not trusted for the user tier", foreignUser.providerKey === "telnyx", JSON.stringify(foreignUser))
  const ownUserB = await door.resolveTenantProvider({ providerType: "sms", actorContext: ctx(B, USER_B) }, svc)
  ok("POSITIVE CONTROL — the same user in its OWN brokerage gets its user override", ownUserB.providerKey === "user-b-vendor" && ownUserB.scope === "user")
  const foreignTeam = await door.resolveTenantProvider({ providerType: "email", actorContext: ctx(A, "", TEAM_B) }, svc)
  ok("a team of another brokerage is not trusted for the team tier", foreignTeam.scope === "system_default", JSON.stringify(foreignTeam))
  const ownTeam = await door.resolveTenantProvider({ providerType: "email", actorContext: ctx(A, "", TEAM_A) }, svc)
  ok("POSITIVE CONTROL — the tenant's own team override answers", ownTeam.providerKey === "team-a-vendor" && ownTeam.scope === "team")
  const brokerageAsUser = await door.resolveTenantProvider({ providerType: "sms", actorContext: ctx(A, A) }, svc)
  ok("dispatch's `userId ?? brokerageId` fallback reads no user tier (brokerages id ≠ users id)", brokerageAsUser.scope === "brokerage")
  const platformVoice = await door.resolveTenantProvider({ providerType: "voice_clone", actorContext: ctx(A) }, svc)
  ok("a SYSTEM_ONLY type reads the platform superadmin row on the service client", platformVoice.providerKey === "platform-voice" && platformVoice.scope === "superadmin")

  console.log("\n── 4. Providers: the session door fails closed without a session ──")
  const noSession = await prov.resolveProvider({ providerType: "sms", actorContext: ctx(A, USER_A) })
  ok("resolveProvider with no client and no cookie session reads NO tenant tier (system default, said out loud)",
    noSession.scope === "system_default" && noSession.providerKey === "twilio", JSON.stringify(noSession))

  console.log("\n── 5. The compliance gate: Gate 1 and the audit row land for a sessionless caller ──")
  const gateDb = seed()
  const gateOps: string[] = []
  const gateSvc = makeClient(gateDb, { kind: "service" }, gateOps)
  const gateAnon = makeClient(gateDb, { kind: "anon" }, gateOps)
  const actorContext = { userId: USER_A, brokerageId: A, role: "agent" as const }
  const gateParams = { actorContext, journeyType: "seller" as const, persona: "other" as any, messageType: "email" as const, content: "Results guaranteed for every seller." }
  const viaTenantGate = await door.evaluateTenantOutbound(gateParams, gateSvc)
  ok("evaluateTenantOutbound refuses on the tenant's prohibited word (Gate 1 read the voice)",
    !viaTenantGate.allowed && viaTenantGate.violations.some((v) => v.startsWith("BrandVoice:") && v.includes("guaranteed")), JSON.stringify(viaTenantGate.violations))
  ok("…and its compliance_events audit row LANDED, in tenant A", gateDb.compliance_events.length === 1 && gateDb.compliance_events[0].brokerage_id === A)
  const { evaluateOutbound } = await import("../lib/kernel/compliance")
  const viaAnonGate = await evaluateOutbound(gateParams, { client: gateAnon })
  ok("POSITIVE CONTROL — the anon client lets the same copy through Gate 1 and loses the audit row",
    !viaAnonGate.violations.some((v) => v.startsWith("BrandVoice:")) && gateDb.compliance_events.length === 1, JSON.stringify(viaAnonGate.violations))
  const withContact = await door.evaluateTenantOutbound({ ...gateParams, content: "Hello neighbor", contact: { id: gateDb.contacts[0].id, first_name: "C", last_name: "D", contact_type: "buyer", tcpa_consent: true, isa_reengage_allowed: false } as any }, gateSvc)
  ok("the contact re-read sees the tenant's opt-out on the service client", withContact.violations.some((v) => v.includes("opted out of email")), JSON.stringify(withContact.violations))
  const foreignContact = await door.evaluateTenantOutbound({ ...gateParams, actorContext: { ...actorContext, brokerageId: B }, content: "Hello", contact: { id: gateDb.contacts[0].id, first_name: "C", last_name: "D", contact_type: "buyer", tcpa_consent: true, isa_reengage_allowed: false } as any }, gateSvc)
  ok("the contact re-read is tenant-pinned (tenant B cannot read A's contact flags)", !foreignContact.violations.some((v) => v.includes("opted out")), JSON.stringify(foreignContact.violations))

  console.log("\n── 5b. The audit row survives a sessionless actor and a broadcast shape ──")
  {
    const auditDb = seed()
    const auditSvc = makeClient(auditDb, { kind: "service" }, [])
    await door.evaluateTenantOutbound({ actorContext: { userId: "system", brokerageId: A, role: "isa" as any }, journeyType: "buyer", persona: "other" as any, messageType: "email", content: "Hello neighbor" }, auditSvc)
    ok("an actor of 'system' (the anthropic-agent webhook's) still LANDS the audit row, actor recorded as unknown",
      auditDb.compliance_events.length === 1 && auditDb.compliance_events[0].actor_user_id === null && auditDb.compliance_events[0].brokerage_id === A, JSON.stringify(auditDb.compliance_events))
    const before = auditDb.compliance_events.length
    await door.evaluateTenantOutbound({ actorContext: { userId: USER_A, brokerageId: A, role: "agent" }, journeyType: "buyer", persona: "other" as any, messageType: "email", content: "Hello neighbor", contact: { id: "broadcast_preview", first_name: "S", last_name: "A", contact_type: "buyer", tcpa_consent: true, isa_reengage_allowed: false } as any }, auditSvc)
    ok("a stub (non-uuid) contact id no longer 22P02s the audit row", auditDb.compliance_events.length === before + 1 && auditDb.compliance_events[before].entity_id === null)
    const raw = makeClient(seed(), { kind: "service" }, [])
    const { error: rawErr } = await raw.from("compliance_events").insert({ brokerage_id: A, actor_user_id: "system", entity_id: null }).select("id").single()
    ok("POSITIVE CONTROL — the fake enforces the live uuid columns (a raw 'system' actor is refused 22P02)", rawErr?.code === "22P02")
    const cron = stripComments(read("app/api/cron/publish-newsletters/route.ts"))
    ok("publish-newsletters: the broadcast gate carries NO stub contact and fails CLOSED (defers) on a thrown gate",
      !/id:\s*"broadcast_preview"/.test(cron) && !/\.catch\(\(\)\s*=>\s*\(\{\s*allowed:\s*true/.test(cron) && /allowed:\s*false,\s*violations:\s*\[`gate_unavailable/.test(cron))
    ok("POSITIVE CONTROL — that finder flags the pre-86C shape",
      /id:\s*"broadcast_preview"/.test(`contact: { id: "broadcast_preview" }`) && /\.catch\(\(\)\s*=>\s*\(\{\s*allowed:\s*true/.test(`}).catch(() => ({ allowed: true, violations: [] }))`))
  }

  console.log("\n── 6. SOURCE: the sessionless corpus reaches the resolvers only with a client ──")
  const CORPUS = [
    "lib/kernel/content-creators.ts",
    "lib/providers/dispatch.ts",
    "lib/campaign-sequences/render-step.ts",
    "lib/agents/brokerage-context.ts",
    "lib/ai-isa/build-call-context.ts",
    "app/api/cron/publish-newsletters/route.ts",
    "app/api/agent-assistant/tool-call/route.ts",
    "app/api/webhooks/anthropic-agent/route.ts",
    "app/api/internal/remotion/render-just-listed/route.ts",
    "app/api/internal/remotion/render-newsletter-video/route.ts",
    // Widened (owner follow-up, 86C): cron / reactor / public-kiosk reachable, tenant from a
    // verified row at every call (open-house event row, send orchestration, cron rows,
    // enrollment rows, the session-gated preview for mail copy).
    "lib/open-house/instant-greeting.ts",
    "lib/direct-mail/draft-copy.ts",
    "lib/podcast/auto-producer.ts",
    "lib/ai-isa/lead-action-plan.ts",
    "lib/marketing/lead-magnet-delivery-runner.ts",
    "lib/marketing/social-carousel.ts",
    "lib/marketing/video-content-kit.ts",
    "lib/video/intro-video-reactor.ts",
    "lib/video/listing-promo-reactor.ts",
    "lib/video/persona-variant-post-pass.ts",
    "lib/video/video-director.ts",
    "lib/voicedrop/orchestrate-voicedrop-send.ts",
    "lib/campaign-sequences/compliance-gate.ts",
    "lib/video/script-compliance.ts",
    // Lane 86F2: the listing-description core runs from the listing-presentation-prep
    // cron (builder step 4b) with the builder's verified tenant; it reaches brand voice
    // through guardContent, which is now a resolver call the finder requires a client on.
    "lib/listings/listing-description-core.ts",
  ]
  // REVIEWED, deliberately NOT in the corpus (published so the exclusion is visible):
  const REVIEWED_SESSION_ONLY: Record<string, string> = {
    "lib/kernel/communications.ts": "evaluateOutboundEligibility's one caller is sendInboxReply, which builds the COOKIE client itself (session door; RLS pins the tenant)",
    "lib/kernel/helpers.ts": "enforceCompliance has ZERO live callers (only prose names it)",
    "lib/kernel/adapters/compliance.ts": "evaluateKernelOutbound is a pass-through wrapper: it forwards opts to evaluateOutbound; its sessionless caller (campaign-sequences/compliance-gate.ts) is in the corpus",
    "lib/content-guardian/index.ts": "DUAL-MODE (lane 86F2): guardContent with a `client` goes through applyTenantBrandVoice (asserted below); without one it is its session callers' cookie read (lib/kernel/listings.ts generateListingDescription, cookie client). Its sessionless caller is in the corpus and must pass a client",
  }
  for (const [f, why] of Object.entries(REVIEWED_SESSION_ONLY)) console.log(`    reviewed, not in corpus: ${f} — ${why}`)
  ok("the pass-through wrapper really forwards the client (opts → evaluateOutbound)", /\},\s*opts\)/.test(stripComments(read("lib/kernel/adapters/compliance.ts"))))
  {
    const cg = stripComments(read("lib/content-guardian/index.ts"))
    ok("guardContent routes a supplied client through the tenant door (applyTenantBrandVoice) and keys the agent voice on a USERS id",
      /client\s*\?\s*await \(await import\("@\/lib\/kernel\/tenant-config-reads"\)\)\.applyTenantBrandVoice\(bvParams, client\)/.test(cg) &&
        !/actorUserId:\s*agentId/.test(cg))
    ok("POSITIVE CONTROL — that finder flags the pre-86F2 shape (agents id handed over as the users id, no client)",
      /actorUserId:\s*agentId/.test(`const bvResult = await applyBrandVoice({ content, actorUserId: agentId })`))
  }
  /** Each call of a resolver in stripped source, and whether it carries a client or is a door. */
  function bareCalls(src: string, file: string): string[] {
    const code = stripComments(src)
    const imported = new Map<string, string>()
    // Which local name is bound to which module (aliases included, e.g. evaluateTenantOutbound: evaluateOutbound).
    for (const m of code.matchAll(/\{\s*(\w+)\s*:\s*(\w+)\s*\}\s*=\s*await\s+import\(/g)) imported.set(m[2], m[1])
    for (const m of code.matchAll(/import\s*\{[^}]*?\b(\w+)\s+as\s+(\w+)/g)) imported.set(m[2], m[1])
    const out: string[] = []
    // guardContent joined in lane 86F2: it reaches applyBrandVoice, so a sessionless
    // caller must hand it a client too.
    const re = /\b(applyBrandVoice|resolveProvider|evaluateOutbound|evaluateKernelOutbound|guardContent)\s*\(/g
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      // Declarations are not calls.
      if (/function\s+$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue
      let i = m.index + m[0].length, depth = 1
      for (; i < code.length && depth > 0; i++) { const c = code[i]; if ("([{".includes(c)) depth++; else if (")]}".includes(c)) depth-- }
      const args = code.slice(m.index, i)
      const bound = imported.get(m[1])
      const isDoor = bound === "evaluateTenantOutbound" || bound === "applyTenantBrandVoice" || bound === "resolveTenantProvider"
      const localWrapper = m[1] === "resolveProvider" && /function\s+resolveProvider\s*\([^)]*\)\s*\{\s*return\s+resolveProviderDoor\([^)]*\{\s*client:/.test(code)
      // guardContent takes ONE params object, so its client is a key anywhere in it.
      const guardWithClient = m[1] === "guardContent" && /[{,]\s*client\s*:/.test(args)
      if (!isDoor && !localWrapper && !guardWithClient && !/\{\s*client\s*:/.test(args)) out.push(`${file}: ${args.slice(0, 60).replace(/\s+/g, " ")}`)
    }
    return out
  }
  let callsSeen = 0
  const offenders: string[] = []
  for (const f of CORPUS) {
    ok(`corpus file exists: ${f}`, existsSync(join(process.cwd(), f)))
    const src = read(f)
    callsSeen += (stripComments(src).match(/\b(applyBrandVoice|resolveProvider|evaluateOutbound|evaluateKernelOutbound|guardContent|applyTenantBrandVoice|resolveTenantProvider|evaluateTenantOutbound)\s*\(/g) ?? []).length
    offenders.push(...bareCalls(src, f))
  }
  console.log(`    denominator: ${CORPUS.length} sessionless files, ${callsSeen} resolver call sites (comments stripped)`)
  ok("0 sessionless resolver calls without a client or the tenant door", offenders.length === 0, offenders.join(" | "))
  ok("the denominator is non-zero (the finder read real calls)", callsSeen >= CORPUS.length)
  const FIXTURE_BAD = `const v = await applyBrandVoice({ brokerageId, content })\nconst p = await resolveProvider({ providerType: "sms", actorContext })`
  ok("POSITIVE CONTROL — the finder flags both bare calls in a fixture", bareCalls(FIXTURE_BAD, "fixture").length === 2)
  ok("POSITIVE CONTROL — a guardContent call without a client is flagged, with one it is not (lane 86F2)",
    bareCalls(`await guardContent({ content, agentId, brokerageId, contentType: "listing_description" })`, "fixture").length === 1 &&
      bareCalls(`await guardContent({ content, agentId, brokerageId, contentType: "listing_description", client: svc })`, "fixture").length === 0)
  const FIXTURE_TOMB = `// TOMBSTONE: this used to call applyBrandVoice({ brokerageId }) on the cookie client\nconst x = await applyTenantBrandVoice({ brokerageId })`
  ok("POSITIVE CONTROL — a tombstone mentioning a bare call is not a call site", bareCalls(FIXTURE_TOMB, "fixture").length === 0)

  const doorSrc = read("lib/kernel/tenant-config-reads.ts")
  const doorCode = blankStrings(stripComments(doorSrc))
  ok("the door is server-only (first statement) and NOT a \"use server\" file",
    /^\s*import\s+["']server-only["']/m.test(stripComments(doorSrc)) && !/["']use server["']/.test(stripComments(doorSrc).slice(0, 200)))
  ok("the door binds the service client", /createServiceClient\s*\(/.test(doorCode))
  const bvCode = stripComments(read("lib/kernel/brand-voice.ts"))
  ok("the brand-voice core has no users-id fallback into agent_id", !/agentRow\?\.id\s*\?\?\s*actorUserId/.test(bvCode))
  ok("POSITIVE CONTROL — that fallback finder flags the pre-86C line",
    /agentRow\?\.id\s*\?\?\s*actorUserId/.test("const agentId = agentRow?.id ?? actorUserId"))
  const bvReads = (bvCode.match(/\.from\("brand_voice_profile"\)[\s\S]*?\.maybeSingle\(\)/g) ?? [])
  ok(`every brand_voice_profile read in the core is brokerage-pinned (${bvReads.length} reads)`,
    bvReads.length >= 3 && bvReads.every((q) => /\.eq\("brokerage_id",\s*brokerageId\)/.test(q)))
  const provCode = stripComments(read("lib/kernel/providers.ts"))
  ok("the provider session door proves the tenant before binding the service client",
    /sameTenant[\s\S]*staff[\s\S]*return resolveProviderCore\(createServiceClient\(\)/.test(provCode))

  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log(" ❌ TENANT_CONFIG_READS_FAIL")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ TENANT_CONFIG_READS_PASS — sessionless callers read the tenant's brand voice and provider config")
}

main().catch((err) => { console.error(err); process.exit(1) })
