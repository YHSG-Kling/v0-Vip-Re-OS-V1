/**
 * lib/listings/listing-description-core.ts — THE AI listing-description writer
 * (MLS / marketing / social / email / video / SEO copy in one routed call),
 * callable with no session (lane 86F, wave 86).
 *
 * THE DEFECT, TWICE OVER. app/api/cron/listing-presentation-prep →
 * lib/workflow/intelligence/listing-presentation-builder.ts step 4b
 * dynamically imported app/actions/ai-listing-intake.ts::aiGenerateListingDescription
 * — a "use server" action whose FIRST line is getAgentContext(). A cron has no
 * cookie, so every run was refused "Unauthorized" and the deck's cover slide
 * fell back to an auto-summary. And a second defect sat behind the first: the
 * builder read `descRes.description ?? descriptions.long ?? descriptions.standard`
 * — keys the action never returned (it returns descriptions.mlsDescription /
 * marketingDescription / socialCaption / …), so even a session call produced no
 * description. It also never passed the action's REQUIRED `style`. Found by
 * scripts/sessionless-use-server-census.ts (OPEN since 86E).
 *
 * THE SHAPE (template lib/transactions/dotloop-document-sync.ts): server-only,
 * the SERVICE client, a VERIFIED brokerageId and an agents.id proven to be in
 * that tenant:
 *   · the session door (aiGenerateListingDescription) hands ctx.brokerageId and
 *     ctx.agentId from getAgentContext;
 *   · the builder hands input.brokerageId and the agents.id it resolved from
 *     input.agentUserId with resolveAgentIdInBrokerage (users.id and agents.id
 *     are disjoint, §3 — resolved, never substituted).
 * Every read and write carries `.eq("brokerage_id", brokerageId)`.
 *
 * COMPLIANCE-FIRST (§5). The writing prompt now carries the ONE compliance block
 * set (lib/video/script-compliance.ts buildComplianceSystemBlocks — brand-voice
 * cascade, them-first, Fair Housing, the brokerage's own prohibited phrases,
 * read on the service client with this tenant), not only a one-line "include
 * Fair Housing compliant language", and the MLS copy is graded by postcheckScript
 * on the same client (a `FairHousing:` line is a hard flag the caller honours).
 * The guardContent grade is kept: on the MLS description (the regulated channel) it files a
 * flagged result to approval_items for a human and is linked to the saved row
 * with attachApprovalSubject. Its brand-voice half now reads through 86C's tenant
 * door (lib/kernel/tenant-config-reads.ts applyTenantBrandVoice) on this service
 * client (lane 86F2) — before, from a cron, it read as anon and checked no brand
 * rules; the agent-level voice is keyed on the author's users.id.
 *
 * Server-only, never "use server" — this trusts the brokerageId it is handed.
 */
import "server-only"
import { z } from "zod"
import { generateObjectRouted } from "@/lib/ai/models"
import { guardContent, attachApprovalSubject } from "@/lib/content-guardian"
import { buildComplianceSystemBlocks, postcheckScript } from "@/lib/video/script-compliance"
import { isValidUUID } from "@/lib/validations"

export type ListingDescriptionStyle = "luxury" | "family" | "investor" | "first_time_buyer"

export const LISTING_DESCRIPTIONS_SCHEMA = z.object({
  mlsDescription: z.string().describe("MLS-compliant description, 500 chars max, no superlatives"),
  marketingDescription: z.string().describe("Marketing headline and paragraph for websites"),
  socialCaption: z.string().describe("Instagram/Facebook caption with hashtags"),
  emailTeaser: z.string().describe("Email preview text, 150 chars"),
  videoScript: z.string().describe("30-second video walkthrough script"),
  seoTitle: z.string().describe("SEO-optimized page title"),
  seoDescription: z.string().describe("Meta description for search engines"),
})
export type ListingDescriptions = z.infer<typeof LISTING_DESCRIPTIONS_SCHEMA>

export interface ListingDescriptionInput {
  /** The verified tenant (session, or the builder's resolved input). */
  brokerageId: string
  /** agents.id, proven in the tenant below. */
  agentId: string
  /** users.id for the AI cost ledger actor, when known. */
  userId?: string | null
  propertyData: Record<string, unknown>
  style: ListingDescriptionStyle
  highlights?: string[]
  neighborhood?: string
  /** The listing the copy is for — stamped only when it is THIS tenant's. */
  listingId?: string | null
}

export type ListingDescriptionResult =
  | {
      success: true
      descriptions: ListingDescriptions
      guardResult: { flagged: boolean; violations: string[]; notes: string[]; guardFailed?: boolean }
      /** postcheckScript's lines for the MLS copy — `FairHousing:` lines are hard flags. */
      complianceWarnings: string[]
      hardFairHousingFlag: boolean
      /** listing_marketing_content.id, or null when the save was refused (reported, not thrown). */
      contentId: string | null
      saveError?: string
    }
  | { success: false; error: string }

export async function generateListingDescriptions(
  svc: any,
  input: ListingDescriptionInput,
): Promise<ListingDescriptionResult> {
  const { brokerageId, agentId } = input
  if (!brokerageId) return { success: false, error: "Listing description refused: no brokerageId (the tenant must come from a session or the verified caller)" }
  if (!agentId) return { success: false, error: "Listing description refused: no agent profile — finish account setup." }

  // The agent must be the tenant's (a refused read is not "absent", §3).
  const { data: agentRow, error: agentErr } = await svc
    .from("agents").select("id, user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (agentErr) return { success: false, error: `Listing description: agent read refused: ${agentErr.message}` }
  if (!agentRow) return { success: false, error: "Listing description refused: that agent is not in this brokerage" }

  // The agent's own brand voice row, tenant-pinned. A refusal degrades to "no
  // voice" (logged) — the compliance blocks below still carry the cascade.
  const { data: brandVoice, error: bvErr } = await svc
    .from("brand_voice_profile")
    .select("tone, style")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (bvErr) console.error("[listing-description] brand_voice_profile read refused:", bvErr.message)

  // COMPLIANCE-FIRST — the rules are an INPUT to the writer, not only a grade.
  const complianceBlocks = await buildComplianceSystemBlocks(brokerageId, undefined, svc)

  const { object: descriptions } = await generateObjectRouted({
    feature: "listing_description",
    brokerageId, agentId, userId: input.userId ?? null,
    schema: LISTING_DESCRIPTIONS_SCHEMA,
    system: [
      "You are a real estate copywriter writing listing copy for a licensed brokerage.",
      ...complianceBlocks,
    ].filter(Boolean).join("\n\n"),
    prompt: `Generate multiple descriptions for this listing.

Property Details:
${JSON.stringify(input.propertyData, null, 2)}

Target Audience: ${input.style}
Highlights: ${input.highlights?.join(", ") || "None specified"}
Neighborhood: ${input.neighborhood || "Not specified"}
${brandVoice ? `Brand Voice: ${brandVoice.tone ?? ""}, ${brandVoice.style ?? ""}` : ""}

IMPORTANT RULES:
- MLS description must be factual, no "best" or "amazing"
- Include Fair Housing compliant language — describe the property, never the people
- Marketing can be more persuasive
- Social should be engaging with relevant hashtags
- All content must be original`,
  })

  // COMPLIANCE-FIRST, BOTH HALVES — the kernel grade of the MLS copy (the same
  // postcheck every script writer runs), on the service client with THIS tenant.
  // A `FairHousing:` line is a hard flag: the caller must not put that copy in
  // front of a consumer. An UNKNOWN line (gate could not run) is reported too.
  const actorUserId = (input.userId ?? (agentRow.user_id as string | null) ?? "") as string
  const complianceWarnings =
    (await postcheckScript({ userId: actorUserId, brokerageId }, descriptions.mlsDescription, "seller", { client: svc })) ?? []
  const hardFairHousingFlag = complianceWarnings.some((w) => w.startsWith("FairHousing:"))

  // The regulated channel's grade. A throw is a guard FAILURE, reported as one —
  // never read as "clean".
  const guard = await guardContent({
    content: descriptions.mlsDescription,
    agentId,
    brokerageId,
    contentType: "listing_description",
    // Brand voice through 86C's tenant door on THIS service client and verified
    // tenant (lane 86F2) — it read as anon from the cron before.
    client: svc,
    actorUserId: actorUserId || undefined,
  }).catch((err) => {
    console.error("[listing-description] guardContent threw — treating as guard failure:", err)
    return { flagged: false, guardFailed: true, violations: [] as string[], notes: [] as string[], content: "", brandVoiceChecked: false, approvalItemId: null }
  })

  // listing_id only for a listing inside THIS tenant; unknown or foreign stays null.
  let scopedListingId: string | null = null
  const candidate = input.listingId ?? (typeof input.propertyData?.id === "string" ? (input.propertyData.id as string) : null)
  if (candidate && isValidUUID(candidate)) {
    const { data: owned, error: ownedError } = await svc
      .from("listings").select("id").eq("id", candidate).eq("brokerage_id", brokerageId).maybeSingle()
    if (ownedError) console.error("[listing-description] listing ownership read refused:", ownedError.message)
    if (owned) scopedListingId = candidate
  }

  // listing_marketing_content is listing/brokerage-scoped (no agent_id/status
  // columns) — the audience folds into the content blob. Counted: the id comes
  // back or the refusal is returned.
  const { data: saved, error: saveErr } = await svc
    .from("listing_marketing_content")
    .insert({
      brokerage_id: brokerageId,
      listing_id: scopedListingId,
      content_type: "ai_descriptions",
      content: { ...descriptions, target_audience: input.style },
    })
    .select("id")
    .maybeSingle()
  if (saveErr) console.error("[listing-description] listing_marketing_content insert refused:", saveErr.message)
  const contentId = (saved?.id as string | undefined) ?? null

  // approval_items.item_id — a no-op when nothing was flagged or nothing saved.
  await attachApprovalSubject((guard as { approvalItemId?: string | null }).approvalItemId, contentId)

  return {
    success: true,
    descriptions,
    guardResult: {
      flagged: guard.flagged,
      violations: guard.violations,
      notes: guard.notes,
      ...((guard as { guardFailed?: boolean }).guardFailed ? { guardFailed: true } : {}),
    },
    complianceWarnings,
    hardFairHousingFlag,
    contentId,
    ...(saveErr ? { saveError: saveErr.message } : {}),
  }
}
