import { generateAIResponse } from "@/lib/ai"
import { createServiceClient } from "@/lib/supabase/service"
import { processKernelEvent } from "@/lib/kernel"
import { KernelEvent } from "@/lib/kernel/events"

export interface CompScoreResult {
  comparableId: string
  score: number
  confidenceLevel: "high" | "medium" | "low"
  rationale: string
  riskFlags: string[]
  coachingInsight: string
}

export interface ScoreAllCompsResult {
  success: boolean
  scored: number
  cmaId: string
  error?: string
}

/**
 * Score all comparables for a CMA using Anthropic AI.
 * Writes to ai_comp_scores + comp_risk_flags, then fires CMA_GENERATED.
 */
export async function scoreAllComps(
  cmaId: string,
  listingId: string,
  brokerageId: string,
  actorUserId: string
): Promise<ScoreAllCompsResult> {
  const supabase = createServiceClient()

  // Load the CMA report for subject property context
  const { data: cma, error: cmaError } = await supabase
    .from("cma_reports")
    .select("*")
    .eq("id", cmaId)
    .single()

  if (cmaError || !cma) {
    return { success: false, scored: 0, cmaId, error: "CMA report not found" }
  }

  // Load all comparables for this CMA
  const { data: comps, error: compsError } = await supabase
    .from("cma_comparables")
    .select("*")
    .eq("cma_id", cmaId)

  if (compsError || !comps || comps.length === 0) {
    return { success: false, scored: 0, cmaId, error: "No comparables found for CMA" }
  }

  // Build subject property summary for prompt context
  const subjectSummary = [
    `Address: ${cma.property_address}`,
    `Type: ${cma.property_type ?? "unknown"}`,
    `Beds: ${cma.bedrooms ?? "?"}  Baths: ${cma.bathrooms ?? "?"}`,
    `SqFt: ${cma.square_feet ?? "?"}  Lot: ${cma.lot_size ?? "?"}`,
    `Year Built: ${cma.year_built ?? "?"}  Condition: ${cma.condition ?? "?"}`,
    `Features: ${(cma.features ?? []).join(", ") || "none listed"}`,
  ].join("\n")

  let scored = 0
  const riskFlagsToInsert: Array<{
    cma_id: string
    listing_id: string
    risk_type: string
    severity: string
    description: string
    recommended_action: string | null
  }> = []

  for (const comp of comps) {
    // Check if already scored — no duplicates
    const { data: existing } = await supabase
      .from("ai_comp_scores")
      .select("id")
      .eq("cma_id", cmaId)
      .eq("comparable_id", comp.id)
      .maybeSingle()

    if (existing) continue

    const compSummary = [
      `Address: ${comp.address}`,
      `Sale Price: $${comp.sale_price ?? "?"}  List Price: $${comp.list_price ?? "?"}`,
      `$/sqft: $${comp.price_per_sqft ?? "?"}`,
      `Beds: ${comp.bedrooms ?? "?"}  Baths: ${comp.bathrooms ?? "?"}`,
      `SqFt: ${comp.square_feet ?? "?"}`,
      `DOM: ${comp.days_on_market ?? "?"}  Distance: ${comp.distance_miles ?? "?"}mi`,
      `Sale Date: ${comp.sale_date ?? "?"}`,
    ].join("\n")

    const prompt = `You are a real estate comp analyst. Score this comparable (0-100) for a seller CMA.

SUBJECT PROPERTY:
${subjectSummary}

COMPARABLE:
${compSummary}

Respond ONLY with valid JSON (no markdown):
{
  "score": <integer 0-100>,
  "confidence_level": "<high|medium|low>",
  "rationale": "<2-3 sentences explaining the score>",
  "risk_flags": ["<flag1>", "<flag2>"],
  "coaching_insight": "<1 sentence agent coaching tip>"
}`

    try {
      const response = await generateAIResponse({
        prompt,
        maxTokens: 400,
        metadata: {
          userId: actorUserId,
          brokerageId: brokerageId,
          feature: "cma_narrative",
        },
      })

      let parsed: CompScoreResult & {
        confidence_level: string
        risk_flags: string[]
        coaching_insight: string
      }

      try {
        parsed = JSON.parse(response.text.trim())
      } catch {
        // Skip malformed responses
        continue
      }

      const score = Math.max(0, Math.min(100, Number(parsed.score) || 0))
      const confidenceLevel = ["high", "medium", "low"].includes(parsed.confidence_level)
        ? parsed.confidence_level
        : "medium"
      const riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags : []

      // INSERT ai_comp_scores
      await supabase.from("ai_comp_scores").insert({
        cma_id: cmaId,
        comparable_id: comp.id,
        listing_id: listingId,
        brokerage_id: brokerageId,
        score,
        confidence_level: confidenceLevel,
        score_rationale: parsed.rationale ?? null,
        risk_flags: riskFlags,
        coaching_insight: parsed.coaching_insight ?? null,
      })

      // UPDATE cma_comparables with score summary
      await supabase
        .from("cma_comparables")
        .update({
          ai_score: score,
          ai_rationale: parsed.rationale ?? null,
          risk_flags: riskFlags,
          coaching_insight: parsed.coaching_insight ?? null,
        })
        .eq("id", comp.id)

      // Collect risk flags for bulk insert into comp_risk_flags
      for (const flag of riskFlags) {
        riskFlagsToInsert.push({
          cma_id: cmaId,
          listing_id: listingId,
          risk_type: "comp_quality",
          severity: score < 50 ? "high" : score < 70 ? "medium" : "low",
          description: flag,
          recommended_action: null,
        })
      }

      scored++
    } catch {
      // Non-blocking — continue scoring remaining comps
      continue
    }
  }

  // Bulk insert risk flags
  if (riskFlagsToInsert.length > 0) {
    await supabase.from("comp_risk_flags").insert(riskFlagsToInsert)
  }

  // Update CMA quality_score based on average ai_score
  if (scored > 0) {
    const { data: scores } = await supabase
      .from("ai_comp_scores")
      .select("score")
      .eq("cma_id", cmaId)

    if (scores && scores.length > 0) {
      const avgScore = Math.round(
        scores.reduce((sum, s) => sum + s.score, 0) / scores.length
      )
      await supabase
        .from("cma_reports")
        .update({ quality_score: avgScore })
        .eq("id", cmaId)
    }
  }

  // Fire kernel event — non-blocking
  await supabase.from("lifecycle_events").insert({
    brokerage_id: brokerageId,
    entity_type: "listing",
    entity_id: listingId,
    event_type: KernelEvent.CMA_GENERATED,
    actor_user_id: actorUserId,
    metadata: { cma_id: cmaId, comps_scored: scored },
  })
  await processKernelEvent({
    event: KernelEvent.CMA_GENERATED,
    brokerageId,
    entityType: "listing",
    entityId: listingId,
  }).catch(() => {})

  return { success: true, scored, cmaId }
}
