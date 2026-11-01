// lib/voice-admin/intent-interface-live.ts
// ─────────────────────────────────────────────────────────────────────────────
// C17, the LIVE half (wave 148, lane 148D): interpretIntentLive (operability + the ONE expert-prompted
// model assist) and executeIntent (the six domain routes onto EXISTING capabilities, the kernel lane onto
// planVoiceCommand, every legacy surface handed back to its own door). The pure contract — the catalogue,
// the rules, authority, the plan and the prompt — is lib/voice-admin/intent-interface.ts.
//
// RAILS, IN ORDER (Law 4 — AI manager → tool → authority → policy → capability → domain service):
//   · the tenant and the actor come from the caller's SESSION (the door), never a body (CLAUDE.md §4);
//   · authority (checkIntentAuthority) is decided BEFORE anything is read for the request;
//   · a missing required field is ASKED (status needs_info) — never guessed, never defaulted;
//   · a mutating route runs only on a CONFIRMED turn (status needs_confirmation until then);
//   · every consequential execution runs under withActionLedger (Law 5) with a domain.entity.action name;
//   · drafts land in the existing approval queues — the tenant's approver approves publication;
//   · every read reads its { error } and fails closed (CLAUDE.md §3) — "I couldn't read" is never "nothing".
// The model is asked ONLY when the rules heard no route or two routes tie, booked to the session tenant
// (generateObjectRouted feature intent_classification), and its answer is re-checked here.

import "server-only"
import { z } from "zod"
import { createServiceClient } from "@/lib/supabase/service"
import type { AppCapability } from "@/lib/agentic-os/app-capability-registry"
import { APP_CAPABILITY_REGISTRY } from "@/lib/agentic-os/app-capability-registry"
import {
  interpretIntent, intentCatalogue, intentRoute, intentSystemPrompt, actorRole, matchRoutes, checkIntentAuthority,
  recheckModelPick, interestStem, criteriaMentions,
  type InterpretIntentInput, type IntentInterpretation, type IntentActor, type IntentTenant, type ScreenContext,
  type IntentSurface, type ModelIntentPick,
} from "./intent-interface"

type Svc = ReturnType<typeof createServiceClient>

// ─── Live interpretation ─────────────────────────────────────────────────────

const MODEL_PICK = z.object({
  route: z.string().describe("One route key from the catalogue, or \"none\""),
  params: z.array(z.object({ name: z.string(), value: z.string() })).describe("Params the person SAID, copied from their words"),
  confidence: z.enum(["high", "medium", "low"]),
  needs_human: z.boolean().describe("true when the request moves money, writes the books, signs or submits a contract, or changes a deal's legal stage"),
  reason: z.string().describe("One short sentence a human could read"),
})
type ModelPick = z.infer<typeof MODEL_PICK> & ModelIntentPick

// The re-check of every model answer is PURE and lives in the contract module
// (intent-interface.ts recheckModelPick) so the proof can drive it without a model.

export interface LiveInterpretInput extends Omit<InterpretIntentInput, "operable" | "blockReason" | "routeKey" | "extraParams"> {
  /** false → rules only (a proof, a caller that must not spend). */
  allowModelAssist?: boolean
  svc?: Svc
}

/** C17 interpretIntent with operability and the one model assist. Never throws. */
export async function interpretIntentLive(input: LiveInterpretInput): Promise<IntentInterpretation> {
  const now = input.now ?? new Date()
  const base: InterpretIntentInput = { ...input, now }
  let result = interpretIntent(base)

  // ── The model, only on a miss, a tie, or a required detail the rules could not lift from the words
  //    (a name, a note, a document) — booked to the session tenant, and re-checked verbatim below ──
  const ambiguous = result.capability === null || result.confidence !== "high" || result.missing.length > 0
  if (ambiguous && input.allowModelAssist !== false && input.tenant.brokerageId && (input.utterance ?? "").trim().length >= 4) {
    try {
      const svc = input.svc ?? createServiceClient()
      const { data: b, error: bErr } = await svc.from("brokerages").select("name").eq("id", input.tenant.brokerageId).maybeSingle()
      if (bErr) console.error("[intent-interface] brand read refused (prompt continues unbranded):", bErr.message)
      const { generateObjectRouted } = await import("@/lib/ai/models")
      const { object } = await generateObjectRouted({
        feature: "intent_classification",
        brokerageId: input.tenant.brokerageId,
        userId: input.actor.userId,
        system: intentSystemPrompt({ brandName: (b as { name?: string | null } | null)?.name ?? null, role: actorRole(input.actor), screen: result.screen, modality: input.modality }),
        prompt: `Request:\n"""${input.utterance.slice(0, 600)}"""`,
        maxTokens: 300,
        temperature: 0,
        schema: MODEL_PICK,
      })
      const checked = recheckModelPick(object as ModelPick, input.utterance, now)
      // The rules' confident route stands: the model may fill its missing details, never swap it.
      const rulesStand = result.capability !== null && result.confidence === "high"
      if (checked.routeKey && rulesStand && checked.routeKey !== result.capability) {
        result = { ...result, notes: [...result.notes, ...checked.notes] }
      } else if (checked.routeKey) {
        const viaModel = interpretIntent({ ...base, routeKey: checked.routeKey, extraParams: checked.params })
        result = { ...viaModel, via: result.capability === checked.routeKey ? "rules+model" : "model", notes: [...viaModel.notes, ...checked.notes] }
      } else if (checked.notes.length) {
        result = { ...result, notes: [...result.notes, ...checked.notes] }
      }
    } catch (err) {
      result = { ...result, notes: [...result.notes, `The language model was unavailable (${err instanceof Error ? err.message : "error"}) — understood by rules only.`] }
    }
  }

  // ── Operability of the governing capability (said BEFORE anything is promised) ──
  const cap = result.governedBy
  if (cap && result.authority_check.allowed && APP_CAPABILITY_REGISTRY[cap]?.requires) {
    try {
      const { resolveAllAppCapabilities, blockExplanation } = await import("@/lib/agentic-os/resolve-app-capability")
      const all = await resolveAllAppCapabilities({ brokerageId: input.tenant.brokerageId, agentId: input.actor.agentId ?? undefined, agentUserId: input.actor.userId })
      const r = all.find((x) => x.capability === cap)
      if (r && !r.operable) {
        result = interpretIntent({
          ...base, routeKey: result.capability, extraParams: result.params,
          operable: { [cap]: false } as Partial<Record<AppCapability, boolean>>,
          blockReason: { [cap]: blockExplanation(r) ?? undefined } as Partial<Record<AppCapability, string>>,
        })
      }
    } catch (err) {
      // Fail closed: an operability check that cannot run does not read as "operable".
      result = { ...result, notes: [...result.notes, `Could not confirm ${cap.replace(/_/g, " ")} is connected (${err instanceof Error ? err.message : "error"}).`] }
    }
  }
  return result
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface IntentResultItem { title: string; detail: string; href?: string | null }

export interface IntentExecution {
  status: "done" | "needs_confirmation" | "needs_info" | "refused" | "handoff" | "failed"
  /** What the assistant SAYS — true to what happened, not to what was planned. */
  say: string
  results: IntentResultItem[]
  /** A legacy surface owns the executor: the affordance posts the same words to that door. */
  executorDoor: Exclude<IntentSurface, "c17"> | null
  ledger: string | null
  error: string | null
}

export interface ExecuteIntentContext {
  actor: IntentActor
  tenant: IntentTenant
  confirmed: boolean
  context?: ScreenContext
  svc?: Svc
}

const out = (status: IntentExecution["status"], say: string, extra: Partial<IntentExecution> = {}): IntentExecution =>
  ({ status, say, results: [], executorDoor: null, ledger: null, error: null, ...extra })

/** The ledger's refusal / replay answer, in words. */
function replayed(claim: { kind: string; error?: string }): IntentExecution {
  if (claim.kind === "refused") return out("failed", "I couldn't record that action, so I didn't do it.", { error: claim.error ?? "ledger refused" })
  return out("done", "That was already done — I didn't do it twice.", { ledger: claim.kind })
}

type ListingRow = { id: string; address: string | null; city: string | null; agent_id: string | null }

/**
 * Whose rows a read may return, as agents.id values (CLAUDE.md §4: teams see only their own board).
 *   own   → the actor's own agents.id;  team → every agents.id on the actor's team (teams.team_lead_id's
 *   board, via agents.team_id); brokerage / all → null (the tenant predicate alone). A scope that cannot be
 *   resolved FAILS CLOSED with the reason — never widened to the brokerage.
 */
async function scopedAgentIds(svc: Svc, i: IntentInterpretation, ctx: ExecuteIntentContext): Promise<{ ids: string[] | null; error: string | null }> {
  const scope = i.authority_check.dataScope
  if (scope === "brokerage" || scope === "all") return { ids: null, error: null }
  if (!ctx.actor.agentId) return { ids: null, error: "I can't find your agent profile, so I can't tell which records are yours." }
  if (scope !== "team") return { ids: [ctx.actor.agentId], error: null }
  const { data: me, error: meErr } = await svc.from("agents").select("team_id").eq("id", ctx.actor.agentId).eq("brokerage_id", ctx.tenant.brokerageId).maybeSingle()
  if (meErr) return { ids: null, error: `I couldn't read your team (${meErr.message}).` }
  const teamId = (me as { team_id?: string | null } | null)?.team_id ?? null
  if (!teamId) return { ids: [ctx.actor.agentId], error: null }
  const { data: mates, error: mErr } = await svc.from("agents").select("id").eq("team_id", teamId).eq("brokerage_id", ctx.tenant.brokerageId)
  if (mErr) return { ids: null, error: `I couldn't read your team (${mErr.message}).` }
  const ids = ((mates ?? []) as Array<{ id: string }>).map((m) => m.id)
  return { ids: ids.length ? ids : [ctx.actor.agentId], error: null }
}

/** Resolve a listing the person named, INSIDE the tenant (and the actor's own / team book when scoped). */
async function resolveListing(svc: Svc, ref: string | null, i: IntentInterpretation, ctx: ExecuteIntentContext): Promise<{ listing: ListingRow | null; ask: string | null; error: string | null }> {
  if (!ref) return { listing: null, ask: "Which listing? Say the address.", error: null }
  const scope = await scopedAgentIds(svc, i, ctx)
  if (scope.error) return { listing: null, ask: null, error: scope.error }
  const own = scope.ids !== null
  let q = svc.from("listings").select("id, address, city, agent_id").eq("brokerage_id", ctx.tenant.brokerageId).is("deleted_at", null)
  if (scope.ids) q = q.in("agent_id", scope.ids)
  if (ref.startsWith("id:")) q = q.eq("id", ref.slice(3))
  else if (ref.startsWith("address:")) q = q.ilike("address", `%${ref.slice(8).replace(/[%_]/g, "")}%`)
  else if (ref !== "latest") return { listing: null, ask: "Which listing? Say the address.", error: null }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(ref === "latest" ? 1 : 2)
  if (error) return { listing: null, ask: null, error: `I couldn't read your listings (${error.message}).` }
  const rows = (data ?? []) as ListingRow[]
  if (rows.length === 0) return { listing: null, ask: ref === "latest" ? "I don't see a listing of yours yet — which address?" : `I couldn't find ${ref.slice(8)} in ${own ? "your" : "the brokerage's"} listings — which address?`, error: null }
  if (rows.length > 1) return { listing: null, ask: `I found more than one match (${rows.map((r) => r.address).join(" / ")}) — which one?`, error: null }
  return { listing: rows[0], ask: null, error: null }
}

/** Resolve the buyer a search is for, inside the tenant (and the agent's book when 'own'). */
async function resolveBuyer(svc: Svc, ref: string | null, i: IntentInterpretation, ctx: ExecuteIntentContext): Promise<{ contactId: string | null; name: string | null; ask: string | null; error: string | null }> {
  if (!ref) return { contactId: null, name: null, ask: "Which buyer is this search for?", error: null }
  if (i.authority_check.role === "contact") {
    if (!ctx.actor.contactId || ref !== `id:${ctx.actor.contactId}`) return { contactId: null, name: null, ask: null, error: "From your portal I can only search for you." }
    const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
    const access = await requireContactAccess(ctx.actor.contactId)
    if (!access.ok || access.brokerageId !== ctx.tenant.brokerageId) return { contactId: null, name: null, ask: null, error: "I couldn't confirm it's your account." }
    return { contactId: ctx.actor.contactId, name: null, ask: null, error: null }
  }
  const scope = await scopedAgentIds(svc, i, ctx)
  if (scope.error) return { contactId: null, name: null, ask: null, error: scope.error }
  let q = svc.from("contacts").select("id, first_name, last_name").eq("brokerage_id", ctx.tenant.brokerageId)
  if (scope.ids) q = q.in("agent_id", scope.ids)
  if (ref.startsWith("id:")) q = q.eq("id", ref.slice(3))
  else if (ref.startsWith("name:")) {
    const n = ref.slice(5).replace(/[%_,()]/g, "").trim().split(/\s+/)
    q = n.length > 1 ? q.ilike("first_name", `${n[0]}%`).ilike("last_name", `${n[n.length - 1]}%`) : q.or(`first_name.ilike.${n[0]}%,last_name.ilike.${n[0]}%`)
  } else return { contactId: null, name: null, ask: "Which buyer is this search for?", error: null }
  const { data, error } = await q.limit(2)
  if (error) return { contactId: null, name: null, ask: null, error: `I couldn't read your contacts (${error.message}).` }
  const rows = (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>
  if (rows.length === 0) return { contactId: null, name: null, ask: "I couldn't find that buyer in your contacts — who is it for?", error: null }
  if (rows.length > 1) return { contactId: null, name: null, ask: `I found more than one (${rows.map((r) => `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim()).join(" / ")}) — which buyer?`, error: null }
  return { contactId: rows[0].id, name: `${rows[0].first_name ?? ""} ${rows[0].last_name ?? ""}`.trim() || null, ask: null, error: null }
}


/**
 * C17 execute(plan). Never throws. Refuses whatever the interpretation did not clear; asks for what is
 * missing; waits for a yes on anything that changes something; hands a legacy surface's intent to its door.
 */
export async function executeIntent(i: IntentInterpretation, ctx: ExecuteIntentContext): Promise<IntentExecution> {
  try {
    if (!i.capability) return out("refused", i.plan.summary)
    if (!i.authority_check.allowed) return out("refused", i.authority_check.reasons[0] ?? "I can't do that from here.")
    if (i.missing.length > 0) return out("needs_info", i.missing[0].ask, { results: i.missing.map((m) => ({ title: m.param.replace(/_/g, " "), detail: m.ask })) })
    const route = intentRoute(i.capability)
    if (!route) return out("refused", "I didn't catch something I can act on.")
    if (!route.executors.c17) {
      const door = (Object.keys(route.executors).find((k) => k !== "c17") ?? null) as IntentExecution["executorDoor"]
      return out("handoff", `${i.plan.managerSpoken.replace(/^your /, "Your ")} takes this one through its own command door.`, { executorDoor: door })
    }
    if (route.mutates && !ctx.confirmed) return out("needs_confirmation", i.plan.summary, { results: i.plan.steps.map((s, n) => ({ title: `Step ${n + 1}`, detail: s })) })

    const svc = ctx.svc ?? createServiceClient()
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const ledgerActor = { type: "user" as const, userId: ctx.actor.userId, agentId: ctx.actor.agentId }
    const detail = { utterance: i.utterance.slice(0, 300), modality: i.modality, screen: i.screen, params: i.params, via: i.via }

    switch (route.key) {
      // ── 1. "Create an ad for my new listing" ──────────────────────────────
      case "listing_ad_draft": {
        const found = await resolveListing(svc, i.params.listing, i, ctx)
        if (found.error) return out("failed", found.error, { error: found.error })
        if (!found.listing) return out("needs_info", found.ask ?? "Which listing?")
        const { mayUseFeature } = await import("@/lib/billing/billing-access")
        const access = await mayUseFeature(ctx.actor.userId, "ad_creator", { brokerageId: ctx.tenant.brokerageId, client: svc as never })
        if (!access.allowed) return out("refused", access.reason || "Your plan doesn't include the ad creator yet.")
        const listing = found.listing
        const kind = (i.params.kind === "just_sold" || i.params.kind === "price_reduction" ? i.params.kind : "just_listed") as "just_listed" | "just_sold" | "price_reduction"
        return withActionLedger<IntentExecution>(
          {
            brokerageId: ctx.tenant.brokerageId, action: "marketing.listing_ad.draft", actor: ledgerActor,
            subject: { type: "listing", id: listing.id }, reasonCode: "HUMAN_REQUESTED",
            reasonDetail: `asked by ${i.modality}: ${i.utterance}`.slice(0, 300),
            idempotencyKey: `marketing.listing_ad.draft:${listing.id}:${kind}`, riskClass: route.risk,
            systemSource: "intent_interface", detail: { ...detail, brief: { outcome: i.params.outcome, audience: i.params.audience, platform: i.params.platform } },
          },
          async () => {
            const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
            const r = await produceListingAdCampaign(ctx.tenant.brokerageId, listing.id, kind, svc)
            if (!r.produced && !r.campaignId) return out("failed", `I couldn't draft the ad (${r.reason ?? "unknown"}).`, { error: r.reason ?? "not produced" })
            return out("done", r.produced
              ? `The ${kind.replace(/_/g, " ")} ad for ${listing.address ?? "the listing"} is drafted from the listing's facts and waiting in the ad approval queue — nothing runs until it's approved.`
              : `There's already a ${kind.replace(/_/g, " ")} ad draft for ${listing.address ?? "that listing"} — it's in the approval queue.`,
              { results: [{ title: listing.address ?? "Listing ad", detail: "Draft creative — awaiting approval", href: "/dashboard/campaigns/ads" }] })
          },
          { settle: (r) => r.status === "done" ? { status: "executed", outcome: "ad_draft_ready" } : { status: "failed", outcome: "ad_draft_failed", error: r.error }, replay: replayed },
          { client: svc },
        )
      }

      // ── 2. "Find buyers interested in acreage" ────────────────────────────
      case "buyer_interest_search": {
        const stem = interestStem(i.params.interest ?? "")
        if (!stem) return out("needs_info", route.params[0].ask)
        const scope = await scopedAgentIds(svc, i, ctx)
        if (scope.error) return out("failed", scope.error, { error: scope.error })
        const own = scope.ids !== null
        // The criteria rows are read under the tenant; WHOSE buyers come back is decided on contacts.agent_id
        // (agents.id — the one column whose identity class is certain) in the second read below.
        const { data: prefs, error: prefErr } = await svc.from("property_preferences")
          .select("contact_id, inferred_must_have_features, inferred_property_types, inferred_cities, inferred_deal_breakers, lifestyle_preferences")
          .eq("brokerage_id", ctx.tenant.brokerageId).limit(1000)
        if (prefErr) return out("failed", `I couldn't read buyer criteria (${prefErr.message}).`, { error: prefErr.message })
        const hits = new Map<string, string>()
        for (const p of (prefs ?? []) as Array<Record<string, unknown>>) {
          const said = criteriaMentions({ features: p.inferred_must_have_features, types: p.inferred_property_types, cities: p.inferred_cities, dealBreakers: p.inferred_deal_breakers, lifestyle: p.lifestyle_preferences }, stem)
          if (said && typeof p.contact_id === "string") hits.set(p.contact_id, said)
        }
        if (hits.size === 0) return out("done", `None of ${own ? "your" : "the brokerage's"} buyers has said they want ${i.params.interest}. I'll keep listening for it.`)
        let cq = svc.from("contacts").select("id, first_name, last_name, contact_type").eq("brokerage_id", ctx.tenant.brokerageId).in("id", [...hits.keys()].slice(0, 200))
        if (scope.ids) cq = cq.in("agent_id", scope.ids)
        const { data: people, error: pplErr } = await cq
        if (pplErr) return out("failed", `I couldn't read those contacts (${pplErr.message}).`, { error: pplErr.message })
        const { isBuyerSideContactType } = await import("@/lib/contact-types")
        const buyers = ((people ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; contact_type: string | null }>)
          .filter((c) => isBuyerSideContactType(c.contact_type))
        if (buyers.length === 0) return out("done", `No buyer contacts you can see have said they want ${i.params.interest}.`)
        return out("done", `${buyers.length} buyer${buyers.length === 1 ? " has" : "s have"} asked for ${i.params.interest}: ${buyers.slice(0, 3).map((b) => (b.first_name ?? "").trim() || "a buyer").join(", ")}${buyers.length > 3 ? ", and more" : ""}.`, {
          results: buyers.slice(0, 25).map((b) => ({ title: `${b.first_name ?? ""} ${b.last_name ?? ""}`.trim() || "Buyer", detail: `said: "${hits.get(b.id)}"`, href: `/crm/contacts/${b.id}` })),
        })
      }

      // ── 3. "Write a blog on this month's market" ──────────────────────────
      case "market_blog_draft": {
        const research = await import("@/lib/market-reports/research")
        const contract = await import("@/lib/market-reports/contract")
        const area = (i.params.area ?? "").trim()
        let hint: { zip?: string | null; city?: string | null; state?: string | null; label?: string | null } | null = null
        if (/^\d{5}$/.test(area)) hint = { zip: area, label: null }
        else if (area) {
          const { data: b, error: bErr } = await svc.from("brokerages").select("state").eq("id", ctx.tenant.brokerageId).maybeSingle()
          if (bErr) return out("failed", `I couldn't read your brokerage's state (${bErr.message}).`, { error: bErr.message })
          hint = { city: area, state: (b as { state?: string | null } | null)?.state ?? null, label: null }
        }
        const resolved = await research.resolveReportTerritory(svc, { brokerageId: ctx.tenant.brokerageId, agentId: ctx.actor.agentId, hint })
        if (resolved.error) return out("failed", `I couldn't work out your market area (${resolved.error}).`, { error: resolved.error })
        if (!resolved.hint) return out("needs_info", "Which area should the market blog cover — a city or ZIP?")
        const chosen = research.chooseTerritoryGrain(resolved.hint)
        if (!chosen.territory) return out("needs_info", `Which area should it cover? (${chosen.reason})`)
        const territory = chosen.territory
        const facts = await research.researchMarket(svc, { brokerageId: ctx.tenant.brokerageId, agentUserId: ctx.actor.userId, territory })
        if (facts.errors.length) return out("failed", `I couldn't read the market data for ${territory.label}, so I didn't write numbers I can't source.`, { error: facts.errors.join("; ") })
        if (facts.data.length === 0) {
          return out("needs_info", `I have no verified market data for ${territory.label} right now, and I won't write market numbers I can't source. Want a buyer- or seller-education post instead, or a different area?`)
        }
        const factLines = facts.data.map((d) => `- ${d.label}: ${contract.formatDatumValue(d)} — ${contract.sourceLine(d)}${d.caveat ? ` (${d.caveat})` : ""}`)
        const sourceContent = [
          `BRIEF: ${i.params.topic ?? "this month's market"} for ${territory.label}${i.params.period ? `, ${i.params.period}` : ""}${i.params.audience ? `, written for ${i.params.audience}` : ""}.`,
          "VERIFIED FACTS (the ONLY numbers the article may state; cite the as-of date; say plainly what is not known):",
          ...factLines,
          ...(facts.unavailable.length ? ["NOT AVAILABLE (say so honestly, never estimate):", ...facts.unavailable.map((u) => `- ${u.text}`)] : []),
        ].join("\n")
        const keywords = [`${territory.label} real estate market`, i.params.period ? `${territory.label} market ${i.params.period}` : null, i.params.topic].filter((k): k is string => !!k && k.length > 2)
        return withActionLedger<IntentExecution>(
          {
            brokerageId: ctx.tenant.brokerageId, action: "marketing.blog_post.draft", actor: ledgerActor,
            subject: { type: "territory", ref: contract.territoryKey(territory) }, reasonCode: "HUMAN_REQUESTED",
            reasonDetail: `asked by ${i.modality}: ${i.utterance}`.slice(0, 300),
            idempotencyKey: `marketing.blog_post.draft:${ctx.actor.userId}:${contract.territoryKey(territory)}:${(i.params.period ?? i.params.topic ?? "").toLowerCase().slice(0, 40)}`,
            riskClass: route.risk, systemSource: "intent_interface", detail: { ...detail, facts: facts.data.length },
          },
          async () => {
            const { writeBlogPost } = await import("@/lib/kernel/content-creators")
            const r = await writeBlogPost({ ctx: { userId: ctx.actor.userId, brokerageId: ctx.tenant.brokerageId, agentId: ctx.actor.agentId ?? undefined }, client: svc, keywords, sourceContent })
            if (!r.success) return out("failed", `I couldn't write the post: ${r.error}`, { error: r.error })
            const warn = r.complianceWarnings.length ? ` ${r.complianceWarnings.length} compliance note${r.complianceWarnings.length === 1 ? "" : "s"} for the reviewer.` : ""
            return out("done", `"${r.title}" is drafted from ${facts.data.length} verified figures for ${territory.label} and waiting for your approver.${warn}`, {
              results: [{ title: r.title, detail: "Draft — awaiting approval", href: `/dashboard/marketing/blog/${r.postId}` }],
            })
          },
          { settle: (r) => r.status === "done" ? { status: "executed", outcome: "blog_draft_ready" } : { status: "failed", outcome: "blog_draft_failed", error: r.error }, replay: replayed },
          { client: svc },
        )
      }

      // ── 4. "Find homes with a private backyard and a short commute" ───────
      case "property_search": {
        const buyer = await resolveBuyer(svc, i.params.buyer, i, ctx)
        if (buyer.error) return out("failed", buyer.error, { error: buyer.error })
        if (!buyer.contactId) return out("needs_info", buyer.ask ?? "Which buyer is this search for?")
        const { loadBuyerCriteria } = await import("@/lib/buyer-search/buyer-criteria")
        const stored = await loadBuyerCriteria(svc, buyer.contactId, { brokerageId: ctx.tenant.brokerageId })
        const { searchPropertiesCore } = await import("@/lib/buyer-search")
        const r = (await searchPropertiesCore({ contactId: buyer.contactId, naturalLanguageQuery: i.utterance, options: { limit: 8, logSignals: true, criteria: stored } }).catch((e: unknown) => ({ success: false, error: e instanceof Error ? e.message : String(e) }))) as { success: boolean; error?: string; results?: Array<Record<string, unknown>> }
        if (!r.success) return out("failed", `That search didn't run (${r.error ?? "unknown"}).`, { error: r.error ?? "search failed" })
        const homes = (r.results ?? []).slice(0, 8)
        const forWhom = buyer.name ? ` for ${buyer.name}` : ""
        if (homes.length === 0) return out("done", `No homes matched${forWhom} yet — I'll watch for new ones.`)
        return out("done", `${homes.length} home${homes.length === 1 ? "" : "s"}${forWhom}. Each is labelled with where it came from.`, {
          results: homes.map((m) => ({
            title: String(m.address ?? "Home"),
            detail: [m.price ? `$${Number(m.price).toLocaleString("en-US")}` : null, m.bedrooms ? `${m.bedrooms} bd` : null, `source: ${String(m.source ?? "in-house")}`, typeof m.explanation_voice === "string" ? m.explanation_voice : null].filter(Boolean).join(" · "),
          })),
        })
      }

      // ── 5. "Schedule a virtual open house" ────────────────────────────────
      case "open_house_schedule": {
        const found = await resolveListing(svc, i.params.listing, i, ctx)
        if (found.error) return out("failed", found.error, { error: found.error })
        if (!found.listing) return out("needs_info", found.ask ?? "Which listing?")
        const listing = found.listing
        const kind = i.params.kind ?? "open_house"
        return withActionLedger<IntentExecution>(
          {
            brokerageId: ctx.tenant.brokerageId, action: "open_house.event.schedule", actor: ledgerActor,
            subject: { type: "listing", id: listing.id }, reasonCode: "HUMAN_REQUESTED",
            reasonDetail: `asked by ${i.modality}: ${i.utterance}`.slice(0, 300),
            idempotencyKey: `open_house.event.schedule:${listing.id}:${i.params.date}:${i.params.start_time}`, riskClass: route.risk,
            systemSource: "intent_interface", detail,
          },
          async () => {
            const { createOpenHouse } = await import("@/app/actions/open-house")
            const r = (await createOpenHouse({
              listingId: listing.id, date: i.params.date as string, startTime: i.params.start_time as string, endTime: i.params.end_time as string,
              eventType: kind, joinUrl: i.params.join_url ?? undefined, sendInvites: false,
            })) as { success: boolean; error?: string; event?: { id?: string } }
            if (!r.success) return out("failed", `I couldn't schedule it: ${r.error ?? "unknown"}.`, { error: r.error ?? "not scheduled" })
            return out("done", `The ${kind === "virtual_open_house" ? "virtual open house" : kind === "broker_open" ? "broker open" : "open house"} at ${listing.address ?? "the listing"} is on ${i.params.date}, ${i.params.start_time}–${i.params.end_time}. Invitations wait for your approval.`, {
              results: [{ title: listing.address ?? "Open house", detail: `${i.params.date} ${i.params.start_time}–${i.params.end_time}`, href: "/dashboard/open-houses" }],
            })
          },
          { settle: (r) => r.status === "done" ? { status: "executed", outcome: "open_house_scheduled" } : { status: "failed", outcome: "open_house_not_scheduled", error: r.error }, replay: replayed },
          { client: svc },
        )
      }

      // ── 6. "Show me which contacts may need help" ─────────────────────────
      case "contact_care_scan": {
        const scope = await scopedAgentIds(svc, i, ctx)
        if (scope.error) return out("failed", scope.error, { error: scope.error })
        const { getHealthPrioritizedContacts } = await import("@/lib/intelligence/health-prioritizer-runner")
        // The ranking runner scopes by ONE agent; a team is ranked agent by agent (bounded) and merged.
        // WAVE 148 (148Z): the runner THROWS on a refused read (it used to return [] — which this branch spoke as
        // "everyone looks well looked-after"). The refusal is said, never ranked as fine (CLAUDE.md §4).
        let rankedLists: Awaited<ReturnType<typeof getHealthPrioritizedContacts>>[]
        try {
          rankedLists = scope.ids
            ? await Promise.all(scope.ids.slice(0, 15).map((agentId) => getHealthPrioritizedContacts(svc, ctx.tenant.brokerageId, { agentId, limit: 200 })))
            : [await getHealthPrioritizedContacts(svc, ctx.tenant.brokerageId, { limit: 200 })]
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          return out("failed", `I couldn't check who may need help right now (${why}) — I won't guess that everyone is fine.`, { error: why })
        }
        const ranked = rankedLists.flat().sort((a, b) => b.priority - a.priority || a.score - b.score)
        const needing = ranked.filter((r) => r.band === "at_risk" || r.band === "dormant" || r.band === "cooling").slice(0, 8)
        if (needing.length === 0) return out("done", "Everyone looks well looked-after right now. I'll tell you when someone goes quiet.")
        let cq = svc.from("contacts").select("id, first_name, last_name").eq("brokerage_id", ctx.tenant.brokerageId).in("id", needing.map((n) => n.contactId))
        if (scope.ids) cq = cq.in("agent_id", scope.ids)
        const { data: people, error } = await cq
        if (error) return out("failed", `I couldn't read those contacts (${error.message}).`, { error: error.message })
        const byId = new Map(((people ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>).map((p) => [p.id, p]))
        const rows = needing.filter((n) => byId.has(n.contactId))
        return out("done", `${rows.length} ${rows.length === 1 ? "person" : "people"} may need a hand — ${rows.slice(0, 3).map((n) => (byId.get(n.contactId)?.first_name ?? "").trim() || "a contact").join(", ")} first. Nothing has been sent; it's your call how to reach out.`, {
          results: rows.map((n) => {
            const p = byId.get(n.contactId)!
            return { title: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "Contact", detail: `${n.band.replace(/_/g, " ")} — ${n.drivers[0] ?? "no recent two-way contact"}`, href: `/crm/contacts/${n.contactId}` }
          }),
        })
      }

      // ── The kernel lane: a governed manager signal per step (the survivor's dispatcher) ──
      default: {
        if (route.family !== "kernel_signal" || !route.governedBy) return out("refused", "I can't run that from here yet.")
        const { planVoiceCommand, planLines } = await import("./plan-voice-command")
        // C17's authority answer (role → feature, risk ceiling, never-spoken) grants EXACTLY the scopes of the
        // kernel steps it cleared in this sentence (a multi-step sentence keeps every step it may run) — a
        // session carries no agent-token scopes, and planVoiceCommand's own authorization → operability →
        // confirmation gates still run on top of it.
        const scopes = new Set<string>([APP_CAPABILITY_REGISTRY[route.governedBy].scope])
        for (const m of matchRoutes(i.utterance, i.screen)) {
          if (m.route.family !== "kernel_signal" || !m.route.governedBy) continue
          if (checkIntentAuthority(m.route, ctx.actor).allowed) scopes.add(APP_CAPABILITY_REGISTRY[m.route.governedBy].scope)
        }
        const r = await planVoiceCommand({ utterance: i.utterance, brokerageId: ctx.tenant.brokerageId, userId: ctx.actor.userId, agentId: ctx.actor.agentId ?? undefined, scopes: [...scopes], confirmed: ctx.confirmed })
        if (r.error) return out("failed", r.plan.spokenSummary, { error: r.error })
        const lines = planLines(r.plan).map((l) => ({ title: l.step.capability.replace(/_/g, " "), detail: l.text }))
        if (r.plan.awaitingConfirmation > 0 && !ctx.confirmed) return out("needs_confirmation", r.plan.spokenSummary, { results: lines })
        return out(r.failed.length ? "failed" : "done", r.plan.spokenSummary, {
          results: [...lines, ...r.dispatched.map((d) => ({ title: d.capability.replace(/_/g, " "), detail: `handed to ${d.manager}` })), ...r.failed.map((f) => ({ title: f.capability.replace(/_/g, " "), detail: `did not start — ${f.reason}` }))],
          error: r.failed.length ? r.failed.map((f) => f.reason).join("; ") : null,
        })
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return out("failed", "Something went wrong working that out, so I didn't start anything.", { error: msg })
  }
}

// ─── The record: every interpretation lands in voice_commands (the existing command log) ─────────────

/** Record what was heard, what it meant and what happened. Reads its error; never blocks the answer. */
export async function recordIntentCommand(svc: Svc, row: { actor: IntentActor; tenant: IntentTenant; interpretation: IntentInterpretation; execution: IntentExecution | null; source: "web" | "mobile" }): Promise<void> {
  const i = row.interpretation
  const { error } = await svc.from("voice_commands").insert({
    user_id: row.actor.userId,
    brokerage_id: row.tenant.brokerageId,
    raw_transcript: i.utterance.slice(0, 2000),
    parsed_intent: i.capability ?? "none",
    // `catalogue_routes`: how many routes the interpreting catalogue held — a record read later shows which
    // vocabulary understood it (a route added or retired since is visible, never silently re-read).
    entities: { params: i.params, missing: i.missing.map((m) => m.param), modality: i.modality, screen: i.screen, authority: i.authority_check.outcome, via: i.via, notes: i.notes, interface: "c17", catalogue_routes: intentCatalogue().length },
    action_taken: row.execution ? `${i.capability ?? "none"}:${row.execution.status}` : `${i.capability ?? "none"}:interpreted`,
    action_result: { say: row.execution?.say ?? i.plan.summary, results: row.execution?.results.length ?? 0, ledger: row.execution?.ledger ?? null },
    success: row.execution ? row.execution.status === "done" || row.execution.status === "needs_confirmation" || row.execution.status === "needs_info" : i.capability !== null,
    confidence_score: i.confidence === "high" ? 0.9 : i.confidence === "medium" ? 0.6 : 0.3,
    error_message: row.execution?.error ?? null,
    source: row.source,
  })
  if (error) console.error("[intent-interface] voice_commands record refused:", error.message)
}

