// lib/lead-magnets/ai-draft.ts
//
// AI CREATES THE ACTUAL DRAFT — wave 141, lane 141E (owner: "AI builds the ACTUAL draft (concept →
// copy / questions / design / assets / config) → human preview / edit / approve → publish").
//
// SURVIVORS EVALUATED, REUSED — nothing here is a second creative engine:
//   · the record ............ lib/kernel/lead-magnets.ts createLeadMagnet (the ONE writer of
//                             lead_capture_forms) with publishState "draft" — a real row, inactive,
//                             unreachable publicly, refusing submissions until a human publishes it;
//   · the copy baseline ..... lib/marketing/lead-magnet-copy.ts landingPageCopy (deterministic,
//                             Fair-Housing-safe) — what the AI's answer is merged ONTO, so a refused
//                             or degraded model call still yields a complete, honest draft;
//   · the questions ......... lib/kernel/lead-magnets.ts defaultFieldsForType — the AI may ADD a few
//                             qualifying questions, never remove the canonical identity fields;
//   · the model lane ........ lib/ai/models.ts generateTextRouted, feature LEAD_MAGNET_DRAFT_FEATURE
//                             (routing table → cheapest adequate model; books ai_tool_usage under the
//                             tenant — cost accounting is the routed lane's, not re-done here);
//   · the entitlement ....... lib/billing/billing-access.ts mayUseAndAfford("ai.generate") — asked
//                             BEFORE any model call; a refusal writes NOTHING (fail closed);
//   · fair housing .......... the writing prompt carries the directive (CLAUDE.md §5) AND the draft
//                             is scanned post hoc by lib/compliance-rules/fair-housing-patterns.ts —
//                             a HIGH-severity hit refuses the AI copy and falls back to the baseline,
//                             with the finding recorded on the draft for the reviewer;
//   · evidence .............. withActionLedger marketing.lead_magnet.ai_draft (who asked, which
//                             model lane, what landed, whether the AI copy or the fallback was used).
// The human step is the EXISTING publish command (publishLeadMagnet — approval authority = the session
// user). Pure halves (classifyConceptMagnetType, composeMagnetDraft, draftFairHousingVerdict) are
// proven directly by scripts/lead-magnet-creation-guard.ts; the composer takes seams for the model,
// the entitlement gate and the client.

import { landingPageCopy, type MagnetType, type LandingContent } from "@/lib/marketing/lead-magnet-copy"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { createLeadMagnet, defaultFieldsForType, type LeadMagnetField, type CreateLeadMagnetInput } from "@/lib/kernel/lead-magnets"
// Wave 142 (lane 142E): the FAIR-HOUSING REWRITE LOOP for public copy — a flagged draft is REWRITTEN by the
// model with the specific findings (phrase → compliant fix), rechecked, capped at PUBLIC_COPY_MAX_REWRITES,
// then ESCALATED to the human reviewer (the draft lands on the safe baseline with the trail kept on it).
import { rewritePublicCopyUntilCompliant, renderFindingsForRewrite, type CopyFinding } from "@/lib/kernel/marketing/public-copy-rewrite"

/** The AI_TASK_ROUTING key (lib/ai/models.ts) — scripts/ai-routing-coverage-guard.ts requires the literal at the call site.
 *  @proofSeam the proof asserts the routing row + the recorded authoring feature against it. */
export const LEAD_MAGNET_DRAFT_FEATURE = "lead_magnet_draft"
/** The budget ask handed to mayUseAndAfford before the call (prompt + a ~700-token answer). */
const LEAD_MAGNET_DRAFT_EST_TOKENS = 1600
/** The AI may add at most this many qualifying questions on top of the canonical fields. */
const MAX_EXTRA_QUESTIONS = 4

const MAGNET_TYPES: readonly MagnetType[] = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"]
const FIELD_TYPES = new Set(["text", "email", "tel", "number", "textarea", "select", "checkbox"])

interface MagnetDraftSpec {
  name: string
  description: string
  headline: string
  subhead: string
  cta: string
  bullets: string[]
  thankYou: string
  /** Canonical fields for the type + the AI's extra qualifying questions (validated). */
  fields: LeadMagnetField[]
  faq: Array<{ question: string; answer: string }>
}

/** What the model lane returns — every key optional; the composer validates and fills. */
type MagnetDraftGenerated = Partial<Omit<MagnetDraftSpec, "fields">> & {
  questions?: Array<{ label?: string; type?: string; required?: boolean; options?: string[] }>
}

interface DraftGeneratorRequest {
  brokerageId: string
  userId: string | null
  magnetType: MagnetType
  concept: string
  area: string | null
  brand: string | null
  audience: string | null
  /** Wave 142: non-empty on a REWRITE — the fair-housing findings the previous draft failed on. */
  violations?: CopyFinding[]
  /** 0 for the first draft, 1..n for rewrites. */
  attempt?: number
}

/** Injectable model seam (tests pass a stub; production = routedDraftGenerator). */
type DraftGenerator = (req: DraftGeneratorRequest) => Promise<MagnetDraftGenerated | null>

interface EntitlementAsk { brokerageId: string; estTokens: number; actor?: { platformRole?: string | null; userType?: string | null } | null }
type EntitlementGate = (ask: EntitlementAsk) => Promise<{ allowed: boolean; reason: string; message?: string }>

// ── PURE: concept → magnet type ────────────────────────────────────────────────────────────────

/** Deterministic keyword routing of a free-text concept onto the seven canonical magnet types. @proofSeam asserted directly. */
export function classifyConceptMagnetType(concept: string): MagnetType {
  const c = (concept ?? "").toLowerCase()
  if (!c.trim()) return "generic_form"
  if (/\b(open house|open-house|rsvp|showing event)\b/.test(c)) return "open_house"
  if (/\b(home value|home-value|what.{0,12}worth|valuation|equity|appraisal|cma|zestimate)\b/.test(c)) return "home_valuation"
  if (/\b(new listings?|listing alerts?|alerts?|be first|just listed|coming soon|inventory)\b/.test(c)) return "listing_alert"
  if (/\b(market (report|update|snapshot|trends?)|prices? trend|days on market|monthly report)\b/.test(c)) return "market_report"
  if (/\b(buyers?|first[- ]time|pre-?approval|house hunt|home.?buying|purchas)/.test(c)) return "buyer_guide"
  if (/\b(sellers?|selling|list(ing)? (my|your) home|downsiz|relocat|move-?up|sell)\b/.test(c)) return "seller_guide"
  return "generic_form"
}

// ── PURE: merge the AI answer onto the deterministic baseline ──────────────────────────────────

function cleanLine(v: unknown, max = 200): string | null {
  if (typeof v !== "string") return null
  const s = v.replace(/\s+/g, " ").trim().slice(0, max)
  return s.length > 0 ? s : null
}

/** A field name from a label — stable, unique against the canonical names. */
function fieldNameFromLabel(label: string, taken: Set<string>): string {
  let base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "question"
  if (/^\d/.test(base)) base = `q_${base}`
  let name = base, i = 2
  while (taken.has(name)) name = `${base}_${i++}`
  return name
}

/** Validate the AI's extra questions onto the canonical field list (never removes a canonical field). */
export function mergeExtraQuestions(base: LeadMagnetField[], questions: MagnetDraftGenerated["questions"]): LeadMagnetField[] {
  const out = base.map((f) => ({ ...f }))
  const taken = new Set(out.map((f) => f.name))
  for (const q of (questions ?? []).slice(0, MAX_EXTRA_QUESTIONS)) {
    const label = cleanLine(q?.label, 80)
    if (!label) continue
    const type = FIELD_TYPES.has(String(q?.type)) ? String(q!.type) : "text"
    const options = type === "select" && Array.isArray(q?.options) ? q!.options!.map((o) => cleanLine(o, 60)).filter((o): o is string => !!o).slice(0, 8) : undefined
    if (type === "select" && (!options || options.length < 2)) continue
    const name = fieldNameFromLabel(label, taken)
    taken.add(name)
    out.push({ name, label, type, required: q?.required === true, ...(options ? { options } : {}) })
  }
  return out
}

interface ComposedDraft {
  spec: MagnetDraftSpec
  /** true when the headline / subhead / bullets came from the model (not the deterministic baseline). */
  fromAi: boolean
}

/**
 * The complete draft: the model's answer validated and merged ONTO the deterministic, Fair-Housing-safe
 * baseline, so a null / partial / refused answer still yields a full draft. Pure. @proofSeam asserted directly.
 */
export function composeMagnetDraft(
  magnetType: MagnetType,
  concept: string,
  ctx: { area?: string | null; brand?: string | null },
  generated: MagnetDraftGenerated | null,
): ComposedDraft {
  const base = landingPageCopy(magnetType, { area: ctx.area ?? null, brand: ctx.brand ?? null })
  const g = generated ?? {}
  // The human's concept names the asset when the model offered no name/headline (never a blank draft title).
  const conceptLine = cleanLine(concept, 60)
  const headline = cleanLine(g.headline, 90)
  const subhead = cleanLine(g.subhead, 220)
  const bullets = Array.isArray(g.bullets) ? g.bullets.map((b) => cleanLine(b, 90)).filter((b): b is string => !!b).slice(0, 4) : []
  const fromAi = !!(headline || subhead || bullets.length > 0)
  const faq = Array.isArray(g.faq)
    ? g.faq.map((f) => ({ question: cleanLine(f?.question, 140), answer: cleanLine(f?.answer, 400) }))
        .filter((f): f is { question: string; answer: string } => !!f.question && !!f.answer).slice(0, 5)
    : []
  const spec: MagnetDraftSpec = {
    name: cleanLine(g.name, 60) ?? headline ?? conceptLine ?? base.headline,
    description: cleanLine(g.description, 300) ?? subhead ?? (conceptLine ? `${conceptLine} — ${base.subhead}` : base.subhead),
    headline: headline ?? base.headline,
    subhead: subhead ?? base.subhead,
    cta: cleanLine(g.cta, 40) ?? base.cta,
    bullets: bullets.length > 0 ? bullets : base.bullets,
    thankYou: cleanLine(g.thankYou, 160) ?? "Thank you! We'll be in touch shortly.",
    fields: mergeExtraQuestions(defaultFieldsForType(magnetType), g.questions),
    faq,
  }
  return { spec, fromAi }
}

/** Everything a visitor would READ on the page — the text the fair-housing scan and the rewrite loop see. */
function draftPublicText(spec: MagnetDraftSpec): string {
  return [spec.name, spec.description, spec.headline, spec.subhead, spec.cta, ...spec.bullets, spec.thankYou,
    ...spec.fields.map((f) => f.label), ...spec.faq.flatMap((f) => [f.question, f.answer])].join("\n")
}

/** Post-hoc Fair-Housing scan of everything a visitor would read. A HIGH-severity hit refuses the copy. @proofSeam asserted directly. */
export function draftFairHousingVerdict(spec: MagnetDraftSpec): { ok: boolean; flagged: string[]; high: string[] } {
  const hits = detectFairHousingViolations(draftPublicText(spec))
  const flagged = hits.map((h) => h.phrase)
  const high = hits.filter((h) => h.severity === "high").map((h) => h.phrase)
  return { ok: high.length === 0, flagged, high }
}

/** The persisted landing_content for a composed draft (the same shape /lm/[slug] renders). */
function landingContentFromDraft(spec: MagnetDraftSpec, fromAi: boolean, generatedAt: string): LandingContent {
  return {
    headline: spec.headline, subhead: spec.subhead, cta: spec.cta, bullets: spec.bullets,
    topics: [], faq: spec.faq, faqJsonLd: null, fromTopics: fromAi, generatedAt,
  }
}

// ── The production model lane (routed, feature-keyed, tenant-booked) ──────────────────────────

const routedDraftGenerator: DraftGenerator = async (req) => {
  try {
    const { generateTextRouted } = await import("@/lib/ai/models")
    const { withScriptStandards } = await import("@/lib/ai/script-standards")
    const system = withScriptStandards(
      `You draft a real-estate LEAD MAGNET (a landing page that offers something useful in exchange for contact details)${req.brand ? ` for ${req.brand}` : ""}. ` +
      "FAIR HOUSING, non-negotiable: never reference or imply race, religion, national origin, family status, disability, sex, or use steering language ('safe neighborhood', 'perfect for families', 'great for retirees', 'exclusive community'). " +
      "Use ONLY the facts in the concept — invent no prices, dates, statistics, names or guarantees. Write like a sharp human, never like a template.",
    )
    // THE REWRITE (wave 142): the findings reach the writer as the comments it must resolve — the exact
    // phrase and its compliant fix — never only as a post-hoc refusal (CLAUDE.md §5).
    const violationBlock = req.violations?.length
      ? `\n\nYour previous draft failed the fair-housing review with these findings:\n${renderFindingsForRewrite(req.violations)}\nRewrite the WHOLE draft so EVERY finding is resolved — describe the home, the process and the service, never who should want it. Same concept, same structure.`
      : ""
    const prompt =
      `Magnet type: ${req.magnetType.replace(/_/g, " ")}.\n` +
      `Concept (from the agent): ${req.concept}\n` +
      (req.area ? `Area served: ${req.area}\n` : "") +
      (req.audience ? `Audience: ${req.audience}\n` : "") +
      `Return ONLY a JSON object: {"name": "page title ≤60 chars", "description": "2 sentences of intro copy", "headline": "hero headline ≤12 words", "subhead": "one supporting sentence", "cta": "button label ≤5 words", "bullets": ["three benefit bullets"], "thankYou": "one warm sentence shown after submit", "questions": [{"label": "an extra qualifying question (max ${MAX_EXTRA_QUESTIONS})", "type": "text|select|number|textarea", "required": false, "options": ["only for select"]}], "faq": [{"question": "a real question this audience asks", "answer": "a concise, honest answer"}]}` +
      violationBlock
    const { text } = await generateTextRouted({
      feature: "lead_magnet_draft",
      brokerageId: req.brokerageId,
      userId: req.userId,
      system,
      prompt,
      temperature: 0.7,
      maxTokens: 900,
    })
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return null
    return JSON.parse(m[0]) as MagnetDraftGenerated
  } catch {
    return null // honest absence — the composer falls back to the deterministic baseline
  }
}

/** The production entitlement gate — the ONE unified access + budget rule (lib/billing/billing-access.ts). */
const billingEntitlementGate: EntitlementGate = async (ask) => {
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const d = await mayUseAndAfford({ brokerageId: ask.brokerageId, capability: "ai.generate", estTokens: ask.estTokens, actor: ask.actor ?? null })
  return { allowed: d.allowed, reason: d.reason, message: d.message }
}

// ── The command ────────────────────────────────────────────────────────────────────────────────

interface DraftLeadMagnetInput {
  /** The VERIFIED tenant (session) — never a request body. */
  brokerageId: string
  /** agents.id of the owner (lead_capture_forms.agent_id). */
  agentId: string
  /** users.id of the requester — the ledger's actor and the audit row's actor_user_id. */
  createdBy: string
  concept: string
  magnetType?: MagnetType | null
  area?: string | null
  brand?: string | null
  audience?: string | null
  /** For the entitlement gate's staff bypass (access half only; never the budget half). */
  actor?: { platformRole?: string | null; userType?: string | null } | null
}

interface DraftLeadMagnetDeps {
  generator?: DraftGenerator
  entitlement?: EntitlementGate
  client?: NonNullable<Parameters<typeof createLeadMagnet>[1]>["client"]
  now?: Date
}

interface DraftLeadMagnetOutput {
  success: boolean
  magnetId?: string
  slug?: string
  magnetType?: MagnetType
  draft?: MagnetDraftSpec
  /** true when the model's copy was used; false when the deterministic baseline stood in (and why). */
  fromAi?: boolean
  fallbackReason?: string | null
  /** Wave 142: the rewrite loop's outcome — how many rewrites ran and whether a human now owns the copy. */
  fairHousing?: { flagged: string[]; high: string[]; rewrites: number; escalated: boolean }
  error?: string
}

/**
 * Concept → a REAL draft lead-magnet record. Entitlement first (nothing written on a refusal), then the
 * routed model lane (or the injected seam), the Fair-Housing scan, the deterministic merge, and the
 * kernel's create command in DRAFT state. The requester previews / edits / approves it on the Lead
 * Magnets page; publishLeadMagnet is the approval. Never throws.
 */
export async function draftLeadMagnetFromConcept(input: DraftLeadMagnetInput, deps: DraftLeadMagnetDeps = {}): Promise<DraftLeadMagnetOutput> {
  const concept = (input.concept ?? "").trim()
  if (!input.brokerageId || !input.agentId || !input.createdBy) return { success: false, error: "Missing required fields: brokerageId, agentId, createdBy" }
  if (concept.length < 8) return { success: false, error: "Describe the lead magnet in a sentence or two first." }

  const gate = deps.entitlement ?? billingEntitlementGate
  const verdict: { allowed: boolean; reason: string; message?: string } = await gate({ brokerageId: input.brokerageId, estTokens: LEAD_MAGNET_DRAFT_EST_TOKENS, actor: input.actor ?? null })
    .catch((e) => ({ allowed: false, reason: `entitlement_threw: ${(e as Error)?.message ?? String(e)}` }))
  if (!verdict.allowed) return { success: false, error: verdict.message ?? `AI drafting is not available right now (${verdict.reason}).` }

  const magnetType: MagnetType = input.magnetType && MAGNET_TYPES.includes(input.magnetType) ? input.magnetType : classifyConceptMagnetType(concept)
  const generator = deps.generator ?? routedDraftGenerator
  const generated = await generator({ brokerageId: input.brokerageId, userId: input.createdBy, magnetType, concept, area: input.area ?? null, brand: input.brand ?? null, audience: input.audience ?? null }).catch(() => null)

  let composed = composeMagnetDraft(magnetType, concept, { area: input.area, brand: input.brand }, generated)
  let fallbackReason: string | null = generated ? null : "model lane unavailable — deterministic baseline used"
  // THE REWRITE LOOP (wave 142, lane 142E; owner: "any fair housing flags on copy ai should rewrite with
  // those comments in mind"). What the MODEL wrote is scanned (the ONE pattern list + the public gate's
  // blockers); a flagged draft goes BACK to the model with the findings as comments, is rechecked, at most
  // PUBLIC_COPY_MAX_REWRITES times. Still flagged → the baseline (Fair-Housing-safe by construction) stands
  // in and the draft is ESCALATED to the human reviewer with the whole trail — a hard flag never ships
  // unreviewed (CLAUDE.md §5). The verdict recorded is the one on the model's LAST attempt, kept even after
  // the fallback replaces the copy (re-scanning the baseline would erase the finding).
  let latest = composed
  const ctx = { area: input.area, brand: input.brand }
  const loop = generated
    ? await rewritePublicCopyUntilCompliant({
        text: draftPublicText(composed.spec),
        surface: "lead_magnet",
        brokerageName: input.brand ?? null,
        rewrite: async (_text, findings, attempt) => {
          const regenerated = await generator({ brokerageId: input.brokerageId, userId: input.createdBy, magnetType, concept, area: input.area ?? null, brand: input.brand ?? null, audience: input.audience ?? null, violations: findings, attempt }).catch(() => null)
          if (!regenerated) return null
          latest = composeMagnetDraft(magnetType, concept, ctx, regenerated)
          return draftPublicText(latest.spec)
        },
      })
    : { ok: true, text: "", rewrites: 0, findings: [] as CopyFinding[], warnings: [] as string[], escalated: false, trail: [] as Array<{ attempt: number; findings: string[] }> }
  composed = latest
  const fh = { ok: loop.ok, flagged: [...new Set(loop.trail.flatMap((t) => t.findings))], high: loop.findings.map((f) => f.phrase) }
  if (!loop.ok) {
    fallbackReason = `AI copy refused by the fair-housing scan after ${loop.rewrites} rewrite${loop.rewrites === 1 ? "" : "s"} (${fh.high.join(", ")}) — deterministic baseline used; escalated to the reviewer`
    composed = composeMagnetDraft(magnetType, concept, ctx, null)
  }
  const now = (deps.now ?? new Date()).toISOString()
  const spec = composed.spec
  const createInput: CreateLeadMagnetInput = {
    title: spec.name,
    description: spec.description,
    magnetType,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    createdBy: input.createdBy,
    fields: spec.fields,
    thankYouMessage: spec.thankYou,
    publishState: "draft",
    landingContent: landingContentFromDraft(spec, composed.fromAi, now),
    settings: {
      authoring: {
        by: "ai",
        feature: LEAD_MAGNET_DRAFT_FEATURE,
        concept,
        from_ai_copy: composed.fromAi,
        fallback_reason: fallbackReason,
        fair_housing_flags: fh.flagged,
        // Wave 142: the rewrite loop's evidence — attempts, the trail, and whether a HUMAN now owns it.
        fair_housing: { ok: loop.ok, rewrites: loop.rewrites, escalated: loop.escalated, findings: loop.findings.map((f) => ({ phrase: f.phrase, fix: f.fix, reference: f.reference })), warnings: loop.warnings, trail: loop.trail },
        generated_at: now,
        requested_by: input.createdBy,
      },
    },
  }

  let result: Awaited<ReturnType<typeof createLeadMagnet>>
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    result = await withActionLedger<Awaited<ReturnType<typeof createLeadMagnet>>>(
      {
        brokerageId: input.brokerageId,
        action: "marketing.lead_magnet.ai_draft",
        actor: { type: "user", userId: input.createdBy },
        subject: { type: "lead_capture_form", ref: concept.slice(0, 120) },
        reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `AI draft of a ${magnetType} lead magnet from the agent's concept`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "lead_magnets",
        detail: { magnetType, feature: LEAD_MAGNET_DRAFT_FEATURE, from_ai_copy: composed.fromAi, fallback_reason: fallbackReason, fair_housing_flags: fh.flagged, fair_housing_rewrites: loop.rewrites, fair_housing_escalated: loop.escalated, questions: spec.fields.length },
      },
      () => createLeadMagnet(createInput, { client: deps.client }),
      {
        settle: (r) => r.success ? { status: "executed", outcome: "draft_created", providerRef: r.magnetId ?? null } : { status: "failed", outcome: "create_refused", error: r.error ?? null },
        replay: (claim) => ({ success: false, error: claim.kind === "replay" ? "already drafted" : `ledger refused the draft: ${claim.kind}` }),
      },
      { client: deps.client as any },
    )
  } catch (e) {
    return { success: false, error: (e as Error)?.message ?? String(e) }
  }
  if (!result.success || !result.magnetId) return { success: false, error: result.error ?? "The draft was not created." }

  // ESCALATION TO A HUMAN (wave 142): the cap was reached with findings still present — the requester is told
  // in-app that this draft needs their rewrite before it can publish (publishLeadMagnet re-scans the public copy
  // and refuses a hard flag). Best-effort: a lost bell never undoes the draft that already landed.
  if (loop.escalated) {
    try {
      const client = (deps.client ?? (await import("@/lib/supabase/service")).createServiceClient()) as { from: (t: string) => any }
      const { error: bellErr } = await client.from("notifications").insert({
        user_id: input.createdBy,
        brokerage_id: input.brokerageId,
        type: "lead_magnet_fair_housing_review",
        title: "AI draft needs your fair-housing review",
        body: `The AI rewrote "${spec.name}" ${loop.rewrites} time${loop.rewrites === 1 ? "" : "s"} and the copy still mentioned ${fh.high.join(", ")}. The safe baseline is on the draft — edit it before publishing.`,
        entity_type: "lead_capture_form",
        entity_id: result.magnetId,
        is_read: false,
        priority: "high",
        channel: "in_app",
        created_at: now,
      })
      if (bellErr) console.warn("[lead-magnets] fair-housing escalation bell not recorded:", bellErr.message)
    } catch (e) {
      console.warn("[lead-magnets] fair-housing escalation bell threw:", (e as Error)?.message ?? String(e))
    }
  }
  return { success: true, magnetId: result.magnetId, slug: result.slug, magnetType, draft: spec, fromAi: composed.fromAi, fallbackReason, fairHousing: { flagged: fh.flagged, high: fh.high, rewrites: loop.rewrites, escalated: loop.escalated } }
}
