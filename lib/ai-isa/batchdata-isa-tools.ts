/**
 * lib/ai-isa/batchdata-isa-tools.ts
 *
 * Cost-aware BatchData MCP tool set for the AI ISA and AI agents — wave 71,
 * owner verbatim: "if you follow these batchdata instructions using vercel sdk
 * we can create so many great capabilities especially for our ai isa or ai
 * agents." Built on top of the SAME transport lib/external/batchdata-mcp.ts
 * already provides (official @modelcontextprotocol/sdk client) — this is NOT a
 * second MCP client, it is a second, PERSONA-SCOPED, COST-GOVERNED tool
 * registry over it, distinct from lib/external/batchdata-ai-tools.ts's
 * `batchDataMcpTools` (which exposes the account's ENTIRE discovered tool
 * catalogue, ungoverned, to the in-app agent copilot). That registry stays as
 * it is; this one is deliberately narrower and adds three things it does not
 * have: a PERSONA allowlist (never skip-trace/owner-contact tools for an
 * investor — wave 68/69 ruling), an ORDERING rule (no billed "page" pull
 * before a free/cheap preview or count established the criteria is worth
 * paying for), and a PER-CONVERSATION SPEND BUDGET.
 *
 * PERSONAS
 *   "isa"      — seller/buyer qualification during an ISA conversation
 *                (inbound email, live avatar). Gets lookup_property,
 *                search_properties_preview/count, verify_address,
 *                verify_phone, check_dnc_status, check_tcpa_status,
 *                comparable_property_preview/count. No `page` tool — the ISA
 *                qualifies ONE lead's own property context, never bulk-walks
 *                a market.
 *   "investor" — the investor portal's AI surface. Gets
 *                search_properties_preview/count/page, comparable_property_
 *                preview/count, investor_buybox_preview/count — property
 *                fields ONLY. NEVER skip_trace_property, reverse_skip_trace,
 *                or any owner-contact tool, full stop; those names are not in
 *                either persona's registry, so there is nothing to gate at
 *                call time — the capability itself does not exist for this
 *                persona (wave 68 owner ruling: "we don't want the investor
 *                to try and buy directly to the owner"). Every row this
 *                persona's tools return is passed through
 *                `toInvestorFacingToolRow` — the SAME allowlist shape
 *                lib/buyer-search/investor-facing.ts's reader-boundary
 *                redaction uses for the off-market portal cards (one
 *                vocabulary, §6) — before the model ever sees it.
 *
 * GATING (integrator correction, wave 71): gate on whatever
 * lib/external/batchdata-mcp.ts already resolves its token from —
 * `resolveBatchDataToken("mcp")` (BATCHDATA_MCP_AUTH, falling back to
 * BATCHDATA_API_KEY) — never a second, invented env var. No token resolvable
 * → `{}` (no tools), never a tool that errors on every call. FAIL CLOSED.
 *
 * ORDERING. A `_page` tool (billed, full record pull) is REFUSED unless a
 * `_preview` or `_count` call for the SAME criteria (address/city/state/zip,
 * case-insensitively) already ran earlier in this conversation. State is kept
 * in a module-level map keyed by `ctx.conversationKey` (leadId for the ISA's
 * inbound-email handler, embedSessionId/contactId for the live avatar) —
 * scoped to ONE conversation, swept on a TTL so a long-lived server process
 * never grows this map unbounded (same posture as batchdata-ai-tools.ts's
 * tool-catalogue cache).
 *
 * BUDGET. `BATCHDATA_ISA_BUDGET_CENTS` (default 200 = $2.00) caps total
 * BatchData spend for one conversation. A call that would exceed the budget
 * is refused with a clear tool result — never silently degraded, never
 * charged. The refusal is data the model can relay to the human, not a thrown
 * error that breaks the turn.
 *
 * METERING. Every EXECUTED (non-refused) call records platform spend via
 * `meterVendorSpend` — brokerage-attributed for cost tracking, NEVER a tenant
 * charge (CLAUDE.md §5, wave 70: "batchdata is platform spend"). The
 * enclosing `streamTextRouted`/`generateTextRouted` call (passed `manager:
 * "ai_isa"`) writes the `ai_tool_usage` row for the TURN the same way
 * app/api/internal/ai-chat/route.ts already does — this file adds no second
 * ai_tool_usage writer, only the vendor-ledger row per tool call.
 *
 * DNC/TCPA — NEVER BYPASSES THE OUTBOUND GATE. check_dnc_status's verdict is
 * returned to the model AND persisted to `contacts.dnc_status` +
 * `dnc_verified_at` — the EXACT columns lib/communication/tcpa-gate.ts reads
 * (`isDncTcpaVerdictFresh`) and stamps itself on its own live re-check. A
 * fresh verdict this tool wrote lets the NEXT outbound send inside the
 * freshness window skip its own live BatchData call; it never weakens or
 * substitutes for the gate, which still runs on every send. check_tcpa_status
 * has no persistent column (the gate re-verifies TCPA-litigator status live
 * every send, by design — CLAUDE.md "only write columns that exist") so its
 * verdict is returned to the model only. verify_phone / verify_address write
 * `contacts.phone_verified` + `phone_verification_date` /
 * `mailing_address_verified` + `mailing_address_verified_at` — columns that
 * already exist on the live `contacts` table (scripts/schema-snapshot.ts).
 * All three writes go through `sentinelWrite` (never a bare unread `.update`)
 * and are skipped entirely when `ctx.contactId` is not known (an anonymous
 * pre-capture conversation still gets the flag back for the model, it just
 * has no tenant-scoped row to persist it to).
 *
 * LANE 73B — PERSONA CATALOGUE WIDENED, GATING NOW POLICY-DRIVEN. The two
 * hand-rolled personas above ("isa" as a buyer/seller catch-all, "investor")
 * are RETIRED in favor of `lib/ai-isa/persona-tool-policy.ts`'s `ToolPersona`
 * (buyer/seller/investor/renter/relocation/sphere), derived from the SAME
 * contact_type/contact_persona/home_owner_status vocabulary every mounting
 * surface already reads (never a second vocabulary — CLAUDE.md §6). Every
 * `if (ctx.persona === "isa" | "investor")` gate below is now
 * `isToolAllowedForPersona(ctx.persona, "<name>")` against that file's ONE
 * policy table, and the whole registry is filtered a SECOND time through the
 * platform's `BATCHDATA_TOOL_TIER` (full/lean/off, auto-downgraded on monthly
 * spend) before it is returned — see persona-tool-policy.ts's header for both
 * rulings in full. investor/property-only redaction behavior is UNCHANGED;
 * it is now applied to every persona `persona-tool-policy.ts` marks
 * "property-only" (buyer, investor, renter, relocation), not only "investor".
 */

import { tool } from "ai"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { toTenDigits } from "@/lib/compliance/phone-scrub"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"
import { resolveBatchDataToken } from "@/lib/external/batchdata-tokens"
import { MCP_TOOL_CALL_COST_USD } from "@/lib/external/batchdata-ai-tools"
import { deriveLikelihoodBand } from "@/lib/buyer-search/investor-offmarket-match"
import {
  callBatchDataMcp,
  extractRows,
  comparablePropertyPreview,
  comparablePropertyCount,
  investorBuyboxPreview,
  investorBuyboxCount,
  checkDncStatus,
  checkTcpaStatus,
  verifyPhone as mcpVerifyPhone,
  type BuyBoxMatchRow,
} from "@/lib/external/batchdata-mcp"
import {
  type ToolPersona,
  PERSONA_TOOL_POLICY,
  isToolAllowedForPersona,
  redactionModeForPersona,
  resolveEffectiveBatchDataToolTier,
  filterToolsByTier,
} from "@/lib/ai-isa/persona-tool-policy"

/** @deprecated alias for `ToolPersona` (lib/ai-isa/persona-tool-policy.ts) — kept so any
 *  external importer of the old name keeps compiling; every new caller should import
 *  `ToolPersona` directly. */
export type BatchDataIsaPersona = ToolPersona
export type { ToolPersona }

export interface BatchDataIsaToolsContext {
  brokerageId: string
  userId?: string | null
  agentId?: string | null
  /** buyer | seller | investor | renter | relocation | sphere — lib/ai-isa/persona-tool-
   *  policy.ts's ToolPersona, derived by the CALLER (resolveToolPersona) from the contact/
   *  lead's own contact_type/contact_persona/home_owner_status, never from a request body. */
  persona: ToolPersona
  /** Stable key scoping ordering + spend-budget state to ONE conversation — never shared
   *  across tenants or conversations. leadId for the ISA's inbound-email handler;
   *  embedSessionId (preferred) or contactId for the live avatar (custom-llm route). */
  conversationKey: string
  /** contacts.id, when known — lets check_dnc_status/verify_phone/verify_address persist
   *  their verdict onto the SAME columns the outbound TCPA gate reads. Omit for an
   *  anonymous/pre-capture conversation; the tool still runs, it just has nothing
   *  tenant-scoped to write to. */
  contactId?: string | null
  /** Declares this conversation outbound-eligible — required (default false, fail closed)
   *  before the "sphere" persona's verify_phone/check_dnc_status/check_tcpa_status tools are
   *  registered at all. A sphere-of-influence/referral contact is not being sold a
   *  property; those tools exist ONLY to confirm a number is safe to call before the
   *  outbound gate (lib/communication/tcpa-gate.ts) itself runs, never as a substitute for
   *  it and never as general-purpose lookups for a persona with no property need. */
  outboundEligible?: boolean
}

// ─── PER-CONVERSATION STATE — ordering + spend budget ──────────────────────────────
// Module-level, swept on a TTL. NOT a substitute for a durable ledger (meterVendorSpend
// below is that ledger); this is purely in-process bookkeeping for "did a preview/count
// already run for this criteria" and "how much has this conversation spent so far,"
// which only needs to survive the life of one conversation, not a process restart.

interface ConversationState {
  seenCriteria: Set<string>
  spentCents: number
  lastTouchedAt: number
}

const CONVERSATIONS = new Map<string, ConversationState>()
const CONVERSATION_STATE_TTL_MS = 2 * 60 * 60 * 1000 // 2h — long enough for one live conversation

function getConversationState(key: string): ConversationState {
  const now = Date.now()
  // Opportunistic sweep on access — same posture as batchdata-ai-tools.ts's TTL cache;
  // no background timer, so a cold process never pays for a sweep nobody asked for.
  for (const [k, v] of CONVERSATIONS) {
    if (now - v.lastTouchedAt > CONVERSATION_STATE_TTL_MS) CONVERSATIONS.delete(k)
  }
  let state = CONVERSATIONS.get(key)
  if (!state) {
    state = { seenCriteria: new Set(), spentCents: 0, lastTouchedAt: now }
    CONVERSATIONS.set(key, state)
  }
  state.lastTouchedAt = now
  return state
}

export type ToolFamily = "search_properties" | "comparable_property" | "investor_buybox"

export interface CriteriaArgs {
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/** PURE — case-insensitive criteria key so "123 Main St"/"123 MAIN ST" are the same
 *  criteria for ordering purposes. */
export function criteriaKey(args: CriteriaArgs): string {
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()
  return `${norm(args.address)}|${norm(args.city)}|${norm(args.state)}|${norm(args.zip)}`
}

const DEFAULT_BUDGET_CENTS = 200 // $2.00/conversation — documented default for BATCHDATA_ISA_BUDGET_CENTS

/** PURE — the per-conversation BatchData spend cap in cents. Env override must be a
 *  positive finite number; anything else (unset, "abc", 0, negative) falls back to the
 *  documented default rather than silently disabling the budget (fail closed). */
export function resolveBatchDataIsaBudgetCents(): number {
  const raw = process.env.BATCHDATA_ISA_BUDGET_CENTS
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_CENTS
}

/** @proofSeam PURE — the EFFECTIVE per-conversation cap for `persona`: the tighter of the
 *  env-wide ceiling (resolveBatchDataIsaBudgetCents) and that persona's OWN cap
 *  (PERSONA_TOOL_POLICY[persona].capCents — e.g. buyer $1.00, renter $0.00). An env
 *  override can only ever TIGHTEN a persona's spend, never loosen it past what the policy
 *  table grants — a platform operator raising BATCHDATA_ISA_BUDGET_CENTS must not
 *  accidentally hand the renter persona a BatchData budget it has no tools to spend. */
export function resolvePersonaBudgetCents(persona: ToolPersona): number {
  return Math.min(resolveBatchDataIsaBudgetCents(), PERSONA_TOOL_POLICY[persona].capCents)
}

export type ToolRefusal = { success: false; error: string }

/** @proofSeam PURE decision core for the per-conversation spend budget — exercised
 *  directly by scripts/batchdata-isa-tools-simulator.ts (never a call through
 *  batchDataIsaTools()'s network-touching execute()); the closures inside
 *  batchDataIsaTools below are its only production caller, in the SAME file.
 *  Mirrors lib/communication/tcpa-gate.ts's evaluateFreshScrubVerdict pattern: the
 *  refusal decision is pure and unit-testable, the I/O around it is not. */
export function evaluateBudget(spentCents: number, budgetCents: number, costUsd: number): ToolRefusal | null {
  const costCents = Math.round(costUsd * 100)
  if (spentCents + costCents > budgetCents) {
    return {
      success: false,
      error: `BatchData spend budget for this conversation is exhausted ($${(spentCents / 100).toFixed(2)} of $${(budgetCents / 100).toFixed(2)} used) — this lookup was refused rather than overspending. Ask a human before requesting another BatchData lookup for this conversation.`,
    }
  }
  return null
}

/** @proofSeam PURE decision core for the page-before-preview/count ordering rule —
 *  same testing posture as evaluateBudget above. */
export function evaluatePageOrder(seenCriteria: ReadonlySet<string>, family: ToolFamily, args: CriteriaArgs): ToolRefusal | null {
  if (seenCriteria.has(`${family}:${criteriaKey(args)}`)) return null
  return {
    success: false,
    error: `A billed "page" pull for this criteria was refused — call the matching preview or count tool for the SAME address/city/state/zip first so this conversation only pays for a full record pull once it knows it's worth it.`,
  }
}

// ─── INVESTOR REDACTION — property fields ONLY ─────────────────────────────────────
// Wave 68/69 owner ruling: "these investors should not get the owners information...
// that is just showing them the properties nothing else." This is an ALLOWLIST (not a
// blacklist like lib/buyer-search/investor-facing.ts uses for the already-typed
// investor_offmarket_candidates row) because a raw MCP tool response's shape is not a
// typed row this repo controls — batchdata-mcp.ts's own readers (readMcpFlag,
// extractRows) are deliberately tolerant across several plausible field-name variants
// for the same reason. An allowlist can never leak a field this file's author didn't
// anticipate; a blacklist can.
export interface InvestorFacingPropertyRow {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  estimatedValue: number | null
  beds: number | null
  baths: number | null
  propertyType: string | null
  quickListTags: string[]
  likelihoodBand: "high" | "medium" | "low"
  /** "batchrank" when a licensed BatchRank verdict was on the row, "signal-based" when
   *  derived from quicklists — the portal UI must label the difference (wave 69). */
  likelihoodBandSource: "batchrank" | "signal-based"
}

function readBatchrankBand(row: Record<string, unknown>): "high" | "medium" | "low" | null {
  const intel = row.intel as Record<string, unknown> | undefined
  const raw = intel?.salePropensityCategory ?? row.batchRankCategory ?? row.batchrankCategory ?? null
  const s = typeof raw === "string" ? raw.toLowerCase() : null
  return s === "high" || s === "medium" || s === "low" ? s : null
}

/** @proofSeam the investor persona's tool-result mapper — asserted directly by
 *  scripts/batchdata-isa-tools-simulator.ts against a fixture row carrying owner_name/
 *  owner_phone/owner_email/equity fields (positive control: the SAME fixture read
 *  through the "isa" (identity) mapper below still carries them). */
export function toInvestorFacingToolRow(row: BuyBoxMatchRow): InvestorFacingPropertyRow {
  const addr = (row.address as Record<string, unknown>) ?? {}
  const building = (row.building as Record<string, unknown>) ?? {}
  const valuation = (row.valuation as Record<string, unknown>) ?? {}
  const quickListsRaw =
    (Array.isArray(row.quickLists) && row.quickLists) ||
    (Array.isArray(row.quick_lists) && row.quick_lists) ||
    (Array.isArray(row.tags) && row.tags) ||
    []
  const quickListTags = (quickListsRaw as unknown[]).filter((x): x is string => typeof x === "string")
  const { band, source } = deriveLikelihoodBand(quickListTags, readBatchrankBand(row))

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

  return {
    address: str(addr.street) ?? str(row.propertyAddress) ?? str(row.address) ?? null,
    city: str(addr.city) ?? str(row.propertyCity) ?? null,
    state: str(addr.state) ?? str(row.propertyState) ?? null,
    zip: str(addr.zip) ?? str(row.propertyZip) ?? null,
    estimatedValue: num(valuation.estimatedValue) ?? num(row.estimatedValue) ?? null,
    beds: num(building.bedroomCount) ?? num(row.beds) ?? null,
    baths: num(building.bathroomCount) ?? num(row.baths) ?? null,
    propertyType: str(building.propertyType) ?? str(row.propertyType) ?? null,
    quickListTags,
    likelihoodBand: band,
    likelihoodBandSource: source,
  }
}

/** ISA persona mapper — deliberately the IDENTITY function. The ISA qualifies a known
 *  lead/contact's own property context and needs whatever the row carries (owner name
 *  on a seller's own home is not "someone else's owner data"). Named so the two personas'
 *  mapping is symmetric and readable at each tool's call site, and so the simulator has
 *  a positive control: this mapper keeps owner/equity/contact fields, the investor one
 *  strips them from the SAME fixture row. */
export function toIsaFacingToolRow(row: BuyBoxMatchRow): BuyBoxMatchRow {
  return row
}

function mapRows(persona: ToolPersona, rows: BuyBoxMatchRow[]): unknown[] {
  return redactionModeForPersona(persona) === "property-only"
    ? rows.map(toInvestorFacingToolRow)
    : rows.map(toIsaFacingToolRow)
}

/** The zod schema below models "no city given" as `null` (an LLM-friendly explicit
 *  value); batchdata-mcp.ts's typed wrappers model it as `undefined` (a plain optional
 *  field). Converts at the boundary rather than loosening either side's type. */
function forTypedWrapper(args: CriteriaArgs): { address: string; city?: string; state?: string; zip?: string } {
  return {
    address: args.address ?? "",
    city: args.city ?? undefined,
    state: args.state ?? undefined,
    zip: args.zip ?? undefined,
  }
}

// ─── TOOL SET ───────────────────────────────────────────────────────────────────────

const AddressCriteriaShape = {
  address: z.string().describe("Street address"),
  city: z.string().nullable().describe("City, or null"),
  state: z.string().nullable().describe("Two-letter state code, or null"),
  zip: z.string().nullable().describe("ZIP code, or null"),
}

const PhoneShape = {
  phone: z.string().describe("Phone number, any common US format"),
}

/**
 * batchDataIsaTools — the persona-scoped, cost-governed AI-SDK tool map:
 *
 *   tools: { ...isaTools, ...(await batchDataIsaTools({ brokerageId, userId, persona: "isa", conversationKey: leadId, contactId })) }
 *
 * Returns `{}` when BatchData's MCP is not configured (resolveBatchDataToken("mcp") —
 * the SAME resolver lib/external/batchdata-mcp.ts itself uses, never a second env var),
 * or when brokerageId/conversationKey are missing (§4 — never a tenant-less or
 * conversation-less tool surface).
 */
export async function batchDataIsaTools(ctx: BatchDataIsaToolsContext): Promise<Record<string, unknown>> {
  if (!resolveBatchDataToken("mcp")) return {}
  if (!ctx.brokerageId || !ctx.conversationKey) return {}

  const state = getConversationState(ctx.conversationKey)
  const budgetCents = resolvePersonaBudgetCents(ctx.persona)

  /** Refuses BEFORE any BatchData call and BEFORE any metering when the call would push
   *  this conversation over its budget. Returns null when the call may proceed. Delegates
   *  to the pure decision core (evaluateBudget) so the simulator can test the rule without
   *  touching network. */
  function budgetRefusal(costUsd: number): ToolRefusal | null {
    return evaluateBudget(state.spentCents, budgetCents, costUsd)
  }

  function recordSpend(costUsd: number, usageType: string, metadata?: Record<string, unknown>) {
    if (costUsd <= 0) return
    state.spentCents += Math.round(costUsd * 100)
    void meterVendorSpend({
      vendorName: "batchdata",
      usageType: `isa_${usageType}`,
      cost: costUsd,
      brokerageId: ctx.brokerageId,
      systemSource: "ai_agent_tool",
      metadata: { userId: ctx.userId ?? null, agentId: ctx.agentId ?? null, persona: ctx.persona, ...metadata },
    }).catch(() => null)
  }

  function markSeen(family: ToolFamily, args: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) {
    state.seenCriteria.add(`${family}:${criteriaKey(args)}`)
  }

  function pageRefusal(family: ToolFamily, args: CriteriaArgs): ToolRefusal | null {
    return evaluatePageOrder(state.seenCriteria, family, args)
  }

  async function writeContactColumn(update: Record<string, unknown>, flow: string) {
    if (!ctx.contactId) return
    const svc = createServiceClient()
    await sentinelWrite(svc, svc.from("contacts").update(update).eq("id", ctx.contactId), {
      table: "contacts",
      flow,
      brokerageId: ctx.brokerageId,
      reason: "a BatchData ISA tool call already verified this live; a lost stamp only costs the NEXT gate check one extra live re-verification, never a compliance miss",
    })
  }

  const registry: Record<string, unknown> = {}

  // ── lookup_property (seller only — it IS their own home) ────────────────────────
  if (isToolAllowedForPersona(ctx.persona, "lookup_property")) {
    registry.lookup_property = tool({
      description: "Look up a single property's full BatchData record by address — tax assessor, valuation, building characteristics. Use to answer a lead's question about their own (or a property they're asking about) home.",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const r = await callBatchDataMcp("lookup_property", args)
        if (!r.ok) return { success: false, error: r.error ?? "BatchData lookup_property failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "lookup_property")
        return { success: true, data: r.data }
      },
    })
  }

  // ── search_properties_preview / count (investor, relocation) ────────────────────
  if (isToolAllowedForPersona(ctx.persona, "search_properties_preview")) {
    registry.search_properties_preview = tool({
      description: "Free/no-charge sample of properties matching the given address/city/state/zip. ALWAYS call this (or search_properties_count) before search_properties_page for the same criteria.",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const r = await callBatchDataMcp("search_properties_preview", args)
        if (!r.ok) return { success: false, error: r.error ?? "BatchData search_properties_preview failed" }
        markSeen("search_properties", args)
        // Preview is documented as the no-charge sample (lib/external/batchdata-mcp.ts's
        // own investorBuyboxPreview doc comment) — no spend to record.
        return { success: true, data: mapRows(ctx.persona, extractRows(r.data)) }
      },
    })
  }

  if (isToolAllowedForPersona(ctx.persona, "search_properties_count")) {
    registry.search_properties_count = tool({
      description: "Billed count of properties matching the given address/city/state/zip (no rows returned) — use to size a search before paying for a full page. ALWAYS call this (or search_properties_preview) before search_properties_page for the same criteria.",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const cost = MCP_TOOL_CALL_COST_USD / 5 // a count returns no rows — priced as a fraction of a full page pull, derived from the SAME estimate rather than a second invented number
        const refusal = budgetRefusal(cost)
        if (refusal) return refusal
        const r = await callBatchDataMcp<Record<string, unknown>>("search_properties_count", args)
        if (!r.ok) return { success: false, error: r.error ?? "BatchData search_properties_count failed" }
        markSeen("search_properties", args)
        recordSpend(cost, "search_properties_count")
        const count = typeof r.data?.count === "number" ? r.data.count : typeof r.data === "number" ? (r.data as number) : null
        return { success: true, count }
      },
    })
  }

  // ── search_properties_page (investor only) ──────────────────────────────────────
  if (isToolAllowedForPersona(ctx.persona, "search_properties_page")) {
    registry.search_properties_page = tool({
      description: "Full (billed) page of properties matching the given address/city/state/zip. REFUSED unless search_properties_preview or search_properties_count already ran for the SAME criteria this conversation.",
      inputSchema: z.object({ ...AddressCriteriaShape, take: z.number().int().min(1).max(50).nullable().describe("Rows to return, max 50"), skip: z.number().int().min(0).nullable().describe("Rows to skip") }),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null; take: number | null; skip: number | null }) => {
        const order = pageRefusal("search_properties", args)
        if (order) return order
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const r = await callBatchDataMcp("search_properties_page", args)
        if (!r.ok) return { success: false, error: r.error ?? "BatchData search_properties_page failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "search_properties_page")
        return { success: true, data: mapRows(ctx.persona, extractRows(r.data)) }
      },
    })
  }

  // ── verify_address (seller only — investor/buyer/renter/relocation never need a
  //    mailing address, and only the owner's own address is being confirmed) ──────
  if (isToolAllowedForPersona(ctx.persona, "verify_address")) {
    registry.verify_address = tool({
      description: "Verify and standardize a mailing address via BatchData's Address API. Use before sending mail or recording a contact's address as confirmed.",
      inputSchema: z.object({ street: z.string(), city: z.string().nullable(), state: z.string().nullable(), zip: z.string().nullable() }),
      execute: async (args: { street: string; city: string | null; state: string | null; zip: string | null }) => {
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const r = await callBatchDataMcp<Record<string, unknown>>("verify_address", args)
        if (!r.ok) return { success: false, error: r.error ?? "BatchData verify_address failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "verify_address")
        const verified = r.data?.verified === true || r.data?.isValid === true
        if (verified) {
          await writeContactColumn(
            { mailing_address_verified: true, mailing_address_verified_at: new Date().toISOString() },
            "batchdata_isa_tool_address_verify",
          )
        }
        return { success: true, verified, standardized: r.data ?? null }
      },
    })
  }

  // ── verify_phone / check_dnc_status / check_tcpa_status (sphere only, AND only when
  //    the caller declares this conversation outbound-eligible — fail closed) ───────
  if (
    isToolAllowedForPersona(ctx.persona, "verify_phone") &&
    (ctx.persona !== "sphere" || ctx.outboundEligible === true)
  ) {
    registry.verify_phone = tool({
      description: "Verify a phone number is reachable and get its line type via BatchData. Use before recording a phone as confirmed, or before an outbound call/SMS is scheduled.",
      inputSchema: z.object(PhoneShape),
      execute: async ({ phone }: { phone: string }) => {
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const ten = toTenDigits(phone)
        if (!ten) return { success: false, error: "phone could not be normalized to 10 digits" }
        const r = await mcpVerifyPhone(ten)
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData verify_phone failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "verify_phone")
        if (r.reachable !== null) {
          await writeContactColumn(
            { phone_verified: r.reachable, phone_verification_date: new Date().toISOString() },
            "batchdata_isa_tool_phone_verify",
          )
        }
        return { success: true, reachable: r.reachable, lineType: r.lineType }
      },
    })

    registry.check_dnc_status = tool({
      description: "Check whether a phone number is on the national/state Do-Not-Call registry. The verdict is ALSO recorded on the contact so the outbound compliance gate can use it — this does not itself send anything or bypass that gate.",
      inputSchema: z.object(PhoneShape),
      execute: async ({ phone }: { phone: string }) => {
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const ten = toTenDigits(phone)
        if (!ten) return { success: false, error: "phone could not be normalized to 10 digits" }
        const r = await checkDncStatus(ten)
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData check_dnc_status failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "check_dnc_status")
        if (r.dnc !== null) {
          // SAME columns lib/communication/tcpa-gate.ts reads (isDncTcpaVerdictFresh) and
          // stamps on its own live re-check — this tool feeds that gate, never bypasses it.
          await writeContactColumn(
            { dnc_status: r.dnc, dnc_verified_at: new Date().toISOString() },
            "batchdata_isa_tool_dnc_verify",
          )
        }
        return { success: true, dnc: r.dnc }
      },
    })

    registry.check_tcpa_status = tool({
      description: "Check whether a phone number is associated with a known TCPA litigator. Returned to you for judgment — the outbound compliance gate re-verifies this live on every actual send, so there is no stored column for this flag to persist to.",
      inputSchema: z.object(PhoneShape),
      execute: async ({ phone }: { phone: string }) => {
        const refusal = budgetRefusal(MCP_TOOL_CALL_COST_USD)
        if (refusal) return refusal
        const ten = toTenDigits(phone)
        if (!ten) return { success: false, error: "phone could not be normalized to 10 digits" }
        const r = await checkTcpaStatus(ten)
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData check_tcpa_status failed" }
        recordSpend(MCP_TOOL_CALL_COST_USD, "check_tcpa_status")
        return { success: true, tcpaLitigator: r.tcpaLitigator }
      },
    })
  }

  // ── comparable_property_preview / count (buyer, seller, investor) ───────────────
  if (isToolAllowedForPersona(ctx.persona, "comparable_property_preview")) {
    registry.comparable_property_preview = tool({
      description: "Free/no-charge sample of comparable properties (comps) for the given address.",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const r = await comparablePropertyPreview(forTypedWrapper(args))
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData comparable_property_preview failed" }
        markSeen("comparable_property", args)
        return { success: true, data: mapRows(ctx.persona, r.rows) }
      },
    })
  }

  if (isToolAllowedForPersona(ctx.persona, "comparable_property_count")) {
  registry.comparable_property_count = tool({
    description: "Billed count of comparable properties for the given address (no rows).",
    inputSchema: z.object(AddressCriteriaShape),
    execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
      const cost = MCP_TOOL_CALL_COST_USD / 5
      const refusal = budgetRefusal(cost)
      if (refusal) return refusal
      const r = await comparablePropertyCount(forTypedWrapper(args))
      if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
      if (!r.ok) return { success: false, error: r.error ?? "BatchData comparable_property_count failed" }
      markSeen("comparable_property", args)
      recordSpend(cost, "comparable_property_count")
      return { success: true, count: r.count }
    },
  })
  }

  // ── investor_buybox_preview / count (investor only) ─────────────────────────────
  if (isToolAllowedForPersona(ctx.persona, "investor_buybox_preview")) {
    registry.investor_buybox_preview = tool({
      description: "Free/no-charge sample of investors whose buy-box matches this subject property.",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const r = await investorBuyboxPreview(forTypedWrapper(args))
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData investor_buybox_preview failed" }
        markSeen("investor_buybox", args)
        return { success: true, data: mapRows(ctx.persona, r.rows) }
      },
    })

    registry.investor_buybox_count = tool({
      description: "Billed count of investor buy-box matches for this subject property (no rows).",
      inputSchema: z.object(AddressCriteriaShape),
      execute: async (args: { address: string; city: string | null; state: string | null; zip: string | null }) => {
        const cost = MCP_TOOL_CALL_COST_USD / 5
        const refusal = budgetRefusal(cost)
        if (refusal) return refusal
        const r = await investorBuyboxCount(forTypedWrapper(args))
        if (r.unconfigured) return { success: false, error: "BatchData MCP not configured" }
        if (!r.ok) return { success: false, error: r.error ?? "BatchData investor_buybox_count failed" }
        markSeen("investor_buybox", args)
        recordSpend(cost, "investor_buybox_count")
        return { success: true, count: r.count }
      },
    })
  }

  // ── PLATFORM COST-TIER CONSTRICTION (lane 73B) ──────────────────────────────────
  // Applied LAST, after the persona allowlist above already narrowed the registry —
  // the tier can only narrow further, never grant a persona a tool its own policy
  // never listed. "full" → no change. "lean" (the documented default) → preview/
  // count/lookup_property/verify_*/check_dnc_status/check_tcpa_status survive, any
  // `_page` pull is cut. "off" → {} (RentCast/internal tools, filtered separately by
  // each mounting surface, are untouched). See persona-tool-policy.ts's header.
  const tier = await resolveEffectiveBatchDataToolTier()
  return filterToolsByTier(registry, tier)
}
