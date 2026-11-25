// lib/calculators/artifact.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CALCULATOR ARTIFACT FAMILY (wave 156, lane 156H). A calculator is an ARTIFACT a tenant publishes (owner: "the
// calculators would be a great lead magnet or added asset to the website"), owned by the existing Asset Manager (the
// artifact) and Campaign Orchestrator (its distribution and follow-on), with Finance / Compliance owning the inputs (no
// invented rate — lib/calculators/rate-sources.ts — and the disclaimers — lib/calculators/engine.ts). No new manager.
//
// AUDITED FIRST — EVERY HOP IS A SURVIVOR (LAW 1 / LAW 2):
//   the record        lead_capture_forms (the ONE writer: lib/kernel/lead-magnets.ts createLeadMagnet), magnet_type
//                     "calculator", the artifact's configuration on settings.calculator. No new table, no second catalog.
//   the page          app/lm/[slug]/page.tsx — served inside the tenant website by app/site/[slug]/lm/[formSlug] (tenant
//                     proven in the predicate) and on a connected custom domain. The same route is the QR destination, so
//                     web, mobile width and QR scan render ONE component over ONE engine.
//   publication + QR  publishLeadMagnet (fair-housing scan of the public copy, C5 approver, ledgered) → the ONE QR minter
//                     lib/marketing/tracked-qr.ts mintTrackedQr through generateQRCode (label lead_magnet:<id>).
//   events            trackMagnetEvent → lifecycle_events (lead_magnet_<event>), the tenant taken from the FORM row, never
//                     the caller; the QR scan arm already writes qr_scan_events. Chain: qr_scan → calculator_open →
//                     calculation_completed → calculator_opt_in → form_submit (captureFormSubmission's own event).
//   consent + capture captureFormSubmission — the ONE capture path (C15 consent component, contact match/create under the
//                     tenant, assignment to the magnet's agent). Called EXACTLY ONCE per opt-in; a view or a computation
//                     never reaches it.
//   follow-on         publishManagerSignal "lead_magnet_handoff" (feed_only, the existing catalogued handoff) carrying the
//                     next LEGITIMATE step (explain the estimate / offer the calculator again / an agent task only on an
//                     explicit request to talk) — the addressed manager and the human on the Command Center feed decide.
//   evidence          withActionLedger "marketing.calculator.opt_in" (LAW 5).
//   internal net      lib/brokerage/get-default-commission-structure.ts — the brokerage's agreed commission, for an
//                     authorized seat resolved from the SESSION only; a public estimate refuses it (engine rule 4).
//
// Not server-only: the proof (scripts/wave156-h-calculators-guard.ts) drives every function here on the in-memory client
// with counted seams. Providers, the kernel and the ledger are lazy imports at their call.

import { CALCULATOR_KINDS, CALCULATOR_SPECS, runCalculator, type CalculatorKind, type CalculatorOutcome, type AgreedCommission } from "./engine"
import { CALCULATOR_JURISDICTIONS } from "./rate-sources"
import type { LeadMagnetAttribution } from "@/lib/lead-magnets/attribution"

type Db = { from: (table: string) => any }

// ── configuration (settings.calculator) ──────────────────────────────────────
export interface CalculatorArtifactConfig {
  version: 1
  kind: CalculatorKind
  /** "US-FL" etc. selects the cited statutes; null → the visitor enters every figure. */
  jurisdiction: string | null
  /** Optional input keys the author hides (never a required one). */
  hiddenFields: string[]
  brand: { displayName: string | null; primaryColor: string | null; logoUrl: string | null; tagline: string | null }
  explainer: { videoUrl: string | null; guideUrl: string | null }
  cta: { label: string; mode: "save_results" | "talk_to_agent" }
  /** Where it is published is decided by the EXISTING publish door, not a flag here: publishing makes the landing page live inside
   *  the tenant website (app/site/[slug]/lm/[formSlug]); the storefront's lead-magnet block (app/site/[slug]/page.tsx) lists
   *  active magnets; `qr` adds the tracked code. Portal / funnel placement is NOT built (lane report: NOT DONE). */
  qr: boolean
}

const HEX = /^#[0-9a-fA-F]{6}$/
const httpsOrNull = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/\S+$/.test(u.trim()) ? u.trim() : null)
const text = (u: unknown, max: number): string | null => (typeof u === "string" && u.trim() ? u.trim().slice(0, max) : null)

/** PURE. A raw authoring payload → a valid configuration, or the reasons it is not one. Never guesses a kind or a jurisdiction. */
export function normalizeCalculatorArtifactConfig(raw: unknown): { ok: true; config: CalculatorArtifactConfig } | { ok: false; errors: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>
  const errors: string[] = []
  const kind = String(r.kind ?? "")
  if (!(CALCULATOR_KINDS as readonly string[]).includes(kind)) errors.push(`choose a calculator (one of: ${CALCULATOR_KINDS.join(", ")})`)
  const jRaw = r.jurisdiction == null || r.jurisdiction === "" ? null : String(r.jurisdiction).trim().toUpperCase()
  if (jRaw !== null && !(CALCULATOR_JURISDICTIONS as readonly string[]).includes(jRaw)) errors.push(`"${jRaw}" has no verified source yet — choose one of ${CALCULATOR_JURISDICTIONS.join(", ")} or none (visitors then enter every figure)`)
  const spec = (CALCULATOR_KINDS as readonly string[]).includes(kind) ? CALCULATOR_SPECS[kind as CalculatorKind] : null
  const hidden = Array.isArray(r.hiddenFields) ? r.hiddenFields.map(String) : []
  for (const h of hidden) {
    const f = spec?.fields.find((x) => x.key === h)
    if (spec && !f) errors.push(`unknown field "${h}"`)
    else if (f && f.required !== false) errors.push(`"${f.label}" is required for this calculator and cannot be hidden`)
  }
  const color = r.brand?.primaryColor == null || r.brand.primaryColor === "" ? null : String(r.brand.primaryColor)
  if (color !== null && !HEX.test(color)) errors.push("brand colour must be a #RRGGBB hex value")
  if (r.brand?.logoUrl && !httpsOrNull(r.brand.logoUrl)) errors.push("logo must be an https URL")
  if (r.explainer?.videoUrl && !httpsOrNull(r.explainer.videoUrl)) errors.push("explanatory video must be an https URL")
  if (r.explainer?.guideUrl && !httpsOrNull(r.explainer.guideUrl)) errors.push("guide link must be an https URL")
  const mode = r.cta?.mode === "talk_to_agent" ? "talk_to_agent" : "save_results"
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    config: {
      version: 1, kind: kind as CalculatorKind, jurisdiction: jRaw, hiddenFields: hidden,
      brand: { displayName: text(r.brand?.displayName, 80), primaryColor: color, logoUrl: httpsOrNull(r.brand?.logoUrl), tagline: text(r.brand?.tagline, 140) },
      explainer: { videoUrl: httpsOrNull(r.explainer?.videoUrl), guideUrl: httpsOrNull(r.explainer?.guideUrl) },
      cta: { label: text(r.cta?.label, 60) ?? (mode === "talk_to_agent" ? "Talk with an agent about these numbers" : "Save my results"), mode },
      qr: r.qr === true,
    },
  }
}

/** PURE. The calculator configuration a form carries, or null (not a calculator / an unreadable one). */
export function calculatorArtifactOf(settings: unknown): CalculatorArtifactConfig | null {
  const c = (settings && typeof settings === "object" ? (settings as Record<string, unknown>).calculator : null)
  if (!c) return null
  const n = normalizeCalculatorArtifactConfig(c)
  return n.ok ? n.config : null
}

// ── events (one spelling — the suffixes trackMagnetEvent writes as lead_magnet_<event>) ─────────────────────────────
export const CALCULATOR_EVENTS = ["calculator_open", "calculation_completed", "calculator_opt_in"] as const
export type CalculatorEvent = (typeof CALCULATOR_EVENTS)[number]

// ── follow-on (PURE): the next LEGITIMATE step, never a premature pitch ───────────────────────────────────────────────
export type FollowOnStep = "explain_estimate" | "offer_calculator_again" | "agent_task"
export interface FollowOnPlan { toManager: "listing_concierge" | "shopping_agent" | "sphere_of_influence" | null; nextStep: FollowOnStep; why: string }

/** PURE. Who picks up an opt-in and what they do first. A saved result earns an explanation of the estimate; only an explicit
 *  request to talk earns an agent task (CLAUDE.md §5 — a lead reaches an agent once it shows positive intent). */
export function planCalculatorFollowOn(kind: CalculatorKind, intent: "save_results" | "talk_to_agent"): FollowOnPlan {
  const side = CALCULATOR_SPECS[kind].side
  const toManager = side === "seller" ? "listing_concierge" : side === "buyer" || side === "investor" || side === "relocation" ? "shopping_agent" : side === "owner" ? "sphere_of_influence" : null
  if (intent === "talk_to_agent") return { toManager, nextStep: "agent_task", why: "the person asked to talk with an agent about their numbers" }
  if (kind === "seller_net_sheet" || kind === "equity_proceeds") return { toManager, nextStep: "explain_estimate", why: "a seller who asked for a net estimate gets the estimate explained line by line (what each deduction is and what moves it), not a listing pitch" }
  return { toManager, nextStep: "explain_estimate", why: "the person saved an estimate: explain its assumptions and offer to refine them; no sales pitch until they ask" }
}

// ── seams ─────────────────────────────────────────────────────────────────────
type TrackFn = (input: { magnetId: string; brokerageId?: string; eventType: string; metadata?: Record<string, unknown>; contactId?: string; ipAddress?: string; userAgent?: string }, opts?: { client?: any }) => Promise<{ success: boolean; eventId?: string; error?: string }>
type CaptureFn = (input: Record<string, unknown> & { formId: string; brokerageId: string; submissionData: Record<string, unknown> }, opts?: { client?: any }) => Promise<{ success: boolean; contactId?: string; submissionId?: string; error?: string }>
type SignalFn = (input: Record<string, unknown> & { brokerageId: string; fromManager: string; toManager: string; signalType: string; message: string }, client?: any) => Promise<{ ok: boolean; signalId?: string; reason?: string }>
type CreateFn = (input: any, opts?: { client?: any }) => Promise<{ success: boolean; magnetId?: string; slug?: string; error?: string; lifecycleState?: string }>
type LedgerFn = <T>(ctx: any, run: () => Promise<T>, hooks: any, opts?: any) => Promise<T>

export interface CalculatorDeps {
  client: Db
  /** @proofSeam lib/kernel/lead-magnets.ts trackMagnetEvent (production default). */
  trackMagnetEvent?: TrackFn
  /** @proofSeam lib/kernel/lead-magnets.ts captureFormSubmission — the ONE capture path. */
  captureFormSubmission?: CaptureFn
  /** @proofSeam lib/kernel/manager-signals.ts publishManagerSignal. */
  publishManagerSignal?: SignalFn
  /** @proofSeam lib/kernel/lead-magnets.ts createLeadMagnet. */
  createLeadMagnet?: CreateFn
  /** @proofSeam lib/kernel/action-ledger.ts withActionLedger. */
  withActionLedger?: LedgerFn
}
const kernel = () => import("@/lib/kernel/lead-magnets")
const track = async (d: CalculatorDeps): Promise<TrackFn> => d.trackMagnetEvent ?? ((await kernel()).trackMagnetEvent as unknown as TrackFn)
const capture = async (d: CalculatorDeps): Promise<CaptureFn> => d.captureFormSubmission ?? ((await kernel()).captureFormSubmission as unknown as CaptureFn)
const signal = async (d: CalculatorDeps): Promise<SignalFn> => d.publishManagerSignal ?? ((await import("@/lib/kernel/manager-signals")).publishManagerSignal as unknown as SignalFn)
const ledger = async (d: CalculatorDeps): Promise<LedgerFn> => d.withActionLedger ?? ((await import("@/lib/kernel/action-ledger")).withActionLedger as unknown as LedgerFn)

// ── authoring ─────────────────────────────────────────────────────────────────
export interface CreateCalculatorArtifactInput {
  /** All three from the SESSION (the action resolves them; never a body field). */
  brokerageId: string
  agentId: string
  createdBy: string
  title: string
  config: unknown
}

/** Create a calculator artifact as a DRAFT lead magnet (published by the existing publish door, with its fair-housing scan,
 *  approver and optional QR). The tenant's brand and voice are stored WITH the artifact so the first render carries them. */
export async function createCalculatorArtifact(input: CreateCalculatorArtifactInput, deps: CalculatorDeps): Promise<{ success: boolean; magnetId?: string; slug?: string; error?: string }> {
  if (!input.brokerageId || !input.agentId || !input.createdBy) return { success: false, error: "Not authenticated" }
  const title = text(input.title, 120)
  if (!title) return { success: false, error: "Give the calculator a title" }
  const n = normalizeCalculatorArtifactConfig(input.config)
  if (!n.ok) return { success: false, error: n.errors.join("; ") }
  const cfg = n.config
  const side = CALCULATOR_SPECS[cfg.kind].side
  const create: CreateFn = deps.createLeadMagnet ?? ((await kernel()).createLeadMagnet as unknown as CreateFn)
  return create({
    title, description: CALCULATOR_SPECS[cfg.kind].title, magnetType: "calculator",
    brokerageId: input.brokerageId, agentId: input.agentId, createdBy: input.createdBy,
    publishState: "draft",
    thankYouMessage: cfg.cta.mode === "talk_to_agent" ? "Thank you — your agent has your numbers and will reach out." : "Thank you — your results are saved with your agent.",
    landingContent: {
      headline: title, subhead: cfg.brand.tagline ?? CALCULATOR_SPECS[cfg.kind].title, cta: cfg.cta.label,
      bullets: [], topics: [], faq: [], faqJsonLd: null, fromTopics: false, generatedAt: new Date().toISOString(), videoUrl: cfg.explainer.videoUrl,
    },
    settings: {
      calculator: cfg,
      ...(side === "seller" ? { default_contact_type: "seller" } : side === "buyer" ? { default_contact_type: "buyer" } : {}),
      authoring: { by: "human", requested_by: input.createdBy, artifact: "calculator" },
    },
  }, { client: deps.client })
}

// ── the public door ───────────────────────────────────────────────────────────
export interface PublicCalculatorArtifact { formId: string; brokerageId: string; agentId: string | null; slug: string; name: string; config: CalculatorArtifactConfig }

/** The ACTIVE calculator artifact behind a form id (the tenant is the row's). A draft, another magnet, a refused read → null. */
export async function loadPublicCalculatorArtifact(client: Db, formId: string): Promise<PublicCalculatorArtifact | null> {
  if (!/^[0-9a-f-]{36}$/i.test(String(formId ?? ""))) return null
  const { data, error } = await client.from("lead_capture_forms").select("id, brokerage_id, agent_id, slug, name, is_active, settings").eq("id", formId).maybeSingle()
  if (error || !data || data.is_active !== true || !data.brokerage_id) return null
  const config = calculatorArtifactOf(data.settings)
  if (!config) return null
  return { formId: data.id, brokerageId: data.brokerage_id, agentId: data.agent_id ?? null, slug: data.slug, name: data.name, config }
}

const attributionMeta = (a: LeadMagnetAttribution | null | undefined) => (a ? { qr: a.qr ?? null, utm_source: (a as { utmSource?: string | null }).utmSource ?? null, campaign_id: (a as { campaignId?: string | null }).campaignId ?? null } : {})

/** A visitor opened the calculator. Records one event; never a contact. */
export async function recordCalculatorOpen(input: { formId: string; attribution?: LeadMagnetAttribution | null }, deps: CalculatorDeps): Promise<{ success: boolean; error?: string }> {
  const art = await loadPublicCalculatorArtifact(deps.client, input.formId)
  if (!art) return { success: false, error: "Calculator not found" }
  const r = await (await track(deps))({ magnetId: art.formId, eventType: "calculator_open", metadata: { calculatorKind: art.config.kind, ...attributionMeta(input.attribution) } }, { client: deps.client })
  return { success: r.success, error: r.error }
}

/** A visitor computed. PUBLIC audience always; records calculation_completed on success; never a contact. */
export async function computeCalculatorArtifact(input: { formId: string; inputs: Record<string, unknown>; estimateKeys?: string[]; attribution?: LeadMagnetAttribution | null }, deps: CalculatorDeps): Promise<{ success: true; outcome: CalculatorOutcome } | { success: false; error: string }> {
  const art = await loadPublicCalculatorArtifact(deps.client, input.formId)
  if (!art) return { success: false, error: "Calculator not found" }
  const outcome = runCalculator(art.config.kind, visibleInputs(art.config, input.inputs), { audience: "public", jurisdiction: art.config.jurisdiction, estimateKeys: input.estimateKeys ?? [] })
  if (outcome.ok) {
    await (await track(deps))({ magnetId: art.formId, eventType: "calculation_completed", metadata: { calculatorKind: art.config.kind, period: outcome.period, engineVersion: outcome.engineVersion, ...attributionMeta(input.attribution) } }, { client: deps.client })
  }
  return { success: true, outcome }
}

/** PURE. Drop the inputs the author hid (a hidden optional field is "not included", never smuggled back in by a client). */
function visibleInputs(cfg: CalculatorArtifactConfig, inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const allowed = new Set(CALCULATOR_SPECS[cfg.kind].fields.map((f) => f.key).filter((k) => !cfg.hiddenFields.includes(k)))
  for (const [k, v] of Object.entries(inputs && typeof inputs === "object" ? inputs : {})) if (allowed.has(k)) out[k] = v
  return out
}

export interface CalculatorOptInInput {
  formId: string
  inputs: Record<string, unknown>
  estimateKeys?: string[]
  intent: "save_results" | "talk_to_agent"
  contact: { first_name?: string; last_name?: string; email?: string; phone?: string }
  /** THE ONE CONSENT COMPONENT's submission (C15) — re-rendered server-side by the kernel. */
  consent?: unknown
  tcpaConsentGiven?: boolean
  attribution?: LeadMagnetAttribution | null
  ipAddress?: string
  userAgent?: string
}

/**
 * The visitor CHOSE to save their results or talk to an agent. Recomputed here (the client's numbers are never trusted), then
 * EXACTLY ONE capture through the existing path, one opt-in event, and the follow-on handoff — all under one ledger receipt.
 */
export async function optInCalculatorResult(input: CalculatorOptInInput, deps: CalculatorDeps): Promise<{ success: boolean; contactId?: string; submissionId?: string; followOn?: FollowOnPlan; error?: string }> {
  const art = await loadPublicCalculatorArtifact(deps.client, input.formId)
  if (!art) return { success: false, error: "Calculator not found" }
  const intent = input.intent === "talk_to_agent" ? "talk_to_agent" : "save_results"
  const first = text(input.contact?.first_name, 80)
  const email = text(input.contact?.email, 200)
  const phone = text(input.contact?.phone, 40)
  if (!first || (!email && !phone)) return { success: false, error: "Enter your first name and an email or phone number so we can keep your results." }
  const outcome = runCalculator(art.config.kind, visibleInputs(art.config, input.inputs), { audience: "public", jurisdiction: art.config.jurisdiction, estimateKeys: input.estimateKeys ?? [] })
  if (!outcome.ok) return { success: false, error: [...outcome.missing.map((m) => m.message), ...outcome.refused.map((r) => `${r.label}: ${r.reason}`)].join("; ") || "The calculation is incomplete." }
  const plan = planCalculatorFollowOn(art.config.kind, intent)
  const inputsJson = JSON.stringify(visibleInputs(art.config, input.inputs))
  const submissionData: Record<string, unknown> = {
    first_name: first, last_name: text(input.contact?.last_name, 80) ?? "", email, phone,
    calculator_kind: art.config.kind, calculator_intent: intent,
    calculator_inputs: inputsJson.length <= 4000 ? JSON.parse(inputsJson) : { omitted: "too_large" },
    calculator_result: { headline: outcome.headline, outputs: outcome.outputs, period: outcome.period, engine: outcome.engineVersion },
  }
  const run = async () => {
    const cap = await (await capture(deps))({
      formId: art.formId, brokerageId: art.brokerageId, submissionData, source: "calculator", consent: input.consent, consentDoor: "lead_magnet",
      tcpaConsentGiven: input.tcpaConsentGiven ?? false, attribution: input.attribution ?? null, ipAddress: input.ipAddress, userAgent: input.userAgent,
    }, { client: deps.client })
    if (!cap.success) return { success: false as const, error: cap.error ?? "Could not save your results" }
    await (await track(deps))({ magnetId: art.formId, brokerageId: art.brokerageId, eventType: "calculator_opt_in", contactId: cap.contactId, metadata: { calculatorKind: art.config.kind, intent, nextStep: plan.nextStep, ...attributionMeta(input.attribution) } }, { client: deps.client })
    if (plan.toManager && cap.contactId) {
      const s = await (await signal(deps))({
        brokerageId: art.brokerageId, fromManager: "campaign_orchestrator", toManager: plan.toManager, signalType: "lead_magnet_handoff",
        message: `${CALCULATOR_SPECS[art.config.kind].title}: the person ${intent === "talk_to_agent" ? "asked to talk with an agent" : "saved their estimate"} — next step: ${plan.nextStep.replace(/_/g, " ")} (${plan.why}).`,
        entityType: "contact", entityId: cap.contactId, contactId: cap.contactId,
        payload: { magnetType: "calculator", calculatorKind: art.config.kind, intent, nextStep: plan.nextStep, why: plan.why, source: "calculator", formId: art.formId },
      }, deps.client)
      if (!s.ok) console.warn("[calculators] follow-on handoff not raised:", s.reason)
    }
    return { success: true as const, contactId: cap.contactId, submissionId: cap.submissionId, followOn: plan }
  }
  return (await ledger(deps))(
    { brokerageId: art.brokerageId, action: "marketing.calculator.opt_in", actor: { type: "system" }, subject: { type: "lead_capture_form", id: art.formId }, reasonCode: "HUMAN_REQUESTED", reasonDetail: `visitor opted in (${intent}) on a ${art.config.kind} calculator`, riskClass: "LOW_RISK_WRITE", systemSource: "lead_magnets", detail: { calculator_kind: art.config.kind, intent, next_step: plan.nextStep } },
    run,
    { settle: (r: { success: boolean; error?: string; contactId?: string }) => (r.success ? { status: "executed", outcome: "captured", providerRef: r.contactId ?? null } : { status: "failed", outcome: "capture_refused", error: r.error }), replay: (claim: { kind: string }) => ({ success: false, error: `ledger refused the opt-in: ${claim.kind}` }) },
    { client: deps.client },
  )
}

// ── the internal seller net sheet (authorized seat only) ──────────────────────────────────────────────────────────────
/** Seats that may price a net sheet with the brokerage's AGREED commission: the operational tenant roster plus a licensed
 *  agent (CLAUDE.md §5: commission amounts are shown to the agent and the team lead). Never a vendor, contact, lender or ISA. */
export const INTERNAL_NET_SHEET_EXTRA_SEATS = ["agent"] as const

export interface InternalSession { userId: string | null; brokerageId: string | null; userType: string | null }

/** Session → the brokerage's agreed listing commission → the engine with audience "internal". Fails closed. */
export async function computeInternalSellerNet(
  input: { inputs: Record<string, unknown>; jurisdiction?: string | null; estimateKeys?: string[] },
  session: InternalSession,
  deps: { loadAgreedCommission?: (brokerageId: string) => Promise<AgreedCommission | null> } = {},
): Promise<{ success: true; outcome: CalculatorOutcome } | { success: false; error: string }> {
  if (!session.userId || !session.brokerageId) return { success: false, error: "Sign in to use the brokerage net sheet." }
  const { TENANT_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  const seat = String(session.userType ?? "").toLowerCase()
  if (!TENANT_ADMIN_USER_TYPES.has(seat) && !(INTERNAL_NET_SHEET_EXTRA_SEATS as readonly string[]).includes(seat)) {
    return { success: false, error: "Your seat cannot price a net sheet with the brokerage's commission terms — use the public estimate." }
  }
  const load = deps.loadAgreedCommission ?? defaultAgreedCommission
  let agreed: AgreedCommission | null = null
  try { agreed = await load(session.brokerageId) } catch (e) { return { success: false, error: `The brokerage's commission terms could not be read: ${(e as Error)?.message ?? String(e)}` } }
  if (!agreed) return { success: false, error: "No default commission structure is configured for this brokerage — configure it, or use the public estimate and enter the commission." }
  const jurisdiction = input.jurisdiction == null || input.jurisdiction === "" ? null : String(input.jurisdiction).toUpperCase()
  return { success: true, outcome: runCalculator("seller_net_sheet", input.inputs ?? {}, { audience: "internal", jurisdiction, agreedCommission: agreed, estimateKeys: input.estimateKeys ?? [] }) }
}

async function defaultAgreedCommission(brokerageId: string): Promise<AgreedCommission | null> {
  const { getDefaultCommissionStructure } = await import("@/lib/brokerage/get-default-commission-structure")
  const s = await getDefaultCommissionStructure(brokerageId)
  const pct = Math.round(s.grossRateDecimal * 100 * 10_000) / 10_000
  return { listingRatePct: pct, flatAmount: null, label: `${pct}% — the brokerage's default commission structure` }
}

// ── performance (observable) ──────────────────────────────────────────────────
/** The calculator funnel for one artifact, tenant-pinned: scans → opens → completions → opt-ins → submissions. */
export async function getCalculatorFunnel(client: Db, input: { brokerageId: string; formId: string }): Promise<{ success: boolean; funnel?: Record<string, number>; error?: string }> {
  const { data: form, error: fErr } = await client.from("lead_capture_forms").select("id").eq("id", input.formId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (fErr) return { success: false, error: fErr.message }
  if (!form) return { success: false, error: "Calculator not found in this brokerage" }
  const funnel: Record<string, number> = {}
  for (const e of ["qr_scan", ...CALCULATOR_EVENTS]) {
    const { count, error } = await client.from("lifecycle_events").select("id", { count: "exact", head: true }).eq("brokerage_id", input.brokerageId).eq("entity_type", "lead_capture_form").eq("entity_id", input.formId).eq("event_type", `lead_magnet_${e}`)
    if (error) return { success: false, error: error.message }
    funnel[e] = count ?? 0
  }
  const { count: subs, error: sErr } = await client.from("form_submissions").select("id", { count: "exact", head: true }).eq("brokerage_id", input.brokerageId).eq("form_id", input.formId)
  if (sErr) return { success: false, error: sErr.message }
  funnel.submissions = subs ?? 0
  return { success: true, funnel }
}

// ── brand at FIRST render (tenant voice, never a generic shell) ───────────────
export interface CalculatorBrand { displayName: string; primaryColor: string; logoUrl: string | null; tagline: string | null }
/** The neutral bar the tenant website already uses when a brokerage has set no colour (app/site/[slug]/lm/[formSlug]). */
export const CALCULATOR_NEUTRAL_BAR = "#0F172A"

/** PURE. The author's choices first, then the tenant's own brand record — the visitor never sees a platform default name. */
export function resolveCalculatorBrand(cfg: CalculatorArtifactConfig, tenant: { name?: string | null; logo_url?: string | null; primary_color?: string | null } | null): CalculatorBrand {
  const tenantColor = typeof tenant?.primary_color === "string" && HEX.test(tenant.primary_color) ? tenant.primary_color : null
  return {
    displayName: cfg.brand.displayName ?? (text(tenant?.name, 80) ?? ""),
    primaryColor: cfg.brand.primaryColor ?? tenantColor ?? CALCULATOR_NEUTRAL_BAR,
    logoUrl: cfg.brand.logoUrl ?? httpsOrNull(tenant?.logo_url),
    tagline: cfg.brand.tagline,
  }
}

/** The tenant brand row for a calculator page (tenant-pinned by the form's own brokerage id). A refused read → the author's
 *  choices alone, said on the console. */
export async function loadCalculatorBrand(client: Db, brokerageId: string, cfg: CalculatorArtifactConfig): Promise<CalculatorBrand> {
  const { data, error } = await client.from("brokerages").select("name, logo_url, primary_color").eq("id", brokerageId).maybeSingle()
  if (error) console.warn("[calculators] tenant brand not read — the author's brand only:", error.message)
  return resolveCalculatorBrand(cfg, (data as { name?: string | null; logo_url?: string | null; primary_color?: string | null } | null) ?? null)
}
