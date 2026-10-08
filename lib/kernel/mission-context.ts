/**
 * MISSION CONTEXT — the CONTEXT COMPILER (wave 105, lane 105C; owner: "SHARED WORKING CONTEXT —
 * a Context Compiler (mission → relevant person / property / opportunity / recent events / memory /
 * policy / fatigue / tasks / pending delegations / tools / budget / authority → compact manager
 * context) distinct from long-term memory").
 *
 * ONE call, compileManagerContext, replaces the several loads a manager's prompt assembly did
 * (engage-contact read the contact row, then loadContactNbaContext, then loadBrandVoicePrompt;
 * the listing concierge read the contact row and the listing row again). Every slice is read
 * through THE survivor that already owns it — this module re-queries none of their tables:
 *   · mission + working context .......... lib/kernel/missions.ts getMission / currentWorkingContext
 *   · person (identity + relationships) ... lib/kernel/person-identity.ts personForContact
 *   · opportunity / tasks / dead ends ..... lib/ai-isa/lead-action-plan.ts loadContactNbaContext
 *       (activities / showings / tasks / relationship_edges / ai_isa_activities / voice_calls)
 *   · long-term memory .................... lib/kernel/conversation-memory.ts loadContactMemoryForPrompt
 *       (handed INTO loadContactNbaContext as `preloaded.memory`, so the spine is read once)
 *   · policy (+ version) + brand .......... lib/kernel/tenant-policy.ts resolvePolicyRef,
 *       lib/ai-isa/brand-playbook-context.ts loadBrandPlaybookContext
 *   · fatigue (contact scope) ............. the one calculator's score row, buyer_fatigue_scores,
 *       read as lib/kernel/deconflict reads it (tenant-pinned, error read)
 *   · capacity (agent scope, incl. fatigue tier) ... lib/lead-assignment/capacity-pick.ts capacityFor
 *   · authority / tools ................... lib/managers/autonomy-gate.ts resolveAgentAuthorityLevel,
 *       capped by the mission's authority_ceiling; lib/ai-isa/persona-tool-policy.ts
 *       selectToolsForPersona mounts the registry at that rung (mountToolsFromContext)
 *   · recent events ....................... mission_events (the mission's own flight record) +
 *       lifecycle_events for the subject — the two append-only evidence ledgers, newest first
 *   · pending delegations ................. lib/kernel/manager-delegation.ts pendingDelegationsFor (m712) + open manager_signals;
 *       until registered, open manager_signals addressed to this mission (the channel a delegation rides)
 *   · budget / authority .................. the mission row (no read)
 * The CONTACT ROW itself is read HERE, once (readContactRow — the column list engage-contact
 * needs), and handed to the consumers through `person.row`; the mission-in-play branch of
 * engage-contact and the listing concierge no longer read it themselves.
 *
 * The WORKING CONTEXT (current objective, open requests, who is waiting on what, seller
 * availability, budget remaining) lives ON THE MISSION ROW — missions.evidence entries of kind
 * `working_context`, latest wins (lib/kernel/missions.ts updateMissionWorkingContext) — written by
 * the mission service's transitions / progress and by delegation results (105A), never by
 * free-form manager chat. No m714: `progress` is numeric and `evidence` already is the mission's
 * append-only evidence list, which is exactly what a working-context revision is.
 *
 * TOKEN BUDGET: the rendered section never exceeds `tokenBudget` (estimateTokens — the cost
 * ledger's own rule). Truncation is most-recent-first (events keep their newest rows, the
 * slices lowest in priority lose lines first) and leaves an honest `[truncated …]` marker.
 * REFUSALS are published as blind spots (slice.refused + blindSpots[]), never silent. A compile
 * is BOOKED on ai_tool_usage (feature mission_context, tokens 0 / cost 0 — the tokens are spent
 * by the consumer's own model call, which books itself; the row is the evidence of the compile).
 * AUDIENCE: `agent` strips cost / margin (CLAUDE.md §5 — commission and cost are off agent-facing display).
 *
 * No `import "server-only"`: the proof drives it through an in-memory client and recorder seams.
 */
import { estimateTokens } from "@/lib/ai/cost-tracking"
import { getMission, currentWorkingContext, budgetExhausted, type MissionRow, type WorkingContext } from "@/lib/kernel/missions"
import { selectToolsForPersona, DEFAULT_AUTHORITY_LEVEL, type AuthorityLevel } from "@/lib/ai-isa/persona-tool-policy"
import type { ManagerKey } from "@/lib/kernel/manager-registry"
import type { NextBestActionContext } from "@/lib/ai-isa/lead-action-plan"
import type { ContactMemoryForPrompt } from "@/lib/kernel/conversation-memory"
import type { BrandVoicePromptResult } from "@/lib/ai-isa/brand-voice-prompt"
import type { CustomManagerMemoryAccess } from "@/lib/kernel/skill-registry"

/**
 * MEMORY ACCESS (wave 138D) — the slices a CUSTOM manager's declared `memory_access` admits (its contract:
 * lib/kernel/skill-registry.ts CUSTOM_MANAGER_MEMORY_ACCESS). Enforced HERE, in the one compiler: a slice outside
 * the declaration is never READ (its reader is not called), so it cannot leak through rendering, tools or the
 * booking. The governance slices (the mission's own objective, policy, authority, budget) are always compiled — they
 * bound the run. A built-in manager passes no memoryAccess and is unaffected.
 */
const GOVERNANCE_SLICES = ["mission", "policy", "tools", "budget"] as const
const MISSION_CONTEXT_SLICES = [...GOVERNANCE_SLICES, "working", "person", "property", "opportunity", "fatigue", "capacity", "events", "delegations"] as const
/** @proofSeam the proof asserts each access level's admitted set against a compile with every reader observed */
export const CONTEXT_SLICES_BY_MEMORY_ACCESS: Readonly<Record<CustomManagerMemoryAccess, ReadonlySet<string>>> = Object.freeze({
  none: new Set<string>(GOVERNANCE_SLICES),
  mission_context: new Set<string>(MISSION_CONTEXT_SLICES),
  contact_memory: new Set<string>([...MISSION_CONTEXT_SLICES, "memory"]),
})

/**
 * Is a mission IN PLAY for this subject? The one read every consumer makes before compiling
 * (activeMissionsFor — the missions seam); an explicit missionId skips it. Null = no mission, or
 * the read was refused (logged) — the consumer then runs its pre-105C loads, never a blank context.
 */
export async function missionInPlayFor(input: { brokerageId: string; subject: { type: string; id: string }; missionId?: string | null; client?: Client }): Promise<string | null> {
  if (input.missionId) return input.missionId
  const { activeMissionsFor } = await import("@/lib/kernel/missions")
  const live = await activeMissionsFor(input.brokerageId, { subject: input.subject, limit: 1 }, input.client)
  if (live.readRefused) { console.error(`[mission-context] missions read refused for ${input.subject.type} ${input.subject.id}: ${live.readRefused}`); return null }
  return live.active[0]?.id ?? null
}

type Client = { from: (table: string) => any }

/** Every slice names its reader and when it was read; a refused read is published, never blank. */
export interface ContextSlice<T> {
  reader: string
  freshness: string
  data: T | null
  refused: string | null
}
export interface BlindSpot { slice: string; reader: string; reason: string }

/** The contact row the engagement path needs — read ONCE here (see header). */
export const CONTACT_CONTEXT_COLUMNS = `id, first_name, last_name, email, phone,
  contact_type, contact_persona, buyer_stage, status,
  dnc_status, call_stop_flag, tcpa_consent, tcpa_consent_date,
  email_opt_out, sms_opt_out, phone_opt_out, direct_mail_opt_out,
  isa_reengage_allowed, ai_outreach_paused,
  preferred_channel, social_handles,
  brokerage_id, team_id, agent_id,
  mailing_address, city, mailing_state:state, mailing_zip:zip_code,
  budget_min, budget_max, timeline, motivation_type, enrichment_profile, age_range,
  occupation, household_income, home_owner_status, life_events, marital_status,
  last_contacted_at, qualification_summary`

export interface ContextEvent { at: string; source: "mission_events" | "lifecycle_events"; kind: string; summary: string }
export interface ContextDelegation { id: string; from: string; to: string; kind: string; status: string; since: string; message?: string | null }

export interface ManagerContext {
  brokerageId: string
  missionId: string
  manager: ManagerKey
  audience: "manager" | "agent"
  compiledAt: string
  mission: ContextSlice<{ id: string; objective: string; state: string; missionType: string; ownerManager: string; participating: string[]; priority: string; deadline: string | null; progress: Record<string, number>; successCriteria: MissionRow["success_criteria"]; blockers: string[]; subject: { type: string; id: string } | null }>
  working: ContextSlice<WorkingContext>
  person: ContextSlice<{ row: Record<string, any>; identity: { personId: string | null; evidenceCount: number | null } | null }>
  property: ContextSlice<{ listingId: string; address: string; status: string | null; lifecycleStage: string | null; listPrice: number | null }>
  opportunity: ContextSlice<NextBestActionContext>
  memory: ContextSlice<ContactMemoryForPrompt>
  policy: ContextSlice<{ isaPolicyRef: string; managerPolicyRef: string; brandBlock: string; voice: BrandVoicePromptResult | null }>
  fatigue: ContextSlice<{ riskLevel: string | null; score: number | null; at: string | null }>
  capacity: ContextSlice<{ agentId: string; band: string; load: number; fatigueTier: string | null }>
  events: ContextSlice<ContextEvent[]>
  delegations: ContextSlice<ContextDelegation[]>
  tools: ContextSlice<{ managerAuthority: AuthorityLevel; ceiling: AuthorityLevel; effective: AuthorityLevel; available: string[] | null }>
  /** null for the `agent` audience — agents see no cost. */
  budget: ContextSlice<{ usdCap: number | null; usdSpent: number; usdRemaining: number | null; tokenCap: number | null; tokensSpent: number; tokensRemaining: number | null; exhausted: boolean }> | null
  blindSpots: BlindSpot[]
}

/** The data type behind a ManagerContext slice (lets a slice start empty with its reader named). */
type SliceData<K extends keyof ManagerContext> = NonNullable<ManagerContext[K]> extends ContextSlice<infer U> ? U : never

export interface CompiledManagerContext {
  context: ManagerContext
  /** The rendered prompt section, ≤ tokenBudget. */
  section: string
  tokens: number
  tokenBudget: number
  truncated: boolean
}
export type CompileResult = { ok: true } & CompiledManagerContext | { ok: false; reason: string }

// ─── seams: every default is THE survivor (lazy imports keep this off the proxy graph) ─────────
export interface MissionContextDeps {
  now?: () => Date
  mission?: (brokerageId: string, missionId: string, client: Client) => Promise<MissionRow | null>
  contactRow?: (brokerageId: string, contactId: string, client: Client) => Promise<{ row: Record<string, any> | null; error: string | null }>
  identity?: (brokerageId: string, contactId: string, client: Client) => Promise<{ personId: string | null; evidenceCount: number | null; error: string | null }>
  listing?: (brokerageId: string, subject: { type: string; id: string }, client: Client) => Promise<{ row: Record<string, any> | null; error: string | null }>
  memory?: (brokerageId: string, contactId: string, client: Client, now: Date) => Promise<ContactMemoryForPrompt | null>
  nba?: (brokerageId: string, contact: Record<string, any>, memory: ContactMemoryForPrompt | null, client: Client, now: Date) => Promise<{ ok: true; context: NextBestActionContext } | { ok: false; error: string }>
  policy?: (brokerageId: string, manager: ManagerKey, contactId: string | null, agentId: string | null, teamId: string | null, client: Client) => Promise<{ isaPolicyRef: string; managerPolicyRef: string; brandBlock: string; voice: BrandVoicePromptResult | null; error: string | null }>
  fatigue?: (brokerageId: string, contactId: string, client: Client) => Promise<{ riskLevel: string | null; score: number | null; at: string | null; found: boolean; error: string | null }>
  capacity?: (brokerageId: string, agentId: string, client: Client, now: Date) => Promise<{ band: string; load: number; fatigueTier: string | null; error: string | null }>
  authority?: (brokerageId: string, manager: ManagerKey, client: Client) => Promise<AuthorityLevel>
  events?: (brokerageId: string, missionId: string, subject: { type: string; id: string } | null, client: Client, limit: number) => Promise<{ rows: ContextEvent[]; error: string | null }>
  delegations?: (brokerageId: string, missionId: string, client: Client) => Promise<{ rows: ContextDelegation[]; error: string | null }>
  book?: (input: { brokerageId: string; manager: ManagerKey; missionId: string; tokens: number; budget: number; truncated: boolean; blindSpots: number; slices: string[] }, client: Client) => Promise<{ booked: boolean; error: string | null }>
}

// TOMBSTONE (wave 105 integration): the "105A seam" registration (registerMissionContextSeam /
// missionContextSeams) is gone — it was a placeholder for a reader that now exists; the delegations
// slice below reads lib/kernel/manager-delegation.ts pendingDelegationsFor directly (the survivor),
// so a registration had nothing left to register (orphan category A: proof-only).

const msg = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e))

const defaultDeps: Required<MissionContextDeps> = {
  now: () => new Date(),
  mission: (b, id, c) => getMission(b, id, c),
  contactRow: async (b, id, c) => {
    const { data, error } = await c.from("contacts").select(CONTACT_CONTEXT_COLUMNS).eq("id", id).eq("brokerage_id", b).maybeSingle()
    return { row: error ? null : ((data as Record<string, any> | null) ?? null), error: error ? `contacts read refused: ${msg(error)}` : null }
  },
  identity: async (b, id, c) => {
    const { personForContact } = await import("@/lib/kernel/person-identity")
    const v = await personForContact(c as any, { brokerageId: b, contactId: id })
    if (!v.ok) return { personId: null, evidenceCount: null, error: `personForContact: ${v.reason}` }
    return { personId: v.view?.person?.id ?? null, evidenceCount: v.view ? v.view.evidence.length : null, error: null }
  },
  listing: async (b, subject, c) => {
    const q = c.from("listings").select("id, address, city, state, list_price, status, lifecycle_stage").eq("brokerage_id", b)
    const { data, error } = subject.type === "listing"
      ? await q.eq("id", subject.id).maybeSingle()
      : await q.eq("seller_contact_id", subject.id).order("created_at", { ascending: false }).limit(1).maybeSingle()
    return { row: error ? null : ((data as Record<string, any> | null) ?? null), error: error ? `listings read refused: ${msg(error)}` : null }
  },
  memory: async (b, id, c, now) => {
    const { loadContactMemoryForPrompt } = await import("@/lib/kernel/conversation-memory")
    return loadContactMemoryForPrompt({ contactId: id, brokerageId: b, client: c as any, now })
  },
  nba: async (b, contact, memory, c, now) => {
    const { loadContactNbaContext } = await import("@/lib/ai-isa/lead-action-plan")
    return loadContactNbaContext(c, { brokerageId: b, contact: contact as any, humanInitiated: false, now, preloaded: { memory } })
  },
  policy: async (b, manager, contactId, agentId, teamId, c) => {
    const { resolvePolicyRef, isaPolicyKey, managerPolicyKey } = await import("@/lib/kernel/tenant-policy")
    const { loadBrandPlaybookContext } = await import("@/lib/ai-isa/brand-playbook-context")
    const [isaPolicyRef, managerPolicyRef] = await Promise.all([
      resolvePolicyRef(c, b, isaPolicyKey("brokerage", b)),
      resolvePolicyRef(c, b, managerPolicyKey("authority_level", manager)),
    ])
    try {
      const pb = await loadBrandPlaybookContext({ brokerageId: b, agentId, teamId, contactId, managerKey: manager })
      return { isaPolicyRef, managerPolicyRef, brandBlock: pb.block, voice: pb.voice, error: null }
    } catch (e) {
      return { isaPolicyRef, managerPolicyRef, brandBlock: "", voice: null, error: `brand playbook: ${msg(e)}` }
    }
  },
  fatigue: async (b, id, c) => {
    const { data, error } = await c.from("buyer_fatigue_scores").select("risk_level, fatigue_score, last_calculated_at").eq("brokerage_id", b).eq("contact_id", id).maybeSingle()
    if (error) return { riskLevel: null, score: null, at: null, found: false, error: `buyer_fatigue_scores read refused: ${msg(error)}` }
    const r = data as { risk_level?: string | null; fatigue_score?: number | null; last_calculated_at?: string | null } | null
    return { riskLevel: r?.risk_level ?? null, score: typeof r?.fatigue_score === "number" ? r.fatigue_score : null, at: r?.last_calculated_at ?? null, found: !!r, error: null }
  },
  capacity: async (b, agentId, c, now) => {
    try {
      const { capacityFor } = await import("@/lib/lead-assignment/capacity-pick")
      const cap = await capacityFor(c as any, b, agentId, { now })
      // The guardian publishes the agent fatigue tier only as a band REASON ("agent fatigue critical").
      const tier = cap.reasons.map((r) => /^agent fatigue (\w+)$/.exec(r)?.[1] ?? null).find(Boolean) ?? null
      return { band: String(cap.band), load: Number(cap.load ?? 0), fatigueTier: tier, error: null }
    } catch (e) { return { band: "unknown", load: 0, fatigueTier: null, error: `capacityFor: ${msg(e)}` } }
  },
  authority: async (b, manager, c) => {
    const { resolveAgentAuthorityLevel } = await import("@/lib/managers/autonomy-gate")
    return resolveAgentAuthorityLevel(b, manager, c as any)
  },
  events: async (b, missionId, subject, c, limit) => {
    const [me, le] = await Promise.all([
      c.from("mission_events").select("event_kind, from_state, to_state, reason, created_at").eq("brokerage_id", b).eq("mission_id", missionId).order("created_at", { ascending: false }).limit(limit),
      subject
        ? c.from("lifecycle_events").select("event_type, metadata, created_at").eq("brokerage_id", b).eq("entity_type", subject.type).eq("entity_id", subject.id).order("created_at", { ascending: false }).limit(limit)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (me.error || le.error) return { rows: [], error: `events read refused: ${msg(me.error ?? le.error)}` }
    const rows: ContextEvent[] = [
      ...((me.data ?? []) as any[]).map((r) => ({ at: r.created_at, source: "mission_events" as const, kind: r.event_kind, summary: [r.from_state && r.to_state ? `${r.from_state}→${r.to_state}` : null, r.reason].filter(Boolean).join(" ") })),
      ...((le.data ?? []) as any[]).map((r) => ({ at: r.created_at, source: "lifecycle_events" as const, kind: r.event_type, summary: r.metadata?.reason ?? r.metadata?.summary ?? "" })),
    ]
    rows.sort((a, z) => (a.at < z.at ? 1 : a.at > z.at ? -1 : 0))
    return { rows: rows.slice(0, limit), error: null }
  },
  delegations: async (b, missionId, c) => {
    // INTEGRATION (wave 105): the delegation OBJECTS are the survivor (lib/kernel/manager-delegation.ts,
    // m712 APPLIED LIVE 2026-10-06) — read them first through the lane's own reader; the signal
    // channel below stays for feed-only signals addressed to the mission. A refused objects read
    // is PUBLISHED on the slice, never a silent 0.
    const objects: ContextDelegation[] = []
    let objectsRefused: string | null = null
    try {
      const { pendingDelegationsFor } = await import("./manager-delegation")
      const pd = await pendingDelegationsFor(b, { missionId }, c as any)
      if (pd.readRefused) objectsRefused = pd.readRefused
      for (const r of pd.pending) if (r.mission_id === missionId) objects.push({ id: r.id, from: r.requesting_manager, to: r.assigned_manager, kind: r.requested_capability, status: r.status, since: r.created_at, message: r.objective })
    } catch (e) { objectsRefused = `manager_delegations read refused: ${msg(e)}` }
    const { data, error } = await c.from("manager_signals").select("id, from_manager, to_manager, signal_type, status, message, created_at").eq("brokerage_id", b).eq("entity_type", "mission").eq("entity_id", missionId).order("created_at", { ascending: false }).limit(20)
    if (error) return { rows: [], error: `manager_signals read refused: ${msg(error)}` }
    const open = ((data ?? []) as any[]).filter((r) => r.status === "open")
    const rows = objects.concat(open.map((r) => ({ id: r.id, from: r.from_manager, to: r.to_manager, kind: r.signal_type, status: r.status, since: r.created_at, message: r.message })))
    return { rows, error: objectsRefused }
  },
  book: async (i, c) => {
    // THE COST LEDGER (CLAUDE.md §5) — the compile is evidence, not spend: tokens 0 / cost 0 (the
    // consumer's model call books the tokens it actually sends); the shape is the one
    // lib/video/plan-asset-readiness.ts bookImageSpend uses for a non-model row.
    const { data, error } = await c.from("ai_tool_usage").insert({
      user_id: null, brokerage_id: i.brokerageId, tool_name: "mission_context_compile", tokens_used: 0, model_used: null, cost_cents: 0,
      feature: "mission_context", manager: i.manager, success: true,
      context_json: { mission_id: i.missionId, rendered_tokens: i.tokens, token_budget: i.budget, truncated: i.truncated, blind_spots: i.blindSpots, slices: i.slices },
    }).select("id")
    if (error) return { booked: false, error: `ai_tool_usage insert refused: ${msg(error)}` }
    return { booked: ((data ?? []) as unknown[]).length === 1, error: null }
  },
}

async function svcOf(client?: Client): Promise<Client> {
  if (client) return client
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

export interface CompileInput {
  /** VERIFIED tenant (session / event / cron) — never a request body. */
  brokerageId: string
  missionId: string
  manager: ManagerKey
  tokenBudget: number
  audience?: "manager" | "agent"
  /** A tool registry to mount at the effective authority (names published on `tools.available`). */
  toolRegistry?: Record<string, unknown> | null
  eventLimit?: number
  client?: Client
  deps?: MissionContextDeps
  /** A CUSTOM manager's declared memory_access — only its admitted slices are read (absent = built-in, all). */
  memoryAccess?: CustomManagerMemoryAccess | null
}

const fmtDate = (v: unknown) => (typeof v === "string" ? v.slice(0, 16).replace("T", " ") : v instanceof Date ? v.toISOString().slice(0, 16).replace("T", " ") : "")

export async function compileManagerContext(input: CompileInput): Promise<CompileResult> {
  const d = { ...defaultDeps, ...(input.deps ?? {}) }
  if (!input.brokerageId) return { ok: false, reason: "no tenant" }
  if (!Number.isFinite(input.tokenBudget) || input.tokenBudget <= 0) return { ok: false, reason: "token budget must be a positive number" }
  const svc = await svcOf(input.client)
  const now = d.now()
  const at = now.toISOString()
  const audience = input.audience ?? "manager"
  const blind: BlindSpot[] = []
  const slice = <T,>(reader: string, data: T | null, refused: string | null = null): ContextSlice<T> => ({ reader, freshness: at, data, refused })
  const refuse = <T,>(name: string, reader: string, reason: string): ContextSlice<T> => { blind.push({ slice: name, reader, reason }); return slice<T>(reader, null, reason) }
  // memory_access: an unknown declared value admits only governance (fail closed); absent = a built-in manager.
  const admitted = input.memoryAccess == null ? null : (CONTEXT_SLICES_BY_MEMORY_ACCESS[input.memoryAccess] ?? CONTEXT_SLICES_BY_MEMORY_ACCESS.none)
  const may = (name: string) => admitted === null || admitted.has(name)
  const withheld = <T,>(): ContextSlice<T> => slice<T>(`withheld — memory_access ${String(input.memoryAccess)} does not admit this slice`, null)

  // ── mission (tenant-pinned; a foreign id is not_found, never another tenant's row) ──
  const m = await d.mission(input.brokerageId, input.missionId, svc)
  if (!m || m.brokerage_id !== input.brokerageId) return { ok: false, reason: "not_found" }
  const subject = m.subject_type && m.subject_id ? { type: m.subject_type, id: m.subject_id } : null
  const missionSlice = slice("lib/kernel/missions.ts getMission", {
    id: m.id, objective: m.objective, state: m.state, missionType: m.mission_type, ownerManager: m.owner_manager, participating: m.participating_managers ?? [],
    priority: m.priority, deadline: m.deadline, progress: m.progress ?? {}, successCriteria: m.success_criteria ?? [],
    blockers: (m.blockers ?? []).filter((b) => !b.cleared_at).map((b) => `${b.key}: ${b.reason}`), subject,
  })
  const working = may("working") ? slice("lib/kernel/missions.ts currentWorkingContext (missions.evidence kind working_context)", currentWorkingContext(m)) : withheld<WorkingContext>()

  // ── person: the contact row (once) + identity ──
  const contactId = subject?.type === "contact" ? subject.id : null
  let person: ManagerContext["person"] = slice<SliceData<"person">>("lib/kernel/mission-context.ts readContactRow + lib/kernel/person-identity.ts personForContact", null, null)
  let contact: Record<string, any> | null = null
  if (contactId && may("person")) {
    const c = await d.contactRow(input.brokerageId, contactId, svc)
    if (c.error) person = refuse("person", person.reader, c.error)
    else if (!c.row) person = refuse("person", person.reader, "contact not found in this brokerage")
    else {
      contact = c.row
      const idv = await d.identity(input.brokerageId, contactId, svc)
      if (idv.error) blind.push({ slice: "person.identity", reader: "lib/kernel/person-identity.ts personForContact", reason: idv.error })
      person = slice(person.reader, { row: c.row, identity: idv.error ? null : { personId: idv.personId, evidenceCount: idv.evidenceCount } })
    }
  }

  // ── property ──
  let property: ManagerContext["property"] = slice<SliceData<"property">>("lib/kernel/mission-context.ts readListing (listings by id / seller_contact_id)", null)
  if (subject && (subject.type === "listing" || subject.type === "contact") && may("property")) {
    const l = await d.listing(input.brokerageId, subject, svc)
    if (l.error) property = refuse("property", property.reader, l.error)
    else if (l.row) property = slice(property.reader, { listingId: l.row.id, address: [l.row.address, l.row.city, l.row.state].filter(Boolean).join(", "), status: l.row.status ?? null, lifecycleStage: l.row.lifecycle_stage ?? null, listPrice: typeof l.row.list_price === "number" ? l.row.list_price : null })
  }

  // ── memory (read once) → opportunity / tasks (the NBA reader, handed the memory) ──
  let memory: ManagerContext["memory"] = slice<SliceData<"memory">>("lib/kernel/conversation-memory.ts loadContactMemoryForPrompt", null)
  let opportunity: ManagerContext["opportunity"] = slice<SliceData<"opportunity">>("lib/ai-isa/lead-action-plan.ts loadContactNbaContext (activities / showings / tasks / relationship graph / dead ends)", null)
  if (contact && contactId) {
    // Long-term memory is read ONLY when admitted; the NBA reader is then handed null (preloaded) and never reads it itself.
    const mem = may("memory") ? await d.memory(input.brokerageId, contactId, svc, now) : null
    if (may("memory")) memory = slice(memory.reader, mem)
    if (may("opportunity")) {
      const nba = await d.nba(input.brokerageId, contact, mem, svc, now)
      opportunity = nba.ok ? slice(opportunity.reader, nba.context) : refuse("opportunity", opportunity.reader, nba.error)
    }
  }
  if (!may("memory")) memory = withheld<SliceData<"memory">>()
  if (!may("opportunity")) opportunity = withheld<SliceData<"opportunity">>()
  if (!may("person")) person = withheld<SliceData<"person">>()
  if (!may("property")) property = withheld<SliceData<"property">>()

  // ── policy + brand ──
  const pol = await d.policy(input.brokerageId, input.manager, contactId, contact?.agent_id ?? null, contact?.team_id ?? null, svc)
  const policyReader = "lib/kernel/tenant-policy.ts resolvePolicyRef + lib/ai-isa/brand-playbook-context.ts loadBrandPlaybookContext"
  if (pol.error) blind.push({ slice: "policy.brand", reader: policyReader, reason: pol.error })
  if (pol.isaPolicyRef.endsWith("@unknown") || pol.managerPolicyRef.endsWith("@unknown")) blind.push({ slice: "policy.version", reader: policyReader, reason: "tenant_policy_versions read refused — version @unknown" })
  const policy = slice(policyReader, { isaPolicyRef: pol.isaPolicyRef, managerPolicyRef: pol.managerPolicyRef, brandBlock: pol.brandBlock, voice: pol.voice }, pol.error)

  // ── fatigue (contact scope) + capacity (agent scope) ──
  let fatigue: ManagerContext["fatigue"] = slice<SliceData<"fatigue">>("buyer_fatigue_scores (lib/fatigue calculateFatigue's score row, read as lib/kernel/deconflict reads it)", null)
  if (contactId && may("fatigue")) {
    const f = await d.fatigue(input.brokerageId, contactId, svc)
    fatigue = f.error ? refuse("fatigue", fatigue.reader, f.error) : f.found ? slice(fatigue.reader, { riskLevel: f.riskLevel, score: f.score, at: f.at }) : slice<SliceData<"fatigue">>(fatigue.reader, null)
  }
  let capacity: ManagerContext["capacity"] = slice<SliceData<"capacity">>("lib/lead-assignment/capacity-pick.ts capacityFor", null)
  const agentId = (contact?.agent_id as string | null | undefined) ?? null
  if (agentId && may("capacity")) {
    const cap = await d.capacity(input.brokerageId, agentId, svc, now)
    capacity = cap.error ? refuse("capacity", capacity.reader, cap.error) : slice(capacity.reader, { agentId, band: cap.band, load: cap.load, fatigueTier: cap.fatigueTier })
  }

  if (!may("fatigue")) fatigue = withheld<SliceData<"fatigue">>()
  if (!may("capacity")) capacity = withheld<SliceData<"capacity">>()

  // ── events + delegations ──
  const ev = may("events") ? await d.events(input.brokerageId, m.id, subject, svc, input.eventLimit ?? 12) : null
  const events = !ev ? withheld<ContextEvent[]>() : ev.error ? refuse<ContextEvent[]>("events", "mission_events + lifecycle_events (newest first)", ev.error) : slice("mission_events + lifecycle_events (newest first)", ev.rows)
  const dl = may("delegations") ? await d.delegations(input.brokerageId, m.id, svc) : null
  const delegReader = "lib/kernel/manager-delegation.ts pendingDelegationsFor (manager_delegations) + open manager_signals addressed to the mission"
  const delegations = !dl ? withheld<ContextDelegation[]>() : dl.error ? refuse<ContextDelegation[]>("delegations", delegReader, dl.error) : slice(delegReader, dl.rows)

  // ── authority / tools ──
  let managerAuthority: AuthorityLevel = DEFAULT_AUTHORITY_LEVEL
  let toolsRefused: string | null = null
  try { managerAuthority = await d.authority(input.brokerageId, input.manager, svc) } catch (e) { toolsRefused = `resolveAgentAuthorityLevel: ${msg(e)}`; managerAuthority = 0 }
  const ceiling = m.authority_ceiling
  const effective = Math.min(managerAuthority, ceiling) as AuthorityLevel
  const available = input.toolRegistry ? Object.keys(selectToolsForPersona(input.toolRegistry, { authorityLevel: effective })) : null
  const toolsReader = "lib/managers/autonomy-gate.ts resolveAgentAuthorityLevel ∧ missions.authority_ceiling → lib/ai-isa/persona-tool-policy.ts selectToolsForPersona"
  if (toolsRefused) blind.push({ slice: "tools", reader: toolsReader, reason: `${toolsRefused} — authority failed closed to 0` })
  const tools = slice(toolsReader, { managerAuthority, ceiling, effective, available }, toolsRefused)

  // ── budget (the row; agents never see cost) ──
  const usdCap = typeof m.budget?.usd === "number" ? m.budget.usd : null
  const tokCap = typeof m.budget?.tokens === "number" ? m.budget.tokens : null
  const budget = audience === "agent" ? null : slice("missions.budget / spent_usd / spent_tokens (lib/kernel/missions.ts budgetExhausted)", {
    usdCap, usdSpent: Number(m.spent_usd ?? 0), usdRemaining: usdCap === null ? null : Math.max(0, usdCap - Number(m.spent_usd ?? 0)),
    tokenCap: tokCap, tokensSpent: Number(m.spent_tokens ?? 0), tokensRemaining: tokCap === null ? null : Math.max(0, tokCap - Number(m.spent_tokens ?? 0)),
    exhausted: budgetExhausted(m.budget ?? {}, Number(m.spent_usd ?? 0), Number(m.spent_tokens ?? 0)),
  })

  const context: ManagerContext = {
    brokerageId: input.brokerageId, missionId: m.id, manager: input.manager, audience, compiledAt: at,
    mission: missionSlice, working, person, property, opportunity, memory, policy, fatigue, capacity, events, delegations, tools, budget, blindSpots: blind,
  }
  const rendered = renderManagerContextSection(context, input.tokenBudget)
  const slices = (Object.keys(context) as Array<keyof ManagerContext>).filter((k) => (context[k] as any)?.reader && (context[k] as any)?.data !== null) as string[]
  const booked = await d.book({ brokerageId: input.brokerageId, manager: input.manager, missionId: m.id, tokens: rendered.tokens, budget: input.tokenBudget, truncated: rendered.truncated, blindSpots: blind.length, slices }, svc)
  if (!booked.booked) console.error(`[mission-context] compile not booked on ai_tool_usage: ${booked.error ?? "no row"}`)
  return { ok: true, context, section: rendered.section, tokens: rendered.tokens, tokenBudget: input.tokenBudget, truncated: rendered.truncated }
}

/** Mount a tool registry at the context's EFFECTIVE authority (manager rung ∧ mission ceiling). */
export function mountToolsFromContext<T extends Record<string, unknown>>(ctx: ManagerContext, registry: T): Partial<T> {
  return selectToolsForPersona(registry, { authorityLevel: ctx.tools.data?.effective ?? 0 })
}

// ─── rendering: priority-ordered slices, most-recent-first truncation, honest marker ───────────
export const TRUNCATED_MARKER = "[truncated to fit the token budget"

interface Block { name: string; lines: string[]; priority: number; recentFirst: boolean }

/** PURE. Lines per slice, in priority order (lowest number = kept longest). @proofSeam the proof asserts the budget rule on this directly. */
export function contextBlocks(ctx: ManagerContext): Block[] {
  const blocks: Block[] = []
  const add = (name: string, priority: number, lines: string[], recentFirst = false) => { if (lines.length) blocks.push({ name, lines, priority, recentFirst }) }
  const refusedLine = <T,>(s: ContextSlice<T>) => (s.refused ? [`(unreadable — ${s.refused})`] : [])
  const md = ctx.mission.data!
  add("mission", 0, [
    `MISSION (${ctx.mission.reader}, as of ${fmtDate(ctx.mission.freshness)}): "${md.objective}" — ${md.state}, ${md.priority}, owner ${md.ownerManager}${md.participating.length ? `, with ${md.participating.join("/")}` : ""}${md.deadline ? `, due ${fmtDate(md.deadline)}` : ""}`,
    ...(md.successCriteria.length ? [`  criteria: ${md.successCriteria.map((c) => `${c.metric} ${c.op} ${c.target} (now ${md.progress[c.metric] ?? "unknown"})`).join("; ")}`] : []),
    ...(md.blockers.length ? [`  blockers: ${md.blockers.join("; ")}`] : []),
  ])
  const w = ctx.working.data
  if (w) add("working", 1, [
    `WORKING CONTEXT (${ctx.working.reader}, updated ${fmtDate(w.updated_at)}):`,
    ...(w.objective_now ? [`  now: ${w.objective_now}`] : []),
    ...(w.waiting_on ? [`  waiting on: ${w.waiting_on.who} — ${w.waiting_on.what} (since ${fmtDate(w.waiting_on.since)})`] : []),
    ...((w.open_requests ?? []).map((r) => `  open request → ${r.to}: ${r.what} (since ${fmtDate(r.since)})`)),
    ...(w.availability ? [`  availability: ${JSON.stringify(w.availability)}`] : []),
    ...((w.notes ?? []).map((n) => `  note: ${n}`)),
  ])
  const p = ctx.person.data
  add("person", 2, p ? [
    `PERSON (${ctx.person.reader}): ${[p.row.first_name, p.row.last_name].filter(Boolean).join(" ") || p.row.id} — ${p.row.contact_type ?? "contact"}${p.row.contact_persona ? ` / ${p.row.contact_persona}` : ""}${p.row.buyer_stage ? `, stage ${p.row.buyer_stage}` : ""}${p.row.timeline ? `, timeline ${p.row.timeline}` : ""}${p.row.motivation_type ? `, motivation ${p.row.motivation_type}` : ""}${p.identity?.personId ? `, person ${p.identity.personId.slice(0, 8)} (${p.identity.evidenceCount ?? "?"} evidence)` : ""}`,
    ...(p.row.ai_outreach_paused ? ["  AI outreach PAUSED by a human"] : []),
  ] : refusedLine(ctx.person))
  const o = ctx.opportunity.data
  add("opportunity", 3, o ? [
    `OPPORTUNITY (${ctx.opportunity.reader}):${o.intent ? ` intent ${o.intent.score} (${o.intent.trend})` : " no decayed intent"}${(o.deadEnds ?? []).length ? `; dead ends: ${(o.deadEnds ?? []).map((x) => x.outcome).join(", ")}` : ""}${(o.householdContactIds ?? []).length ? `; household of ${(o.householdContactIds ?? []).length + 1}` : ""}`,
    `  TASKS: ${[o.appointmentAt ? `appointment ${fmtDate(o.appointmentAt)}` : null, o.callbackRequested ? `callback pending${o.callbackDueAt ? ` due ${fmtDate(o.callbackDueAt)}` : ""}` : null, o.lastAgentTouchAt ? `agent touched ${fmtDate(o.lastAgentTouchAt)}` : null].filter(Boolean).join("; ") || "nothing scheduled"}`,
  ] : refusedLine(ctx.opportunity))
  const pr = ctx.property.data
  add("property", 4, pr ? [`PROPERTY (${ctx.property.reader}): ${pr.address || pr.listingId} — ${pr.status ?? "?"}${pr.lifecycleStage ? ` / ${pr.lifecycleStage}` : ""}${pr.listPrice ? `, listed $${pr.listPrice.toLocaleString()}` : ""}`] : refusedLine(ctx.property))
  const mem = ctx.memory.data
  add("memory", 5, mem?.block?.trim() ? [`MEMORY (${ctx.memory.reader}):`, ...mem.block.split("\n").map((l) => `  ${l}`)] : [])
  const pol = ctx.policy.data
  add("policy", 6, pol ? [`POLICY (${ctx.policy.reader}): ${pol.isaPolicyRef}; ${pol.managerPolicyRef}`, ...(pol.brandBlock ? pol.brandBlock.split("\n").map((l) => `  ${l}`) : []), ...refusedLine(ctx.policy)] : refusedLine(ctx.policy))
  const f = ctx.fatigue.data
  add("fatigue", 7, f ? [`FATIGUE (${ctx.fatigue.reader}): ${f.riskLevel ?? "unscored"}${f.score !== null ? ` (${f.score})` : ""}${f.at ? ` as of ${fmtDate(f.at)}` : ""}`] : refusedLine(ctx.fatigue))
  const c = ctx.capacity.data
  add("capacity", 8, c ? [`AGENT CAPACITY (${ctx.capacity.reader}): ${c.band}, load ${c.load}${c.fatigueTier ? `, retention tier ${c.fatigueTier}` : ""}`] : refusedLine(ctx.capacity))
  const dl = ctx.delegations.data
  add("delegations", 9, dl ? (dl.length ? [`PENDING DELEGATIONS (${ctx.delegations.reader}):`, ...dl.map((x) => `  ${x.from} → ${x.to}: ${x.kind} [${x.status}] since ${fmtDate(x.since)}${x.message ? ` — ${x.message}` : ""}`)] : []) : refusedLine(ctx.delegations))
  const t = ctx.tools.data
  add("tools", 10, t ? [`AUTHORITY (${ctx.tools.reader}): manager rung ${t.managerAuthority}, mission ceiling ${t.ceiling} → effective ${t.effective}${t.available ? `; tools: ${t.available.join(", ") || "none"}` : ""}`, ...refusedLine(ctx.tools)] : [])
  if (ctx.budget?.data) {
    const b = ctx.budget.data
    add("budget", 11, [`BUDGET (${ctx.budget.reader}): $${b.usdSpent.toFixed(2)} spent${b.usdCap !== null ? ` of $${b.usdCap.toFixed(2)} ($${(b.usdRemaining ?? 0).toFixed(2)} left)` : " (unmetered)"}; ${b.tokensSpent} tokens${b.tokenCap !== null ? ` of ${b.tokenCap}` : ""}${b.exhausted ? " — EXHAUSTED" : ""}`])
  }
  const ev = ctx.events.data
  add("events", 12, ev ? (ev.length ? [`RECENT EVENTS (${ctx.events.reader}):`, ...ev.map((e) => `  ${fmtDate(e.at)} ${e.source === "mission_events" ? "mission" : "lifecycle"} ${e.kind}${e.summary ? `: ${e.summary}` : ""}`)] : []) : refusedLine(ctx.events), true)
  if (ctx.blindSpots.length) add("blind_spots", 1, [`BLIND SPOTS (reads that were refused — do not assume these are fine): ${ctx.blindSpots.map((b) => `${b.slice} via ${b.reader}: ${b.reason}`).join(" | ")}`])
  return blocks
}

/** PURE. Renders ≤ budget tokens: lowest-priority blocks lose their LAST lines first (an events
 *  block, newest first, therefore keeps its newest rows); the header line of a block is cut last. */
export function renderManagerContextSection(ctx: ManagerContext, tokenBudget: number): { section: string; tokens: number; truncated: boolean } {
  const blocks = contextBlocks(ctx).sort((a, b) => a.priority - b.priority)
  const render = (bs: Block[], omitted: number) => {
    const body = bs.filter((b) => b.lines.length).map((b) => b.lines.join("\n")).join("\n")
    return omitted > 0 ? `${body}\n${TRUNCATED_MARKER}: ${omitted} line${omitted === 1 ? "" : "s"} omitted, oldest and lowest-priority first]` : body
  }
  let omitted = 0
  let out = render(blocks, omitted)
  while (estimateTokens(out) > tokenBudget) {
    const victim = [...blocks].reverse().find((b) => b.lines.length > 1) ?? [...blocks].reverse().find((b) => b.lines.length > 0 && b.priority > 0)
    if (!victim) break // only the mission header remains — the floor, never an empty section
    victim.lines.pop(); omitted++
    out = render(blocks, omitted)
  }
  return { section: out, tokens: estimateTokens(out), truncated: omitted > 0 }
}
