"use server"

import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateAiListingPresentation,
  type AiListingPresentationPropertyData,
} from "@/lib/listing-presentation/generate-ai-presentation"
import { z } from "zod"
import { requireCaller } from "@/lib/auth/require-caller"

// ============================================================================
// AI LISTING PRESENTATION GENERATOR
// Dynamic presentations for seller consultations and listings
// ============================================================================

// Auth gate — every function here makes paid AI inference. Without auth,
// unauthenticated callers could burn AI budget at will.
// TOMBSTONE (§1.1, 2026-09-08): local `requireCaller` lived here; survivor
// lib/auth/require-caller.ts:requireCaller (this lane's fold-in of the
// 2026-09-03 wave-26 survivor)

/**
 * Generate a complete listing presentation package.
 *
 * THE AUTHENTICATED DOOR. The work itself lives in
 * lib/listing-presentation/generate-ai-presentation.ts so the UNATTENDED caller —
 * step 2 of the listing-appt-prep chain, which the AI-ISA drives from a webhook
 * with no session — has a door of its own instead of being turned away by the
 * gate below. The tenant is derived from the session here and from the run row
 * there; neither takes it from the caller.
 */
export async function generateListingPresentation(params: {
  agentId: string
  contactId?: string | null
  appointmentId?: string | null
  appointmentAt?: string | null
  propertyData: AiListingPresentationPropertyData
  sellerInfo?: {
    name: string
    concerns?: string[]
    previousAgentExperience?: string
  }
  /** The agent's own note to this seller, typed on the CMA → Presentation tab. */
  agentMessage?: string
  presentationType?: "full" | "mini" | "digital"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  try {
    return await generateAiListingPresentation({
      brokerageId:    auth.brokerageId,
      agentId:        params.agentId,
      contactId:      params.contactId ?? null,
      appointmentId:  params.appointmentId ?? null,
      appointmentAt:  params.appointmentAt ?? null,
      propertyData:   params.propertyData,
      sellerInfo:     params.sellerInfo,
      agentMessage:   params.agentMessage,
      presentationType: params.presentationType,
    })
  } catch (error) {
    console.error("[v0] Generate listing presentation error:", error)
    return handleError(error, "generateListingPresentation")
  }
}

/**
 * Generate seller net sheet with AI explanations
 */
export async function generateSellerNetSheet(params: {
  agentId: string
  salePrice: number
  mortgagePayoff?: number
  commissionRate?: number
  state: string
  county?: string
  additionalCosts?: { name: string; amount: number }[]
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    // Resolve commission rate: caller-supplied → brokerage default → 3%
    let commissionRate = params.commissionRate
    if (commissionRate == null) {
      try {
        const service = createServiceClient()
        const { data: agentRow } = await service
          .from("agents")
          .select("brokerage_id")
          .eq("id", params.agentId)
          .maybeSingle()
        if (agentRow?.brokerage_id) {
          const structure = await getDefaultCommissionStructure(agentRow.brokerage_id, params.agentId)
          commissionRate = structure.grossRateDecimal * 100
        }
      } catch {
        // No default structure configured — fall back to industry default
      }
      commissionRate = commissionRate ?? 3
    }
    
    const { object: netSheet } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        summary: z.object({
          salePrice: z.number(),
          totalDeductions: z.number(),
          estimatedNet: z.number(),
          netPercentage: z.number()
        }),
        deductions: z.array(z.object({
          category: z.string(),
          item: z.string(),
          amount: z.number(),
          explanation: z.string(),
          isEstimate: z.boolean()
        })),
        taxes: z.object({
          transferTax: z.number(),
          propertyTaxProration: z.number(),
          capitalGainsNote: z.string()
        }),
        closingCosts: z.object({
          titleInsurance: z.number(),
          escrowFees: z.number(),
          recordingFees: z.number(),
          otherFees: z.number()
        }),
        scenarios: z.array(z.object({
          scenarioName: z.string(),
          salePrice: z.number(),
          estimatedNet: z.number(),
          notes: z.string()
        })),
        recommendations: z.array(z.string()),
        disclaimer: z.string()
      }),
      prompt: `Generate a detailed seller net sheet:

Sale Price: $${params.salePrice}
Mortgage Payoff: $${params.mortgagePayoff || 0}
Commission Rate: ${commissionRate}%
State: ${params.state}
County: ${params.county || "N/A"}

Additional Costs:
${JSON.stringify(params.additionalCosts || [], null, 2)}

Calculate and explain:
1. All typical seller closing costs for ${params.state}
2. Transfer taxes and prorations
3. Commission breakdown
4. Three price scenarios (+/- 5%)
5. Clear explanations for each line item
6. Recommendations to maximize net
7. Required legal disclaimer`
    })

    return {
      success: true,
      netSheet
    }
  } catch (error) {
    console.error("[v0] Generate seller net sheet error:", error)
    return handleError(error, "generateSellerNetSheet")
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `generateVideoScript` was DELETED (wave 57, Task B duplicates
 * round 2 — one of SEVEN functions named generateVideoScript found repo-wide).
 *
 * SURVIVOR: app/actions/video/generate-script.ts:141 generateVideoScript, the
 * canonical Video Studio generator behind /dashboard/videos/create —
 * compliance-gated (lib/video/script-compliance.ts: brand voice, ThemFirst,
 * Fair Housing, before AND after generation) and one of the FIVE generators
 * lib/kernel/manager-registry.ts video_script_compliance already documents
 * as audited and reachable.
 *
 * This copy was NEVER in that audited five and had NO compliance gate at
 * all — it dispatched straight to generateObject/resolveModel("openai/
 * gpt-4o"), a SECOND, ungoverned AI call path bypassing even the standard
 * generateAIResponse gateway the rest of this file's siblings use, on
 * agent-facing marketing copy describing a real listing. Exactly the hole
 * §5's "compliance-first" ruling exists to close, and it never had a chance
 * to fire: zero callers anywhere in the tree. Nothing else in this file
 * (generateListingPresentation, generateSellerNetSheet) called it, and no
 * page/component imported it — presentation-assembler.ts's own
 * `generateVideoScript` at line 435 is an unrelated LOCAL, unexported,
 * synchronous function with the same name, not a caller of this one.
 * ─────────────────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────────────────────
 * TOMBSTONE — `generateBrochureContent` was REMOVED (orphan burn-down, Lane A).
 *
 * SURVIVOR: `lib/documents/listing-brochure.ts` — `runListingBrochures` (line 91)
 * with `listingBrochureSpec` (line 50). It is wired and autonomous: the daily
 * video-plays cron runs it (app/api/cron/video-plays/route.ts:50) and the Jobs
 * kernel's "Launch full listing kit" play runs it on demand
 * (lib/kernel/jobs.ts:102). This function had no caller anywhere.
 *
 * NOTHING WAS MERGED, because the survivor already covers every section this
 * produced and does three things this could not:
 *
 *   · IT PRODUCES THE ACTUAL ARTEFACT. The survivor lays out a multi-page PDF —
 *     brand cover, hero spread, facts table, highlights, photo gallery, agent
 *     page — hosts it on storage through produceClientDocument, records it in
 *     generated_documents, and notifies the agent with the print-ready link.
 *     This function returned a JSON blob to its caller and persisted nothing, so
 *     even with a caller there would have been no brochure at the end of it.
 *   · ITS COPY IS GROUNDED AND GATED. The survivor's narrative goes through
 *     generatePersonaCopy on the compliance-gated copy rail, built ONLY from the
 *     listing's own remarks and facts, with those remarks as a deterministic
 *     fallback. This function asked a model for `neighborhoodHighlights` and a
 *     `schoolInfo[]` carrying a per-school `rating` — invented school ratings
 *     printed beside a real address, on a leave-behind, is a Fair Housing and
 *     accuracy hazard, not a missing feature.
 *   · IT IS IDEMPOTENT. One brochure per listing, keyed on generated_documents,
 *     so a re-run cannot produce a second conflicting piece.
 *
 * NOT CARRIED, AND SAID PLAINLY: the survivor has no equivalent of this
 * function's `brochureType` tone variants (luxury / standard / investment /
 * new_construction) — its narrative prompt is fixed at "editorial, magazine
 * tone". That is a real gap and a worthwhile follow-up on
 * lib/documents/listing-brochure.ts, but it is a one-line prompt input on the
 * survivor, not a reason to keep a second brochure generator that produces no
 * brochure.
 * ───────────────────────────────────────────────────────────────────────────── */
