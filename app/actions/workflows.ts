"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import {
  buildComplianceSystemBlocks,
  precheckBriefForFairHousing,
  postcheckScript,
  detectFairHousingRedFlags,
  detectProhibitedPhraseRedFlags,
} from "@/lib/video/script-compliance"

/**
 * SECURITY: every entry point that mutates per-tenant data verifies the
 * target row (contact/listing/transaction/campaign/etc.) belongs to the
 * authenticated brokerage BEFORE performing any write. Caller-supplied
 * brokerage_id / user_id values are never trusted — they are always derived
 * from getAgentContext().
 */

// Helper: assert a row from `table` with `id` belongs to `brokerageId`.
// Returns the row when valid; returns null on missing/forbidden so the caller
// can short-circuit. Uses the service client so RLS doesn't mask the check.
async function assertOwnership(
  table: string,
  id: string,
  brokerageId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient()
  const { data } = await svc.from(table).select("brokerage_id").eq("id", id).maybeSingle()
  if (!data) return { ok: false, error: `${table} not found` }
  if (data.brokerage_id !== brokerageId) return { ok: false, error: "Forbidden" }
  return { ok: true }
}

/**
 * Execute AI-powered tool for workflow automation.
 * Routes to appropriate handler based on tool name.
 */
export async function executeAITool(toolName: string, inputData: any, context: any) {
  try {
    // Route to appropriate AI tool handler.
    //
    // THE CONTENT-STUDIO DOORS (2026-08-28). The studio's three buttons call
    // executeWorkflow("publish-content" | "send-newsletter" | "send-direct-mail"),
    // names this table did not know — every press resolved
    // { success: false, error: "Unknown tool" } and the UI dutifully reported
    // it (the buttons were honest about doing nothing). Each name now routes
    // to the CANONICAL implementation rather than growing a twin (§1):
    // newsletter sends through ai-newsletter.ts:sendNewsletter (feature-gated,
    // subscriber-resolved, ownership-verified), direct mail through
    // direct-mail.ts:sendCampaign (feature-gated, provider-resolved) with the
    // actor derived from the SESSION — never from inputData (§4) — and the
    // omni-channel content push books a campaign_calendar row through
    // content-studio.ts:scheduleContent ('publish' is in the calendar's
    // event_type CHECK); the channel sends themselves keep their own doors.
    const handlers: Record<string, Function> = {
      // "fair-housing-check" routes to the CANONICAL scanner (§1): the local
      // regex twin `checkFairHousingCompliance` was deleted 2026-08-28 (lane
      // E2) — see the tombstone below. The old direct entry was also
      // arity-broken: handler(inputData, context) landed inputData in the
      // twin's ignored _userId slot and scanned `undefined`.
      "fair-housing-check": async (input: any) => {
        const text =
          typeof input?.content === "string" && input.content.trim() ? input.content.trim()
          : typeof input?.text === "string" && input.text.trim() ? input.text.trim()
          : ""
        if (!text) return { success: false, error: "No content to scan" }
        const { scanContentCompliance } = await import("./compliance-monitoring")
        try {
          const scan = await scanContentCompliance({
            contentBody: text,
            contentType: typeof input?.contentType === "string" && input.contentType ? input.contentType : "marketing",
            targetAudience: typeof input?.targetAudience === "string" && input.targetAudience ? input.targetAudience : "general",
            distributionChannels: Array.isArray(input?.channels) ? input.channels : [],
            agentState: typeof input?.agentState === "string" ? input.agentState : "",
          })
          return { success: true, scan }
        } catch (e: any) {
          // Fail CLOSED and say so — an unscanned "pass" is the one answer a
          // compliance door must never give (§4 fail-closed).
          return { success: false, error: e?.message ?? "Compliance scan failed" }
        }
      },
      "generate-plan": generateCopilotPlan,
      "send-message": sendMessage,
      // "calculate-metrics" removed with its handler `calculateListingMetrics`
      // (deleted 2026-08-28, lane E2 — see tombstone below; the live listing
      // metric engine is lib/listing-health/health-scorer.ts). Nothing in the
      // tree ever dispatched the name.
      "publish-content": async (input: any) => {
        const channel = typeof input?.channel === "string" && input.channel.trim() ? input.channel.trim() : null
        if (!channel) return { success: false, error: "No channel named" }
        const text = typeof input?.content === "string" ? input.content.trim() : ""
        if (!text) return { success: false, error: "No content to publish" }
        try {
          const { scheduleContent } = await import("./content-studio")
          const row = await scheduleContent({
            title: text.length > 180 ? `${text.slice(0, 177)}…` : text,
            contentType: "publish",
            scheduledDate: new Date().toISOString(),
            platform: channel,
            notes: input?.contentId ? `content-studio push (content ${input.contentId})` : "content-studio push",
          })
          // scheduleContent THROWS on a refused insert and returns the row
          // otherwise; a null row would mean the insert was silently empty.
          if (!row) return { success: false, error: "Calendar write returned no row" }
          return { success: true, calendarId: (row as { id?: string }).id }
        } catch (e: any) {
          return { success: false, error: e?.message ?? "Failed to schedule the publish" }
        }
      },
      "send-newsletter": async (input: any) => {
        if (typeof input?.campaignId !== "string" || !input.campaignId) {
          return { success: false, error: "No newsletter campaign id" }
        }
        const { sendNewsletter } = await import("./ai-newsletter")
        return sendNewsletter({ newsletterId: input.campaignId })
      },
      "send-direct-mail": async (input: any) => {
        if (typeof input?.campaignId !== "string" || !input.campaignId) {
          return { success: false, error: "No direct-mail campaign id" }
        }
        const ctx = await getAgentContext()
        if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
          return { success: false, error: "Not authenticated" }
        }
        const { sendCampaign } = await import("./direct-mail")
        return sendCampaign({
          campaignId: input.campaignId,
          actorUserId: ctx.userId,
          brokerageId: ctx.brokerageId,
        })
      },
    }

    const handler = handlers[toolName]
    if (!handler) {
      return { success: false, error: `Unknown tool: ${toolName}` }
    }

    return await handler(inputData, context)
  } catch (error: any) {
    console.error("[executeAITool] Error:", error)
    return { success: false, error: error?.message ?? "Tool execution failed" }
  }
}

// TOMBSTONE (§1 keep-one + §6 one-vocabulary, lane E2 2026-08-28) —
// `checkFairHousingCompliance` deleted. SURVIVOR:
// app/actions/compliance-monitoring.ts:scanContentCompliance →
// lib/application/compliance-monitoring.ts:scanContentComplianceService (the
// DB-driven prohibited-phrase + AI scanner, wired at
// app/components/compliance/FairHousingScanner.tsx and
// app/components/shared/compliance/submit-content-form.tsx). The dispatcher
// name "fair-housing-check" in executeAITool above now routes to that
// survivor through a correctly-shaped adapter; the old entry passed
// (inputData, context) into this function's (userId, contentType, text)
// signature and scanned `undefined`. Nothing merged: the survivor's phrase
// vocabulary lives in the database (compliance_phrases), where §5's
// compliance-first ruling keeps it maintained, and its violations land in the
// canonical compliance ledger rather than this twin's activities rows.

/**
 * Generate a 7-day copilot plan for a contact.
 */
export async function generateCopilotPlan(
  contactId: string,
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; plan?: any; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // Get contact info
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, contact_type, buyer_stage, status, last_contacted_at")
      .eq("id", contactId)
      .maybeSingle()

    if (!contact) return { success: false, error: "Contact not found" }

    // Generate plan via AI — use resolveModel so the Vercel AI Gateway handles routing.
    // Never import provider SDKs directly; they require separate API keys.
    const { generateObject } = await import("@/lib/ai/generate")
    const { resolveModel } = await import("@/lib/ai/resolve-model")
    const { z } = await import("zod")

    const { object: plan } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        plan_name: z.string(),
        next_action: z.string(),
        next_action_date: z.string(),
        steps: z.array(
          z.object({
            day: z.number(),
            action: z.string(),
            channel: z.enum(["email", "sms", "call", "task", "portal"]),
          })
        ),
      }),
      prompt: `Create a 7-day follow-up plan for a contact.

Contact: ${contact.first_name} ${contact.last_name}
Type: ${contact.contact_type ?? "unknown"}
Stage: ${contact.buyer_stage ?? contact.status ?? "new"}
Last contacted: ${contact.last_contacted_at ? new Date(contact.last_contacted_at).toLocaleDateString() : "never"}

Generate a specific 7-day plan with daily actions.`,
    })

    // Archive existing plan
    await supabase
      .from("copilot_plans")
      .update({ status: "superseded", updated_at: new Date().toISOString() })
      .eq("contact_id", contactId)
      .eq("status", "active")

    // Insert new plan
    const { data: newPlan } = await supabase
      .from("copilot_plans")
      .insert({
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        plan_name: plan.plan_name,
        next_action: plan.next_action,
        next_action_date: plan.next_action_date,
        status: "active",
        plan_data: plan.steps,
      })
      .select()
      .single()

    return { success: true, plan: newPlan }
  } catch (error: any) {
    console.error("[generateCopilotPlan] Error:", error)
    return { success: false, error: error?.message ?? "Failed to generate plan" }
  }
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `startSmartDrip` deleted.
// SURVIVOR: app/actions/ai-lead-nurturing.ts:aiGenerateDripCampaign (wired at
// app/dashboard/campaigns/sequences/ai-sequence-drafter-card.tsx), whose
// drip_campaigns rows carry the step plan the queue-drain cron
// (app/api/cron/queue-drain) actually executes. This twin inserted a BARE
// status:'active' row with no steps/metadata — a drip the drain could never
// send anything for — and a stripped-source census found zero callers outside
// the app/actions/index.ts barrel, which itself has zero importers.

/**
 * Send a message to a contact.
 */
export async function sendMessage(
  contactId: string,
  message: string,
  channel: string,
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify contact ownership
    const own = await assertOwnership("contacts", contactId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // messages.conversation_id is NOT NULL — resolve or create the thread via
    // the ONE canonical helper (keep-one; this file had the original inline copy).
    const { ensureConversationForContact } = await import("@/lib/kernel/conversation-thread")
    const conversationId = await ensureConversationForContact(supabase, { contactId, brokerageId, agentId })
    if (!conversationId) return { success: false, error: "Could not resolve conversation" }

    const { data: msg } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        contact_id: contactId,
        agent_id: agentId,
        brokerage_id: brokerageId,
        type: channel,        // real column for the medium (email/sms/in_app)
        direction: "outbound",
        body: message,        // real column (was phantom "content")
        status: "sent",
      })
      .select()
      .single()

    return { success: true, messageId: msg?.id }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to send message" }
  }
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `calculateListingMetrics`
// deleted, and its "calculate-metrics" dispatcher entry in executeAITool
// removed (nothing ever dispatched the name). SURVIVOR:
// lib/listing-health/health-scorer.ts:calculateListingHealth — the live
// listing metric engine (wired at app/actions/listing-health-actions.ts and
// the app/api/cron/listing-health-scan sweep). This twin computed
// price-per-sqft plus two hardcoded placeholders (dom_percentile: null,
// market_position: "neutral") and returned them without persisting anything.
// Nothing merged.

/**
 * Trigger CMA package generation.
 */
export async function triggerCMAPackage(
  propertyId: string,
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; packageId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    // Verify property/listing ownership (CMA packages target listings)
    const own = await assertOwnership("listings", propertyId, brokerageId)
    if (!own.ok) return { success: false, error: own.error }

    // NOTE: cma_reports is the canonical CMA content table (read across the app).
    // The old cma_packages insert here created a status:'generating' row that was
    // never updated or read anywhere — dead write removed (keep-one sweep).

    return { success: true }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to trigger CMA" }
  }
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `grantPortalAccess` deleted.
// SURVIVOR: app/actions/portal-invites.ts:createPortalInviteForContact (wired
// at app/crm/page.tsx:36) — the thing that actually GRANTS portal access by
// minting the contact's invite. This twin granted nothing: it wrote a
// portal_access_logs row that merely CLAIMED access was active, which is a log
// entry impersonating a grant. A stripped-source census found zero callers
// outside the app/actions/index.ts barrel, which itself has zero importers.
// Nothing merged.

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `triggerComplianceChecklist`
// deleted. SURVIVOR: app/actions/ai-transaction-documents.ts:
// checkTransactionDisclosures (wired at
// app/dashboard/transactions/[id]/transaction-detail-client.tsx:1101), which
// upserts the SAME compliance_checklists row on the same
// (transaction_id, checklist_type) arbiter and, unlike this ensure-exists
// twin, actually populates items and compliance_score. Sibling writer:
// app/actions/ai-document-intelligence.ts:aiCheckDisclosures. This third
// writer contributed only an empty shell row; a stripped-source census found
// zero callers outside the app/actions/index.ts barrel, which itself has zero
// importers. Nothing merged.

/**
 * Which journey a marketing script is graded against by the compliance gate.
 * Seller-side subjects (a listing, a homeowner, a farm, a sale) grade as
 * "seller"; everything else speaks to a buyer — the same split
 * app/actions/video-generation.ts draws from its purpose keys.
 */
function scriptJourneyType(scriptType: string): "buyer" | "seller" {
  return /sell|listing|sold|farm|expired|fsbo|homeowner/i.test(scriptType) ? "seller" : "buyer"
}

/**
 * The compliance grade + THE single `scripts` INSERT, fused so no path can
 * reach the write without passing the gate (§5). Both doors below —
 * generateScriptContent (model-written text) and savePrivateScript
 * (agent-written text) — store through here and nowhere else, which is what
 * keeps `scripts` on ONE writer path (§1; lib/video/viral-script-share.ts is
 * an UPDATE-only promoter, not a second writer).
 *
 * THE HARD LINE (owner's §5 ruling): advisory findings pass through — they are
 * returned for the surface to show, and the store proceeds. A HARD fair-housing
 * red flag (deterministic protected-class/steering hit) or a phrase the
 * brokerage graded BLOCKING refuses the store. The red-flag set is re-derived
 * the way lib/video/script-compliance.ts:assessScriptCompliance builds it —
 * detectFairHousingRedFlags is pure/synchronous (so a DB outage can never make
 * a protected-class hit read as clean), and the blocking phrase findings are
 * recovered from postcheckScript's flat list by their contract prefix.
 *
 * Store notes (m429):
 *   · title is NOT NULL; scriptType→category (no CHECK — free vocabulary);
 *     the status CHECK is draft|approved|archived and is the EDITORIAL
 *     lifecycle.
 *   · brokerage_id — the session tenant, never a caller-supplied one. An
 *     untenanted script is a PLATFORM-catalogue script under m429, which the
 *     SELECT policy publishes to every brokerage on the OS; the CHECK
 *     constraint and the INSERT policy both refuse it from a non-platform
 *     author, and this is the writer half of that.
 *   · visibility 'private' — an agent's script starts as their own work.
 *     lib/video/viral-script-share.ts is the ONLY thing that promotes it to
 *     'brokerage', and only when a video rendered from it crosses
 *     VIRAL_VIEW_THRESHOLD.
 *   · `error` IS DESTRUCTURED, AND THAT IS NOT NEGOTIABLE. supabase-js
 *     RESOLVES a refused write, so a bare `await …insert()` returns normally
 *     for a row that was never created. Until m429 the INSERT policy was
 *     `is_platform_admin()` with no per-author clause, so this write was
 *     refused for every ordinary agent — which is why the table held zero
 *     rows. The policy is fixed; the honesty stays.
 */
async function gateAndStorePrivateScript(params: {
  actor: { userId: string; brokerageId: string; teamId?: string }
  title: string
  category: string
  content: string
  journeyType: "buyer" | "seller"
}): Promise<{
  scriptId?: string
  storeError?: string
  /** Advisory + UNKNOWN lines for the surface to show. Never blocking. */
  complianceWarnings?: string[]
  /** Non-empty means the store was REFUSED. */
  redFlags: string[]
}> {
  const { actor, content, journeyType } = params

  const complianceWarnings = await postcheckScript(actor, content, journeyType)

  const redFlags = [
    ...detectFairHousingRedFlags(content, journeyType),
    ...detectProhibitedPhraseRedFlags(complianceWarnings ?? []),
  ]
  if (redFlags.length > 0) {
    return { redFlags, complianceWarnings }
  }

  const supabase = await createClient()
  const { data: stored, error: storeError } = await supabase
    .from("scripts")
    .insert({
      title: params.title,
      category: params.category,
      content,
      status: "draft",
      created_by: actor.userId,
      brokerage_id: actor.brokerageId,
      visibility: "private",
    })
    .select("id")
    .single()

  if (storeError) return { redFlags: [], complianceWarnings, storeError: storeError.message }
  if (!stored?.id) return { redFlags: [], complianceWarnings, storeError: "the scripts write returned no row" }
  return { redFlags: [], complianceWarnings, scriptId: stored.id as string }
}

/**
 * Generate marketing script content and save it as the caller's PRIVATE script.
 *
 * WIRE STATE (updated 2026-08-28, lane E1 — supersedes the lane CD note that
 * recorded `scripts` as reader-only): the agent-authored script lane
 * (m429: private → viral promotion to brokerage via
 * lib/video/viral-script-share.ts, read back by the video-create saved-scripts
 * picker, #186) now has a LIVE door. video-create-client.tsx imports
 * savePrivateScript (below) — "Save as my private script", beside the curated
 * save-to-library button — and both that action and this one store through
 * gateAndStorePrivateScript above, the file's single `scripts` INSERT. This
 * function's own generate-and-store composite is exported here and through the
 * app/actions/index.ts barrel and has no runtime importer of its own yet —
 * executeAITool's routing table carries no "generate-script" name because no
 * workflow definition sends one; add the adapter only when a caller exists.
 * NOT a duplicate of the curated video lane
 * (app/actions/video/generate-script.ts + saveVideoScript →
 * video_scripts_library): that is a different table with an approval queue.
 *
 * THE COMPLIANCE GATE (§5, sixth generator on
 * scripts/video-script-compliance-guard.ts's roster): the caller-supplied
 * context is PRE-checked for fair housing before any tokens are spent, the
 * shared compliance blocks (brand voice, ThemFirst, Fair Housing, the
 * brokerage's prohibited words) ride IN the writing prompt, and the generated
 * script is post-checked — advisory warnings pass through in
 * complianceWarnings, a hard red flag refuses the store (see
 * gateAndStorePrivateScript).
 */
export async function generateScriptContent(
  scriptType: string,
  context: any,
  _agentId?: string // ignored — derived from session
): Promise<{
  success: boolean
  content?: string
  scriptId?: string
  complianceWarnings?: string[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    const agentId = ctx.agentId

    const actor = { userId: ctx.userId, brokerageId, teamId: ctx.teamId ?? undefined }
    const journeyType = scriptJourneyType(scriptType)

    // The context is the only caller-authored prose here — scriptType is a
    // vocabulary key. Pre-check it BEFORE the model runs (§5: a protected-class
    // brief is refused, not laundered into cleaner-sounding copy).
    const contextProse = typeof context === "string" ? context : context ? JSON.stringify(context) : ""
    if (contextProse?.trim()) {
      const preCheck = await precheckBriefForFairHousing(actor, contextProse, journeyType)
      if (preCheck.blocked) {
        return {
          success: false,
          error: `Script context contains a Fair Housing violation: ${preCheck.reason}`,
        }
      }
    }

    // ON THE GATEWAY. This used to construct an `@ai-sdk/anthropic` client
    // directly — `anthropic("claude-sonnet-4-20250514")` — which reached the
    // provider on ANTHROPIC_API_KEY, off the gateway's key/bill/egress, and
    // skipped the routing table, the fair-use pre-flight, the Data Guard
    // redaction and the ai_tool_usage cost ledger that every other generation
    // on this platform goes through. generateTextRouted resolves
    // "marketing_script_generation" → claude-sonnet → the SAME model
    // (anthropic/claude-sonnet-4-20250514, MODEL_CONFIG in lib/ai/models.ts),
    // so the output is unchanged and the accounting now exists.
    const { generateTextRouted } = await import("@/lib/ai/models")

    // Brand voice + ThemFirst + Fair Housing + the brokerage's own prohibited
    // words, injected proactively — the rules are an INPUT to the writing, not
    // only a grade on what came out (§5).
    const complianceBlocks = await buildComplianceSystemBlocks(brokerageId)

    const { text: script } = await generateTextRouted({
      prompt: `Generate a ${scriptType} script for a real estate agent. Context: ${JSON.stringify(context)}`,
      system: complianceBlocks.length ? complianceBlocks.join("\n\n") : undefined,
      feature: "marketing_script_generation",
      userId: ctx.userId,
      brokerageId,
      agentId: agentId ?? undefined,
    })

    const gated = await gateAndStorePrivateScript({
      actor,
      title: `${scriptType} script`,
      category: scriptType,
      content: script,
      journeyType,
    })

    if (gated.redFlags.length > 0) {
      // The store is REFUSED, and the caller is told exactly why. The text is
      // still returned so the agent can see what was flagged and fix it — but
      // success is false, so no automation can mistake this for a saved script.
      return {
        success: false,
        content: script,
        complianceWarnings: gated.complianceWarnings,
        error: `Not saved — hard compliance flag: ${gated.redFlags[0]}`,
      }
    }
    if (gated.storeError) {
      // A refused store still returns the generated text (it is the useful
      // output) WITH the error saying it was not saved — never a silent success.
      console.error("[workflows] script generated but NOT stored:", gated.storeError)
      return {
        success: true,
        content: script,
        complianceWarnings: gated.complianceWarnings,
        error: `Script generated but not saved: ${gated.storeError}`,
      }
    }

    return {
      success: true,
      content: script,
      scriptId: gated.scriptId,
      complianceWarnings: gated.complianceWarnings,
    }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to generate script" }
  }
}

/**
 * Save agent-written script text as the caller's own PRIVATE script (m429
 * lane): `public.scripts`, visibility 'private', tenant from the SESSION (§4).
 * The door for this is the "Save as my private script" button beside the
 * curated save-to-library button in
 * app/dashboard/videos/create/video-create-client.tsx — private is the honest
 * verb for the text the agent already has (regenerating would discard their
 * edits), so this stores the CURRENT working text through the same fused
 * gate+store as generateScriptContent rather than duplicating the writer.
 *
 * The content is a FINISHED script, not a brief headed for a model, so it is
 * POST-checked (postcheckScript inside gateAndStorePrivateScript) rather than
 * pre-checked — no `if (x?.trim())` prose gate here by design; that marker is
 * for caller prose entering a writing prompt
 * (scripts/video-script-compliance-guard.ts unprecheckedProseGates). Advisory
 * findings come back in complianceWarnings and the store proceeds; a hard
 * fair-housing red flag or a phrase the brokerage graded blocking refuses it.
 */
export async function savePrivateScript(params: {
  title: string
  /** Vocabulary key (e.g. a video_scripts_library script_type) — not prose. */
  scriptType: string
  content: string
}): Promise<{
  success: boolean
  scriptId?: string
  complianceWarnings?: string[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    if (!params.content?.trim()) return { success: false, error: "There is no script text to save" }

    const gated = await gateAndStorePrivateScript({
      actor: { userId: ctx.userId, brokerageId: ctx.brokerageId, teamId: ctx.teamId ?? undefined },
      title: params.title?.trim() || `${params.scriptType} script`,
      category: params.scriptType,
      content: params.content,
      journeyType: scriptJourneyType(params.scriptType),
    })

    if (gated.redFlags.length > 0) {
      return {
        success: false,
        complianceWarnings: gated.complianceWarnings,
        error: `Not saved — hard compliance flag: ${gated.redFlags[0]}`,
      }
    }
    if (gated.storeError) {
      // Storing IS the whole job here, so a refused write is a failure — not a
      // success with a footnote.
      return {
        success: false,
        complianceWarnings: gated.complianceWarnings,
        error: `Script not saved: ${gated.storeError}`,
      }
    }

    return { success: true, scriptId: gated.scriptId, complianceWarnings: gated.complianceWarnings }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to save script" }
  }
}

/**
 * Retry a failed workflow execution.
 */
export async function retryFailedWorkflow(
  workflowId: string,
  _agentId?: string // ignored — derived from session
): Promise<{ success: boolean; retryId?: string; error?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }
    const brokerageId = ctx.brokerageId
    void supabase

    // The retired Engine A's workflow_executions retry table is gone. A "failed
    // workflow" is now an automation_errors row (the automations console). Verify
    // ownership, then RESOLVE the error — the retry acknowledges + clears it.
    // workflowId here is the automation_errors.id.
    const svc = createServiceClient()
    const { data: errRow } = await svc
      .from("automation_errors")
      .select("id, brokerage_id")
      .eq("id", workflowId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!errRow) {
      return { success: false, error: "Forbidden" }
    }

    const { error: updErr } = await svc
      .from("automation_errors")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: ctx.userId,
        resolution_notes: "Retried from the automations console",
      })
      .eq("id", workflowId)
    if (updErr) {
      return { success: false, error: updErr.message }
    }

    return { success: true, retryId: workflowId }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to retry workflow" }
  }
}

/**
 * Log user activity for audit trail.
 */
export async function logUserActivity(
  _userId: string | undefined, // ignored — derived from session
  activity: string,
  details: any = {}
): Promise<{ success: boolean; activityId?: string }> {
  try {
    const supabase = await createClient()
    const ctx = await getAgentContext()

    if (!ctx.isAuthenticated) return { success: true } // silently no-op for unauth

    const { data: log } = await supabase
      .from("audit_log")
      .insert({
        user_id: ctx.userId,
        action: activity,
        after: details ?? null, // canonical payload column (no brokerage_id/details columns)
      })
      .select()
      .single()

    return { success: true, activityId: log?.id }
  } catch (error: any) {
    console.error("[logUserActivity] Error:", error)
    return { success: true } // Don't fail user action if logging fails
  }
}

export async function executeWorkflow(workflowId: string, contextData: Record<string, unknown> = {}) {
  try {
    return await executeAITool(workflowId, contextData, {})
  } catch (error: any) {
    console.error("[executeWorkflow] Error:", error)
    return { success: false, error: error?.message ?? "Workflow execution failed" }
  }
}
