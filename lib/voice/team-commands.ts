// lib/voice/team-commands.ts
//
// SHARED TEAM-COMMAND DISPATCHER — the one place the AI-team coordination commands are mapped to
// their kernel backends, so BOTH voice front-ends call the SAME logic instead of drifting:
//   • the ElevenLabs Conv AI spoken admin  (app/api/agent-assistant/tool-call/route.ts)
//   • the internal voice-command route      (app/api/internal/voice-command/route.ts)
//
// These commands let an agent talk to the whole AI team — "Hey team, what do you know about the
// Hendersons?" / "anything happening near 44 Birch?" / "what should I do today?". Each one fans the
// question across the manager bench (AI ISA, Shopping Agent, Deal Coordinator, Asset Manager, Ads
// Manager, …) and returns ONE manager-attributed spoken answer. Read-only — no compliance gates
// beyond authority; the registry (lib/voice/tool-registry.ts) marks them gates:[].

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface TeamCommandCtx {
  brokerageId: string
  agentUserId: string
  firstName?: string | null
}

export interface TeamCommandResult {
  ok: boolean
  /** The single spoken answer the voice admin reads back. */
  spoken: string
  data?: Record<string, unknown>
}

// Command-name catalog + isTeamCommand live in a PURE module so client/test code can import them
// without this server-only file; re-exported here so existing importers of team-commands keep working.
export {
  TEAM_QUERY_COMMANDS, TEAM_ACTION_COMMANDS, BUYER_COMMANDS, TEAM_COMMANDS, isTeamCommand,
} from "./team-command-names"

/** Speak a price the way a person would say it ("$1.2 million" / "$450 thousand"). */
function formatSpokenPrice(price: number | null | undefined): string {
  if (!price) return "an unlisted price"
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1)} million`
  return `$${Math.round(price / 1000)} thousand`
}

/** Resolve a contactId from a structured contact_id param, else from a spoken person name via the
 *  team-query resolver (so both front-ends work — ElevenLabs passes ids, the spoken route passes names). */
async function resolveContactId(params: Record<string, unknown>, brokerageId: string, svc: Svc): Promise<{ contactId: string | null; spoken?: string }> {
  const explicit = params.contact_id ? String(params.contact_id) : null
  if (explicit) return { contactId: explicit }
  const personQuery = String(params.person_query ?? params.query ?? "").trim()
  if (!personQuery) return { contactId: null, spoken: "Who is that for? Give me the name and I'll take it from there." }
  const { runTeamQuery } = await import("@/lib/kernel/team-query")
  const tq = await runTeamQuery(brokerageId, personQuery, {}, svc)
  return tq.found && tq.contactId ? { contactId: tq.contactId } : { contactId: null, spoken: tq.spoken }
}

/**
 * Route a team-coordination command to its kernel backend. Read-only commands compose a spoken
 * answer; ACTING commands delegate to backends that enforce their own compliance gate (the
 * proposal→approval gate re-checks consent — nothing here sends autonomously). Throws on an
 * unknown name (callers gate on isTeamCommand).
 */
export async function dispatchTeamCommand(
  name: string,
  params: Record<string, unknown>,
  ctx: TeamCommandCtx,
  client?: Svc,
): Promise<TeamCommandResult> {
  const svc = client ?? createServiceClient()

  switch (name) {
    case "team_query": {
      const { runTeamQuery } = await import("@/lib/kernel/team-query")
      const r = await runTeamQuery(ctx.brokerageId, String(params.person_query ?? params.query ?? ""), {}, svc)
      return { ok: true, spoken: r.spoken, data: { contactId: r.contactId, contactName: r.contactName, contributions: r.contributions } }
    }
    case "area_query": {
      const { runAreaQuery } = await import("@/lib/kernel/area-query")
      const r = await runAreaQuery(ctx.brokerageId, String(params.area_query ?? params.query ?? ""), svc)
      return { ok: true, spoken: r.spoken, data: { area: r.area, contributions: r.contributions } }
    }
    case "morning_standup": {
      const { runMorningStandup } = await import("@/lib/kernel/morning-standup")
      const r = await runMorningStandup(ctx.brokerageId, ctx.agentUserId, { firstName: ctx.firstName ?? null }, svc)
      return { ok: true, spoken: r.spoken, data: { items: r.items } }
    }
    case "quarterly_review": {
      // THE QBR SPOKEN TWIN — the same loader the Command Center card uses
      // (keep-one), principal-gated exactly like the dashboard action.
      const { data: me } = await svc.from("users").select("role").eq("id", ctx.agentUserId).maybeSingle()
      const { isTenancyPrincipal } = await import("@/lib/kernel/tenancy-principal")
      const principal = await isTenancyPrincipal(svc, {
        userId: ctx.agentUserId, brokerageId: ctx.brokerageId, role: String((me as any)?.role ?? ""),
      })
      if (!principal) {
        return { ok: false, spoken: "The quarterly review is for the account principal — ask your broker or team lead to pull it up." }
      }
      const { loadQuarterlyReview } = await import("@/lib/intelligence/quarterly-review-loader")
      const { review, pulse } = await loadQuarterlyReview(svc, ctx.brokerageId)
      const spoken = [
        `${review.headline}.`,
        review.outcomes[0] ?? null,
        review.trust[0] ?? null,
        review.gaps[0] ? `One thing sitting unused: ${review.gaps[0]}` : null,
        review.nextMoves[0] ? `Next move: ${review.nextMoves[0]}` : null,
        pulse[0] ? `And ${pulse[0].name} could use a hand — ${pulse[0].reasons[0]}.` : null,
      ].filter(Boolean).join(" ")
      return { ok: true, spoken, data: { review, pulse } }
    }
    case "ask_guidance": {
      // "Hey team, how do I set up my voice twin?" — the on-demand educator:
      // answered NOW from the published curriculum (grounded, never invented
      // steps), and the question feeds the gap miner so a missing lesson gets
      // authored — someone is always there helping, and the library learns.
      const question = String(params.question ?? params.query ?? "").trim()
      if (question.length < 5) return { ok: false, spoken: "What would you like a hand with? Ask me how anything here works." }
      const { answerAgentQuestion } = await import("@/lib/education/agent-guide")
      const r = await answerAgentQuestion(svc, { brokerageId: ctx.brokerageId, userId: ctx.agentUserId, question })
      return {
        ok: true,
        spoken: r.spoken,
        data: { matches: r.matches.map((m) => ({ moduleId: m.moduleId, title: m.title, href: `/academy/module/${m.moduleId}` })), gapLogged: r.gapLogged },
      }
    }

    // ── Acting verbs — the team DOES what you say (each backend enforces its own gate) ──
    case "standup_action": {
      // "Knock out number two" — re-derive the stand-up live and act on item N through its rail
      // (approval → the gate as the agent; reengage → follow-up; fire → never auto-resolved).
      const ordinal = Number(params.ordinal ?? 0)
      if (!ordinal) return { ok: false, spoken: "Which one — number one, two, or three? Say the rank and I'll knock it out." }
      const { runStandupAction } = await import("@/lib/kernel/standup-action")
      const r = await runStandupAction({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, ordinal, firstName: ctx.firstName ?? null }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { ordinal, actedKind: r.actedKind ?? null, entityId: r.entityId ?? null } }
    }
    case "voice_followup": {
      // "Send the Hendersons a follow-up" — propose→approve AS the agent through the SAME gate
      // (consent re-checked). Nothing sends until approved; dictation is carried verbatim.
      const resolved = await resolveContactId(params, ctx.brokerageId, svc)
      if (!resolved.contactId) return { ok: false, spoken: resolved.spoken ?? "Who is that for?" }
      const dictation = params.dictation ? String(params.dictation) : null
      const { voiceFollowUp } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceFollowUp({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, contactId: resolved.contactId, dictation }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { contactId: resolved.contactId, messageId: r.messageId ?? null } }
    }
    case "start_marketing": {
      // "Start marketing for them" — enroll in the best active sequence; each step clears its gate.
      const resolved = await resolveContactId(params, ctx.brokerageId, svc)
      if (!resolved.contactId) return { ok: false, spoken: resolved.spoken ?? "Who is that for?" }
      const { voiceStartMarketing } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceStartMarketing({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, contactId: resolved.contactId }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { contactId: resolved.contactId, enrollmentId: r.enrollmentId ?? null } }
    }
    case "cut_promo": {
      // "Cut a promo reel for 44 Birch" — manual trigger on the canonical Remotion + D-ID rail
      // (Fair Housing pre-flight, cooldown debounce, social drafts still human-approved).
      const addressQuery = String(params.address_query ?? params.query ?? "").trim()
      if (!addressQuery) return { ok: false, spoken: "Which listing? Give me the street number and name and I'll cut the reel." }
      const { voiceCutPromo } = await import("@/lib/kernel/voice-delegation")
      const r = await voiceCutPromo({ brokerageId: ctx.brokerageId, agentUserId: ctx.agentUserId, addressQuery }, svc)
      return { ok: r.ok, spoken: r.spoken, data: { addressQuery } }
    }

    case "kernel_proposals": {
      // "Hey team, any proposals waiting on me?" — the document kernel's open
      // amber proposals, numbered so the agent can resolve by rank.
      const { listOpenKernelProposals } = await import("@/lib/documents/kernel-review-core")
      const proposals = await listOpenKernelProposals(svc, ctx.brokerageId, 5)
      if (proposals.length === 0) {
        return { ok: true, spoken: "Nothing's waiting on you — the deal files are clean.", data: { count: 0 } }
      }
      const lines = proposals.map((p, i) => {
        const where = p.address ? ` on ${p.address}` : ""
        if (p.signalType === "deadline_conflict_finding") {
          const t = String(p.payload.deadline_type ?? "deadline").replace(/_/g, " ")
          return p.payload.current_date
            ? `Number ${i + 1}: the paperwork${where} says the ${t} is ${p.payload.proposed_date}, but ${p.payload.current_date} is tracked.`
            : `Number ${i + 1}: the paperwork${where} supports a ${t} of ${p.payload.proposed_date} — say approve to track it.`
        }
        if (p.signalType === "stage_advance_candidate") {
          return `Number ${i + 1}: the deal${where} looks ready to move to ${String(p.payload.to_stage ?? "").replace(/_/g, " ")}.`
        }
        return `Number ${i + 1}: an earned-autonomy grant on ${String(p.payload.deadline_type ?? "a deadline").replace(/_/g, " ")} dates — that one's for the broker on the dashboard.`
      })
      return {
        ok: true,
        spoken: `${proposals.length} ${proposals.length === 1 ? "proposal is" : "proposals are"} waiting. ${lines.join(" ")} Say "approve number one" or "decline number two".`,
        data: { count: proposals.length, proposals: proposals.map((p) => ({ signalId: p.signalId, type: p.signalType })) },
      }
    }
    case "kernel_resolve": {
      // "Approve number two" — re-list LIVE (never a stale rank) and resolve
      // through the SAME cores the feed buttons use. Ratchet grants refuse by
      // voice — standing autonomy is broker policy, decided on the dashboard.
      const ordinal = Number(params.ordinal ?? 0)
      const decision = String(params.decision ?? "").toLowerCase()
      if (!ordinal || (decision !== "approve" && decision !== "decline")) {
        return { ok: false, spoken: "Which one, and which way? Say something like: approve number one." }
      }
      const { listOpenKernelProposals, resolveDeadlineConflictCore, approveStageAdvanceCore, dismissStageCandidateCore } =
        await import("@/lib/documents/kernel-review-core")
      const proposals = await listOpenKernelProposals(svc, ctx.brokerageId, 5)
      const target = proposals[ordinal - 1]
      if (!target) return { ok: false, spoken: proposals.length === 0 ? "Nothing's waiting on you right now." : `There ${proposals.length === 1 ? "is only one proposal" : `are only ${proposals.length}`} open — say the rank again.` }
      const actor = { userId: ctx.agentUserId, brokerageId: ctx.brokerageId }
      if (target.signalType === "deadline_conflict_finding") {
        const r = await resolveDeadlineConflictCore(svc, actor, { signalId: target.signalId, adopt: decision === "approve" })
        return { ok: r.ok, spoken: r.ok ? `Done. ${r.message}` : r.error ?? "That one wouldn't resolve.", data: { signalId: target.signalId } }
      }
      if (target.signalType === "stage_advance_candidate") {
        const r = decision === "approve"
          ? await approveStageAdvanceCore(svc, actor, { signalId: target.signalId })
          : await dismissStageCandidateCore(svc, actor, { signalId: target.signalId })
        const blocked = !r.ok && "blockers" in r && Array.isArray((r as any).blockers) && (r as any).blockers.length > 0
        return {
          ok: r.ok,
          spoken: r.ok ? `Done. ${r.message}` : blocked ? `The engine blocked it: ${(r as any).blockers.join("; ")}. It stays open until that's fixed.` : (r.error ?? "That one wouldn't resolve."),
          data: { signalId: target.signalId },
        }
      }
      return { ok: false, spoken: "That one's an earned-autonomy grant — the broker decides those on the Command Center, not by voice." }
    }

    case "find_properties": {
      // "Find the Hendersons a 3-bed under 500k in Austin" — resolve the buyer, run the natural-language
      // match (our inventory + RentCast/IDX, Fair-Housing-sanitized in the explanation layer), read back
      // the top matches. Read-only — no outbound, no listing data persisted for external results.
      const resolved = await resolveContactId(params, ctx.brokerageId, svc)
      if (!resolved.contactId) return { ok: false, spoken: resolved.spoken ?? "Who's the search for? Give me the buyer's name." }
      const query = String(params.query ?? params.search ?? params.criteria ?? params.naturalLanguageQuery ?? "").trim()
      if (query.length < 5) return { ok: false, spoken: "What are they looking for? Tell me beds, baths, price range, and the area." }
      const { searchPropertiesCore } = await import("@/lib/buyer-search")
      const r: any = await searchPropertiesCore({ contactId: resolved.contactId, naturalLanguageQuery: query, options: { limit: 5, logSignals: true } })
      if (!r.success) return { ok: false, spoken: "I couldn't run that search — try rephrasing the criteria." }
      const results: any[] = r.results ?? []
      if (results.length === 0) return { ok: true, spoken: "Nothing matches those criteria in our inventory or the market right now. Want to widen the search?", data: { count: 0 } }
      const top = results[0]
      const spoken = `I found ${results.length} ${results.length === 1 ? "match" : "matches"}. The top one is a ${top.bedrooms}-bed, ${top.bathrooms}-bath in ${top.city} at ${formatSpokenPrice(top.price)}.${top.headline ? ` ${top.headline}` : ""} Want the rest?`
      return { ok: true, spoken, data: { count: results.length, contactId: resolved.contactId, top: { listing_id: top.listing_id ?? null, city: top.city, price: top.price, source: top.source ?? "platform" } } }
    }

    default:
      throw new Error(`Unknown team command: ${name}`)
  }
}
