/**
 * lib/direct-mail/variant-bandit.ts
 *
 * Wave 36 — Thompson-sampling multi-armed bandit over direct-mail
 * variant arms. Called by the orchestrator before each render to
 * pick which (composition × copy_style × layout) arm fires for the
 * given (persona × use_kind × size) cohort.
 *
 * Thompson sampling explained:
 *   Each arm carries a Beta posterior over its scan-rate. We sample
 *   one probability per arm and pick the arm with the highest sample.
 *   - Hot arms (high scans_count / sends_count) have tight posteriors
 *     near their observed rate — usually win
 *   - Cold arms (sends_count=0) have flat Beta(1,1) posteriors — get
 *     picked roughly 1/N of the time so we keep exploring
 *   - Lukewarm arms (some sends, low scans) have posteriors near 0 —
 *     rarely picked, deprioritized organically
 *
 *   No ε-greedy schedule, no manual cold/warm switches; the math
 *   handles exploration vs exploitation automatically.
 *
 * Arm seeding: the platform ships a canonical catalog of arms
 * (composition × copy_style combinations) for each (persona,
 * use_kind, size). On first call for a (brokerage, persona,
 * use_kind, size) tuple we ensure the catalog is materialized in
 * direct_mail_variants for that brokerage so the bandit has arms
 * to sample from.
 *
 * Bandit picks one ARM per dispatch — the orchestrator then resolves
 * the arm's composition_id + copy_style + layout_variant into the
 * actual Remotion composition + prompt template + props.
 *
 * No randomness in production sampling? We use crypto.randomBytes
 * so a deterministic seed isn't required and the bandit produces
 * different picks across requests (the whole point of Thompson).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { randomBytes } from "node:crypto"
import type { Persona } from "@/lib/kernel/types"
import type { PostcardSize, DirectMailUseKind } from "@/lib/direct-mail/resolve-size-pref"

export interface BanditPick {
  variantId:     string
  compositionId: string
  copyStyle:     string
  layoutVariant: string
  /** Posterior probability the bandit sampled for this arm; for
   *  debugging + the audit trail. Higher = more confidence. */
  sampledProb:   number
  /** Whether this is a cold arm (no sends yet) — useful telemetry
   *  for the admin dashboard's "% of mail used to explore vs
   *  exploit" metric. */
  isExploration: boolean
  /** Wave 37 — which Beta the sampler used. "scans" is the engagement
   *  proxy (Beta(scans+1, sends-scans+1)); "leads" is the conversion
   *  target (Beta(leads+1, sends-leads+1)). The math switches per-
   *  cohort when aggregate leads >= LEADS_COHORT_THRESHOLD. */
  samplingMode:  "scans" | "leads"
}

/** Wave 37 — switch the Thompson Beta from scan-rate to lead-rate
 *  when the cohort has accumulated enough lead observations that the
 *  noisier-but-truer signal (leads) outweighs the higher-volume-but-
 *  upstream signal (scans). Threshold of 30 is the standard small-N
 *  → meaningful-N inflection from bandit literature; below this the
 *  Beta(leads+1, ...) posterior is too flat to discriminate arms. */
const LEADS_COHORT_THRESHOLD = 30

/** Platform-default arm catalog. Each (use_kind, postcard_size)
 *  ships with N (composition × copy_style) combinations. The bandit
 *  starts exploring across these on first dispatch.
 *
 *  copy_style keys match prompt templates the draft-copy generator
 *  switches on (added in a parallel commit when prompt-template
 *  switching lands; for now the orchestrator passes the style as
 *  a context hint to the existing single prompt). */
const PLATFORM_CATALOG: Array<{
  use_kind:       DirectMailUseKind | "lifecycle" | "pre_listing_kit"
  postcard_size:  PostcardSize
  composition_id: string
  copy_style:     string
  layout_variant: string
}> = [
  // 4x6 arms
  { use_kind: "farm_mail",       postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "direct-fact",     layout_variant: "default" },
  { use_kind: "farm_mail",       postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "question-hook",   layout_variant: "default" },
  { use_kind: "farm_mail",       postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "social-proof",    layout_variant: "default" },
  { use_kind: "welcome_kit",     postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "intro-warm",      layout_variant: "default" },
  { use_kind: "welcome_kit",     postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "intro-credibility", layout_variant: "default" },
  { use_kind: "sphere_outreach", postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "checkin-personal", layout_variant: "default" },
  { use_kind: "lifecycle",       postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "direct-fact",     layout_variant: "default" },
  { use_kind: "pre_listing_kit", postcard_size: "4x6", composition_id: "PostcardFront4x6", copy_style: "appointment-prep", layout_variant: "default" },
  // 6x9 arms — get a separate copy style ("photo-led") that leans
  // into the property-photo hero the larger canvas affords.
  { use_kind: "farm_mail",       postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "photo-led",       layout_variant: "default" },
  { use_kind: "farm_mail",       postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "social-proof",    layout_variant: "default" },
  { use_kind: "welcome_kit",     postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "intro-warm",      layout_variant: "default" },
  { use_kind: "sphere_outreach", postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "checkin-personal", layout_variant: "default" },
  { use_kind: "lifecycle",       postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "photo-led",       layout_variant: "default" },
  { use_kind: "pre_listing_kit", postcard_size: "6x9", composition_id: "PostcardFront6x9", copy_style: "appointment-prep", layout_variant: "default" },
]

/** All canonical personas — every arm × persona is materializable. */
const ALL_PERSONAS: Persona[] = [
  "first_time", "relocated", "luxury", "fsbo", "probate",
  "upsize", "downsize", "military", "divorce", "senior",
  "expired", "foreclosure", "other",
]

/** Sample one number from Beta(α, β) using the gamma-ratio trick.
 *  Each Beta sample is Gamma(α, 1) / (Gamma(α, 1) + Gamma(β, 1));
 *  for integer α + β we use a fast Marsaglia-Tsang variant via the
 *  log-of-sums trick. For our scale (α ≤ ~10K) the simple Marsaglia
 *  is plenty fast (microseconds) and crypto-random gives us non-
 *  deterministic exploration across calls. */
function sampleGamma(shape: number): number {
  // Marsaglia-Tsang for shape >= 1; recursion trick for 0 < shape < 1.
  if (shape < 1) {
    return sampleGamma(shape + 1) * Math.pow(randomUniform(), 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number, v: number
    do {
      x = randomGaussian()
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = randomUniform()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function sampleBeta(alpha: number, beta: number): number {
  const x = sampleGamma(alpha)
  const y = sampleGamma(beta)
  return x / (x + y)
}

function randomUniform(): number {
  // Crypto random uniform in [0, 1). 32 bits is plenty for Beta.
  const buf = randomBytes(4)
  const n = buf.readUInt32BE(0)
  return n / 0x1_0000_0000
}

function randomGaussian(): number {
  // Box-Muller from two uniforms. Cheap, no caching pair needed for
  // our call volume.
  const u1 = randomUniform() || Number.EPSILON
  const u2 = randomUniform()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Ensure the arm catalog is materialized for this (brokerage,
 * persona, use_kind, size). Inserts platform-default arms that
 * don't yet exist as brokerage-scoped rows. Idempotent.
 */
async function ensureArmsForCohort(args: {
  brokerageId: string
  persona:     Persona
  useKind:     DirectMailUseKind | "lifecycle" | "pre_listing_kit"
  size:        PostcardSize
}): Promise<void> {
  const svc = createServiceClient()
  const catalog = PLATFORM_CATALOG.filter(
    (c) => c.use_kind === args.useKind && c.postcard_size === args.size,
  )
  if (catalog.length === 0) return

  // Pull existing arms for this cohort to know what we still need.
  const { data: existing } = await svc
    .from("direct_mail_variants")
    .select("composition_id, copy_style, layout_variant")
    .eq("brokerage_id", args.brokerageId)
    .eq("persona", args.persona)
    .eq("use_kind", args.useKind)
    .eq("postcard_size", args.size)
    .eq("is_active", true)
  const have = new Set(
    ((existing ?? []) as Array<{ composition_id: string; copy_style: string; layout_variant: string }>)
      .map((r) => `${r.composition_id}|${r.copy_style}|${r.layout_variant}`),
  )

  const toInsert = catalog
    .filter((c) => !have.has(`${c.composition_id}|${c.copy_style}|${c.layout_variant}`))
    .map((c) => ({
      brokerage_id:   args.brokerageId,
      composition_id: c.composition_id,
      copy_style:     c.copy_style,
      layout_variant: c.layout_variant,
      persona:        args.persona,
      use_kind:       args.useKind,
      postcard_size:  args.size,
      is_active:      true,
    }))
  if (toInsert.length === 0) return

  // onConflict the unique key so concurrent dispatches don't double-
  // insert the same arm.
  await svc.from("direct_mail_variants").upsert(toInsert, {
    onConflict: "brokerage_id,composition_id,copy_style,layout_variant,persona,use_kind,postcard_size",
    ignoreDuplicates: true,
  })
}

/**
 * Pick one arm via Thompson sampling for the given cohort.
 *
 * Returns null when no arms exist for the cohort (which should never
 * happen post-ensureArmsForCohort but is the safe fall-through).
 * Caller treats null as "skip the bandit, use platform default".
 */
export async function pickVariantArm(args: {
  brokerageId: string
  persona:     Persona
  useKind:     DirectMailUseKind | "lifecycle" | "pre_listing_kit"
  size:        PostcardSize
}): Promise<BanditPick | null> {
  await ensureArmsForCohort(args)

  const svc = createServiceClient()
  // Pull every active arm for the cohort + its outcomes (LEFT JOIN
  // because cold arms have no outcomes row yet). One round-trip.
  const { data: arms } = await svc
    .from("direct_mail_variants")
    .select(`
      id, composition_id, copy_style, layout_variant,
      outcomes:direct_mail_variant_outcomes!direct_mail_variant_outcomes_variant_id_fkey(sends_count, scans_count, leads_count)
    `)
    .eq("brokerage_id", args.brokerageId)
    .eq("persona", args.persona)
    .eq("use_kind", args.useKind)
    .eq("postcard_size", args.size)
    .eq("is_active", true)

  type ArmRow = {
    id: string
    composition_id: string
    copy_style: string
    layout_variant: string
    outcomes: Array<{ sends_count: number; scans_count: number; leads_count: number }> | null
  }
  const armRows = (arms ?? []) as unknown as ArmRow[]
  if (armRows.length === 0) return null

  // Wave 37 — sampling mode decision PER COHORT (not per-arm). Sum
  // leads_count across every arm in this cohort; if the cohort has
  // crossed LEADS_COHORT_THRESHOLD, every arm samples on lead-rate
  // Beta. Below that, every arm samples on scan-rate Beta (the
  // higher-volume signal). Cohort-level decision keeps arms
  // comparable to each other — a mixed mode would let one arm
  // appear better than another for the wrong statistical reason.
  let cohortLeads = 0
  for (const arm of armRows) {
    const o = arm.outcomes?.[0]
    if (o) cohortLeads += o.leads_count ?? 0
  }
  const samplingMode: "scans" | "leads" = cohortLeads >= LEADS_COHORT_THRESHOLD ? "leads" : "scans"

  // Thompson sample per arm.
  let best: { row: ArmRow; sample: number; isExploration: boolean } | null = null
  for (const arm of armRows) {
    const outcome = arm.outcomes?.[0] ?? { sends_count: 0, scans_count: 0, leads_count: 0 }
    // Mode-conditional Beta. In "leads" mode the positive
    // observation is a LEAD (the action we actually want); in
    // "scans" mode it's a SCAN (the high-volume proxy).
    const positive = samplingMode === "leads" ? outcome.leads_count : outcome.scans_count
    const negative = Math.max(0, outcome.sends_count - positive)
    const alpha = positive + 1
    const beta  = negative + 1
    const sample = sampleBeta(alpha, beta)
    const isExploration = outcome.sends_count === 0
    if (!best || sample > best.sample) {
      best = { row: arm, sample, isExploration }
    }
  }
  if (!best) return null

  return {
    variantId:     best.row.id,
    compositionId: best.row.composition_id,
    copyStyle:     best.row.copy_style,
    layoutVariant: best.row.layout_variant,
    sampledProb:   best.sample,
    isExploration: best.isExploration,
    samplingMode,
  }
}

/** Stamp a send on the variant's outcomes row. Called by the
 *  orchestrator at dispatch time. UPSERTs so the first send for an
 *  arm creates the row, subsequent sends increment. */
export async function recordVariantSend(args: {
  variantId:    string
  brokerageId:  string
  costCents:    number
}): Promise<void> {
  const svc = createServiceClient()
  // Postgres-side increment via RPC would be cleaner; for now we do
  // SELECT-then-UPDATE inline. Concurrent dispatches to the same
  // (variant, brokerage) within milliseconds could lose an
  // increment — acceptable for a learning signal, but a server-side
  // function would be next-step hardening.
  const { data: existing } = await svc
    .from("direct_mail_variant_outcomes")
    .select("id, sends_count, cost_spent_cents")
    .eq("variant_id", args.variantId)
    .eq("brokerage_id", args.brokerageId)
    .maybeSingle()
  if (existing) {
    await svc.from("direct_mail_variant_outcomes")
      .update({
        sends_count:      (existing.sends_count as number) + 1,
        cost_spent_cents: (existing.cost_spent_cents as number) + args.costCents,
        last_send_at:     new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq("id", existing.id)
  } else {
    await svc.from("direct_mail_variant_outcomes").insert({
      variant_id:       args.variantId,
      brokerage_id:     args.brokerageId,
      sends_count:      1,
      scans_count:      0,
      cost_spent_cents: args.costCents,
      last_send_at:     new Date().toISOString(),
    })
  }
}
