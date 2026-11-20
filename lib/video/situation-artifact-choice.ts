/**
 * lib/video/situation-artifact-choice.ts — A VIDEO WHEN THE SITUATION WARRANTS ONE, NOT ONLY ON A BIRTHDAY (wave 155, lane 155G —
 * owner R9: "videos should be setup not just for lifetime/birthday which can send education videos if the situation warrants it.
 * video is an artifact not a channel"; directive 155G G2, the six examples at lines 323–328). PURE: no I/O.
 *
 * MEASURED AT BASE d2d6468c: the only arbitrated video choice was the lifetime touch (lib/sphere/lifetime-touch-arbitration.ts —
 * anniversary: message / avatar greeting / agent task / no action). Every other video was commissioned by a fixed play or a
 * person; nothing decided whether a CLIENT QUESTION, a seller's competing offers, a lead-magnet topic, a change of terms or new
 * market evidence warranted a video at all — or that a plain answer was the better one.
 *
 * THIS IS NOT A NEW ARBITER. It builds the closed menu in the follow-up arbiter's own vocabulary (NextActionCandidate /
 * NextActionGate — video is an ARTIFACT FORMAT, the channel is how it travels) and screens it with THE arbiter's
 * screenNextActionCandidates (lib/ai-isa/followup-arbiter.ts): a gate that cannot be verified refuses (fail closed), an unready
 * artifact is never sent, and "agent task" and "no touch" stay valid answers. The ARTIFACT is chosen here; DELIVERY stays
 * separately governed (channel, consent, approval, budget, recipient status) by the rails that already own it.
 *
 * GROUNDED RULES (no invented threshold):
 *   · a client question is classified by THE question classifier (lib/portal/question-answer-decision.ts classifyPortalQuestion);
 *     a fact about their own deal, a vendor fact or a procedure is answered in words (a video would only delay it); advice
 *     ("should I…", legal, tax) and a request for a person go to the agent — never to a video, never to AI advice;
 *   · a general-education question earns a NEW video only once the question RECURS at the topic pool's own floor
 *     (lib/customer-intelligence/website-question-topics.ts QUESTION_TOPIC_FLOOR) — one asker is served better by a clear
 *     written answer; an APPROVED, finished video on the topic is delivered instead of making a second;
 *   · competing offers → an option-explainer DRAFT for the agent's review only (no offer term is stated, no legal advice);
 *   · changed terms → the portal card in words now (the signed documents govern); a video only if one is approved for the change;
 *   · market evidence → a narrated video only on VERIFIED facts (a source and an as-of date); unverified = no touch;
 *   · a lead-magnet topic → a 30–60 s reel plus the longer evergreen guide (the approved text);
 *   · the anniversary is decided by arbitrateLifetimeTouch (message / video / agent task / no touch) — delegated, not re-decided.
 * Fair housing rides the WRITING prompt of whatever producer runs (CLAUDE.md §5); this choice states no protected-class cue and
 * reads none (eval BIAS-005: two people differing only in such a cue get the same choice — the inputs carry no such field).
 */
import { screenNextActionCandidates, type ArbiterChannel, type ArbiterFormat, type NextActionCandidate, type NextActionGate, type NextActionVerb } from "@/lib/ai-isa/followup-arbiter"
import { QUESTION_TOPIC_FLOOR } from "@/lib/customer-intelligence/website-question-topics"
import type { QuestionClass } from "@/lib/portal/question-answer-decision"

export type ArtifactSituationKind = "client_question" | "competing_offers" | "lead_magnet_topic" | "terms_changed" | "local_market_evidence" | "anniversary"
export type ArtifactChoiceId = "educational_video" | "plain_answer" | "agent_task" | "no_touch"

export interface ArtifactSituation {
  kind: ArtifactSituationKind
  /** client_question: THE classifier's verdict (classifyPortalQuestion). */
  question?: QuestionClass | null
  /** Distinct askers of this theme inside the topic window (readQuestionLoopMetrics.repeatAskersByTheme); null = unknown. */
  distinctAskers?: number | null
  /** An APPROVED, finished video for this topic / change already exists — delivered, never a second one made. */
  approvedVideo?: { table: string; id: string } | null
  /** The facts an artifact may state, each with its source and as-of date (null = not dated → not verified). */
  sourceFacts: ReadonlyArray<{ fact: string; source: string; asOf: string | null }>
  recipient: { type: "contact" | "lead" | "audience"; videoOptOut: boolean; playableVia: ArbiterChannel[]; writtenVia: ArbiterChannel[] }
  /** Who could produce a video: the agent's recorded avatar + voice (null = unread), or a drawn / Remotion treatment. */
  producer: { avatarReady: boolean | null; renderReady: boolean }
  agentAssigned: boolean
}

export interface ArtifactChoice {
  kind: ArtifactSituationKind
  chosen: ArtifactChoiceId | "delegated"
  verb: NextActionVerb
  /** The artifacts the choice produces (a lead magnet = reel + guide). Empty for a task / no touch. */
  artifacts: ArbiterFormat[]
  candidates: NextActionCandidate[]
  gates: NextActionGate[]
  refused: Array<{ id: string; why: string[] }>
  why: string
  /** Always: the channel, consent, approval, budget and recipient status are decided by the delivery rail, not here. */
  delivery: "separately_governed"
}

const PREFERENCE: Readonly<Record<Exclude<ArtifactSituationKind, "anniversary">, readonly ArtifactChoiceId[]>> = Object.freeze({
  client_question: ["educational_video", "plain_answer", "agent_task", "no_touch"],
  competing_offers: ["educational_video", "agent_task", "no_touch"],
  lead_magnet_topic: ["educational_video", "plain_answer", "no_touch"],
  terms_changed: ["educational_video", "plain_answer", "agent_task", "no_touch"],
  local_market_evidence: ["educational_video", "plain_answer", "no_touch"],
})

/** PURE. Which artifact this situation warrants — a video, a plain answer, the agent, or nothing. */
export function chooseSituationArtifact(s: ArtifactSituation): ArtifactChoice {
  if (s.kind === "anniversary") {
    return { kind: s.kind, chosen: "delegated", verb: "no_action", artifacts: [], candidates: [], gates: [], refused: [], delivery: "separately_governed", why: "the anniversary is decided by arbitrateLifetimeTouch (lib/sphere/lifetime-touch-arbitration.ts): a short message, a personal video, an agent task or no touch" }
  }
  const verified = s.sourceFacts.filter((f) => f.source.trim() && f.asOf)
  const readyVideo = !!s.approvedVideo
  const draftOnly = s.kind === "competing_offers" || (s.kind === "terms_changed" && !readyVideo)
  const videoFormat: ArbiterFormat = s.producer.avatarReady === true ? "avatar_video" : "video_reel"
  const candidates: NextActionCandidate[] = [
    { id: "educational_video", verb: readyVideo ? "send" : draftOnly ? "draft" : "create", channels: s.recipient.playableVia,
      artifact: { format: videoFormat, ref: s.approvedVideo ?? null, readiness: readyVideo ? "approved_ready" : "creation_request", playableVia: s.recipient.playableVia, why: readyVideo ? "an approved, finished video on this already exists" : draftOnly ? "a draft for the agent's review — it is not sent until a person approves it" : "the Asset Manager commissions it through the one Director rail; delivered only on its own verified-ready evidence" },
      manager: "asset_manager", supporting: ["campaign_orchestrator"], externalDeliveries: readyVideo ? 1 : 0, why: ["a short video explains this better than words alone"] },
    { id: "plain_answer", verb: "send", channels: s.recipient.writtenVia, artifact: { format: "written_message", ref: null, readiness: "composed_at_send", playableVia: [], why: "a clear written answer, now" }, manager: s.kind === "client_question" ? "ai_isa" : "campaign_orchestrator", supporting: [], externalDeliveries: 1, why: ["the plain answer serves this faster"] },
    { id: "agent_task", verb: "notify_agent", channels: ["human_task"], artifact: null, manager: s.kind === "client_question" || s.kind === "competing_offers" || s.kind === "terms_changed" ? "ai_isa" : "campaign_orchestrator", supporting: [], externalDeliveries: 0, why: ["a person should handle this"] },
    { id: "no_touch", verb: "no_action", channels: [], artifact: null, manager: "campaign_orchestrator", supporting: [], externalDeliveries: 0, why: ["nothing worth sending"] },
  ]
  const g: NextActionGate[] = []
  const video = (gate: NextActionGate["gate"], ok: boolean | null, why: string) => g.push({ gate, candidate: "educational_video", ok, why })
  const plain = (gate: NextActionGate["gate"], ok: boolean | null, why: string) => g.push({ gate, candidate: "plain_answer", ok, why })
  // Common video gates — consent, a channel that can play it, a producer that can make it.
  if (s.recipient.type !== "audience") video("consent", !s.recipient.videoOptOut, s.recipient.videoOptOut ? "they opted out of video" : "no video opt-out on file")
  video("channel_available", s.recipient.playableVia.length > 0, s.recipient.playableVia.length ? `playable on ${s.recipient.playableVia.join(", ")}` : "no channel can play a video to them")
  video("artifact", readyVideo || s.producer.renderReady || s.producer.avatarReady === true ? true : s.producer.avatarReady === null ? null : false, readyVideo ? "an approved video exists" : s.producer.renderReady || s.producer.avatarReady ? "a producer can make it" : "no producer can make it (no recorded avatar, no render treatment)")
  plain("channel_available", s.recipient.writtenVia.length > 0, s.recipient.writtenVia.length ? `writable on ${s.recipient.writtenVia.join(", ")}` : "no lawful written channel")
  g.push({ gate: "conversation_owner", candidate: "agent_task", ok: s.agentAssigned, why: s.agentAssigned ? "an agent owns the relationship" : "no agent is assigned" })

  if (s.kind === "client_question") {
    const q = s.question
    if (!q) { video("identity", null, "the question was not classified"); plain("identity", null, "the question was not classified") }
    else if (q.guard) video("sensitivity", false, `a guarded question (${q.guard}) is answered in words by the guard — never a video`)
    else if (q.kind === "legal_financial_judgment" || q.kind === "human_preference") {
      const why = q.kind === "legal_financial_judgment" ? "they ask what they SHOULD do (legal / financial judgment) — the agent answers; no AI advice" : "they asked for a person"
      video("sensitivity", false, why); plain("sensitivity", false, why)
    } else if (q.kind !== "general_education") video("artifact", false, `a ${q.kind.replace(/_/g, " ")} question is answered in words — a video would only delay the fact they asked for`)
    else if (!readyVideo) {
      const floor = QUESTION_TOPIC_FLOOR.minDistinctAskers
      video("artifact", s.distinctAskers == null ? null : s.distinctAskers >= floor, s.distinctAskers == null ? "how often this is asked is unknown" : s.distinctAskers >= floor ? `asked by ${s.distinctAskers} people in ${QUESTION_TOPIC_FLOOR.windowDays} days (floor ${floor}) — one video serves every asker` : `asked by ${s.distinctAskers} (floor ${floor}) — a clear written answer serves one asker; a video is made once the question recurs`)
    }
  } else if (s.kind === "competing_offers") {
    video("review", s.agentAssigned, s.agentAssigned ? "a draft for the agent's review — no offer term is stated and no legal advice is given; the offers themselves govern" : "no agent to review an option explainer — nothing is drafted")
  } else if (s.kind === "terms_changed") {
    if (!readyVideo) video("review", false, "no approved video for the changed terms — the portal card states the change in words now; the signed documents govern")
    plain("review", true, "the card says the signed documents govern")
  } else if (s.kind === "local_market_evidence") {
    video("identity", verified.length > 0, verified.length ? `${verified.length} verified fact(s) with a source and an as-of date` : "no verified market fact (a source and an as-of date) — nothing is narrated")
    plain("identity", verified.length > 0, verified.length ? "verified facts on record" : "no verified market fact")
  } else if (s.kind === "lead_magnet_topic") {
    video("identity", s.sourceFacts.length > 0, s.sourceFacts.length ? "the approved topic text is the reel's and the guide's source" : "no approved source text — nothing is made")
  }

  const { eligible, refused } = screenNextActionCandidates(candidates, g)
  const order = PREFERENCE[s.kind]
  const pick = order.map((id) => eligible.find((c) => c.id === id)).find(Boolean) ?? candidates.find((c) => c.id === "no_touch")!
  const id = pick.id as ArtifactChoiceId
  const artifacts: ArbiterFormat[] = id === "educational_video" ? (s.kind === "lead_magnet_topic" ? [videoFormat, "written_message"] : [videoFormat]) : id === "plain_answer" ? ["written_message"] : []
  const lead = refused.find((r) => r.id === "educational_video")
  const why = id === "educational_video" ? `${s.kind.replace(/_/g, " ")}: ${pick.artifact?.why ?? "a video"}${s.kind === "lead_magnet_topic" ? " — a 30–60 second reel plus the longer evergreen guide" : ""}` : `${s.kind.replace(/_/g, " ")}: ${id.replace(/_/g, " ")}${lead ? ` — no video: ${lead.why.join("; ")}` : ""}`
  return { kind: s.kind, chosen: id, verb: pick.verb, artifacts, candidates, gates: g, refused, why, delivery: "separately_governed" }
}
