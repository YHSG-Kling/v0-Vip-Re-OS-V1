"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { listLeadMagnets, createLeadMagnet, publishLeadMagnet, getMagnetPerformance, cloneLeadMagnet, defaultFieldsForType, leadMagnetBookRefOf, type LeadMagnetField } from "@/lib/kernel/lead-magnets"
import { FORM_DECLARABLE_CONTACT_TYPES } from "@/lib/lead-magnets/form-contact-types"
import { headers } from "next/headers"

/**
 * ─── TOMBSTONE (wave 14) — the /api/lead-magnets HTTP twins ──────────────────
 * Three unreferenced route files duplicated the actions below and were retired
 * here. All three were session-auth'd (`supabase.auth.getUser()`) and had zero
 * callers in the tree, no cron entry in vercel.json, and no self-call.
 *
 *   app/api/lead-magnets/create/route.ts             POST → createLeadMagnetAction()   :98
 *   app/api/lead-magnets/[magnetId]/publish/route.ts POST → publishLeadMagnetAction()  :166
 *   app/api/lead-magnets/performance/route.ts        GET  → getMagnetPerformanceAction() :254
 *
 * Every one of them took `brokerageId` (and create also `agentId`) FROM THE
 * REQUEST BODY and handed it straight to a service-client kernel command — the
 * IDOR shape CLAUDE.md §4 names. None of that is ported: the survivors resolve
 * tenant from the session, which is the whole reason they are the survivors.
 *
 * What WAS merged onto the survivors before the routes went — three real gaps:
 *   1. ACTOR ID CLASS. The routes passed `user.id` (users.id) as createdBy /
 *      actorUserId; these actions passed `ctx.agentId` (agents.id).
 *      lifecycle_events.actor_user_id is `FOREIGN KEY … REFERENCES users(id)`
 *      (verified live), and agents.id / users.id are DISJOINT (CLAUDE.md §3), so
 *      the kernel's audit insert was being refused with 23503 on every create and
 *      every publish — and the kernel does not read that insert's error, so the
 *      refusal was silent. Both now pass ctx.userId.
 *   2. PUBLISH CHANNELS. publishLeadMagnetAction hard-coded
 *      `channels: ["landing_page"]`, which made the kernel's `qr_code` branch
 *      unreachable from the product. The route accepted the channel list; it is
 *      now an optional argument, defaulting to the old behaviour.
 *   3. PUBLISH BASE URL. This action used `process.env.NEXT_PUBLIC_APP_URL ?? ""`,
 *      and the kernel refuses an empty baseUrl — so on any deploy without that
 *      env var, publish failed with "Missing required fields". The route derived
 *      the origin from the request host/x-forwarded-proto, which always resolves.
 *      That derivation is ported (env still wins when set).
 *   4. PERFORMANCE. getMagnetPerformanceAction returned RAW `form_submissions`
 *      rows and let the UI invent the metrics from them — PerformanceDashboard
 *      was setting totalViews = submissions.length and conversionRate = 1. The
 *      route called lib/kernel/lead-magnets.ts:getMagnetPerformance, which counts
 *      views and QR scans off lifecycle_events for real. The action now delegates
 *      to it and returns `performance` alongside the submissions it already
 *      returned, so its existing caller keeps working.
 *
 * NOT retired: app/api/lead-magnets/submissions/route.ts. Its own header says
 * "Auth: NOT required — public-facing endpoint for form submitters", which is the
 * unreferenced-by-design shape CLAUDE.md §1 warns about: an embedded or hosted
 * capture form living outside this repo would address it directly, and nothing in
 * the tree can prove one does not. UNRESOLVED — left in place. (Also not retired:
 * app/api/lead-magnets/qr/[magnetId]/route.ts, same public-QR reasoning.)
 */

/** Roles whose Lead Magnets view is the whole brokerage rather than just their own.
 *  TRUE ADMIN GATE (operational: marketing — the owner ruling's team_lead-included
 *  tier) — repointed to the ONE tenant roster via isAdminOrBroker below.
 *  'superadmin' was dead: 0 live rows store that users.user_type. Mirrored by
 *  BROKERAGE_WIDE_ROLES in app/dashboard/marketing/lead-magnets/page.tsx. */
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * Scope is resolved HERE, from the session — never from a client-supplied id.
 *
 * It used to take `agentId` from the caller, and every caller passed the AUTH
 * USER id. lead_capture_forms.agent_id is a FK to agents(id), not users(id), so
 * the filter matched nothing and the library rendered "0 lead magnets" for
 * every user in the product. Resolving from getAgentContext() (whose .agentId
 * IS agents.id) both fixes it and removes the parameter that made the mistake
 * possible — a client cannot ask to see another agent's magnets.
 *
 * Broker/admin/superadmin get the brokerage-wide list; everyone else gets their
 * own. Fail-closed: a session with no agents row sees nothing rather than the
 * unfiltered brokerage.
 */
export async function listLeadMagnetsAction(options?: { scope?: "mine" | "brokerage" }) {
  try {
    const ctx = await getAgentContext()
    const bId = ctx.brokerageId
    if (!bId) return { success: false as const, error: "Not authenticated" }

    const wantsBrokerageWide =
      options?.scope !== "mine" && isAdminOrBroker({ user_type: ctx.role })

    if (wantsBrokerageWide) {
      return listLeadMagnets({ brokerageId: bId })
    }
    if (!ctx.agentId) {
      return { success: false as const, error: "No agent profile for this user — complete onboarding to use lead magnets." }
    }
    return listLeadMagnets({ brokerageId: bId, agentId: ctx.agentId })
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to list magnets" }
  }
}

export async function createLeadMagnetAction(input: {
  name: string
  magnet_type: string
  description?: string
  thank_you_message?: string
  tcpa_text?: string
  notify_on_submission?: boolean
  /** Wave 141: the tenant's OWN questions, ADDED to the type's canonical fields (never replacing them). */
  extra_fields?: Array<{ label: string; type?: string; required?: boolean; options?: string[] }>
  /** Wave 141: the builder creates a DRAFT (publish is its next step); "live" keeps the old one-shot create. */
  publish_state?: "draft" | "live"
  /** AI landing copy generated in the builder, persisted WITH the row (one write, not a second save). */
  landing?: import("@/lib/marketing/lead-magnet-copy").LandingContent | null
  /** Wave 142 (the Forms Manager merge): who fills a CUSTOM form — buyer / seller / both — so the kernel
   *  stamps the contact type and the welcome / manager handoff fire (FORM_DECLARABLE_CONTACT_TYPES). */
  default_contact_type?: string | null
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    const magnetType = input.magnet_type as Parameters<typeof createLeadMagnet>[0]["magnetType"]
    const declaredContactType = (FORM_DECLARABLE_CONTACT_TYPES as readonly string[]).includes(String(input.default_contact_type ?? "")) ? String(input.default_contact_type) : null
    // The tenant's extra questions ride on top of the canonical identity fields — the same validator the
    // AI draft uses (lib/lead-magnets/ai-draft.ts mergeExtraQuestions), so a typed field and an
    // AI-proposed one obey one rule.
    let fields: LeadMagnetField[] | undefined
    if (Array.isArray(input.extra_fields) && input.extra_fields.length > 0) {
      const { mergeExtraQuestions } = await import("@/lib/lead-magnets/ai-draft")
      fields = mergeExtraQuestions(defaultFieldsForType(magnetType), input.extra_fields)
    }
    const result = await createLeadMagnet({
      title: input.name,
      magnetType,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      // ABSORBED from the retired /api/lead-magnets/create route: createdBy lands
      // in lifecycle_events.actor_user_id, which FKs users(id). ctx.agentId is
      // agents.id — a disjoint class — so the audit insert was refused (23503) and
      // the kernel never reads that insert's error. users.id is the correct class.
      createdBy: ctx.userId,
      description: input.description ?? "",
      thankYouMessage: input.thank_you_message,
      tcpaDisclosureText: input.tcpa_text,
      fields,
      publishState: input.publish_state ?? "live",
      landingContent: input.landing ?? null,
      settings: {
        authoring: { by: "human", requested_by: ctx.userId, generated_at: new Date().toISOString(), from_ai_copy: !!input.landing },
        ...(declaredContactType ? { default_contact_type: declaredContactType } : {}),
      },
    })
    // Persist the notification preference into the dedicated `settings` jsonb bag
    // (added in l40-s01) — NOT landing_content, which the AI-landing-copy save
    // overwrites. Non-fatal: the magnet exists regardless of whether it persists.
    // Wave 141: MERGED onto the bag the kernel just wrote (lifecycle / authoring) — a bare
    // `{ settings: { notify_on_submission } }` would have clobbered the draft record.
    if (result.success && result.magnetId && input.notify_on_submission !== undefined) {
      const supabase = createServiceClient()
      const { data: cur, error: curErr } = await supabase
        .from("lead_capture_forms")
        .select("settings")
        .eq("id", result.magnetId)
        .eq("brokerage_id", ctx.brokerageId)
        .maybeSingle()
      if (curErr) console.warn("[lead-magnets] settings read refused before notify save:", curErr.message)
      const { notify_on_submission: _prior, ...rest } = (((cur as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>)
      const { error: notifyError } = await supabase
        .from("lead_capture_forms")
        .update({ settings: { notify_on_submission: input.notify_on_submission, ...rest } })
        .eq("brokerage_id", ctx.brokerageId)
        .eq("id", result.magnetId)
      if (notifyError) console.warn("[lead-magnets] notify preference not saved:", notifyError.message)
    }
    return result
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to create magnet" }
  }
}

/**
 * AI CREATES THE ACTUAL DRAFT (wave 141, lane 141E). Concept → a real lead_capture_forms row in DRAFT
 * (lib/lead-magnets/ai-draft.ts draftLeadMagnetFromConcept): entitlement first (mayUseAndAfford
 * "ai.generate"), the routed model lane (feature lead_magnet_draft, booked under this tenant), the
 * Fair-Housing scan, the kernel's create. The human previews / edits it on the Lead Magnets page and
 * publishes — publishLeadMagnetAction is the approval. Tenant + actor from the session.
 */
export async function draftLeadMagnetWithAiAction(input: { concept: string; magnet_type?: string | null; area?: string | null; brand?: string | null; audience?: string | null }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    const { draftLeadMagnetFromConcept } = await import("@/lib/lead-magnets/ai-draft")
    const VALID = ["home_valuation", "buyer_guide", "seller_guide", "market_report", "listing_alert", "open_house", "generic_form"] as const
    const magnetType = (VALID as readonly string[]).includes(String(input.magnet_type)) ? (input.magnet_type as (typeof VALID)[number]) : null
    const r = await draftLeadMagnetFromConcept({
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId,
      createdBy: ctx.userId,
      concept: input.concept,
      magnetType,
      area: input.area ?? null,
      brand: input.brand ?? null,
      audience: input.audience ?? null,
      actor: { userType: ctx.role ?? null },
    })
    if (!r.success) return { success: false as const, error: r.error ?? "The draft was not created." }
    return { success: true as const, magnetId: r.magnetId!, slug: r.slug!, magnetType: r.magnetType!, fromAi: !!r.fromAi, fallbackReason: r.fallbackReason ?? null, fairHousingFlags: r.fairHousing?.flagged ?? [] }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to draft with AI" }
  }
}

/** CLONE an existing magnet (same tenant) into a new DRAFT with provenance (wave 141). */
export async function cloneLeadMagnetAction(sourceMagnetId: string, title?: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    const r = await cloneLeadMagnet({ sourceMagnetId, brokerageId: ctx.brokerageId, agentId: ctx.agentId, createdBy: ctx.userId, title })
    if (!r.success || !r.magnetId) return { success: false as const, error: r.error ?? "Clone failed" }
    return { success: true as const, magnetId: r.magnetId, slug: r.slug!, clonedFromId: r.clonedFromId ?? sourceMagnetId }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to clone magnet" }
  }
}

/** The editable record for the draft review (wave 141): tenant-scoped read of one magnet. */
export async function getLeadMagnetDraftAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from("lead_capture_forms")
      .select("id, name, slug, magnet_type, fields, is_active, thank_you_message, tcpa_disclosure_text, redirect_url, landing_content, settings")
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (error) return { success: false as const, error: error.message }
    if (!data) return { success: false as const, error: "Magnet not found" }
    const row = data as { id: string; name: string; slug: string; magnet_type: string | null; fields: LeadMagnetField[] | null; is_active: boolean | null; thank_you_message: string | null; tcpa_disclosure_text: string | null; redirect_url: string | null; landing_content: Record<string, unknown> | null; settings: Record<string, unknown> | null }
    const settings = (row.settings ?? {}) as Record<string, unknown>
    const lifecycle = (settings.lifecycle ?? null) as { state?: string; published_at?: string | null; approved_by?: string | null } | null
    const authoring = (settings.authoring ?? null) as { by?: string; fallback_reason?: string | null; fair_housing_flags?: string[]; concept?: string; kind?: string; fair_housing?: { rewrites?: number; escalated?: boolean; findings?: Array<{ phrase: string; fix: string }> } } | null
    const provenance = (settings.provenance ?? null) as { cloned_from_id?: string; cloned_from_name?: string } | null
    const book = (settings.book ?? null) as { stage?: string } | null
    return {
      success: true as const,
      magnet: {
        id: row.id, name: row.name, slug: row.slug, magnetType: row.magnet_type ?? "generic_form",
        // Wave 142: the declared persona (Forms Manager merge), the fair-housing escalation, the book stage.
        defaultContactType: (FORM_DECLARABLE_CONTACT_TYPES as readonly string[]).includes(String(settings.default_contact_type ?? "")) ? String(settings.default_contact_type) : "",
        fairHousing: { rewrites: authoring?.fair_housing?.rewrites ?? 0, escalated: authoring?.fair_housing?.escalated === true, findings: authoring?.fair_housing?.findings ?? [] },
        bookStage: book && typeof book === "object" && typeof book.stage === "string" ? book.stage : null,
        fields: Array.isArray(row.fields) ? row.fields : [],
        isActive: row.is_active === true,
        lifecycleState: (lifecycle?.state === "draft" ? "draft" : "published") as "draft" | "published",
        publishedAt: lifecycle?.published_at ?? null,
        approvedBy: lifecycle?.approved_by ?? null,
        thankYouMessage: row.thank_you_message ?? "",
        tcpaDisclosureText: row.tcpa_disclosure_text ?? "",
        redirectUrl: row.redirect_url ?? "",
        landing: (row.landing_content ?? null) as import("@/lib/marketing/lead-magnet-copy").LandingContent | null,
        authoredBy: authoring?.by === "ai" ? "ai" as const : "human" as const,
        authoringNote: authoring?.fallback_reason ?? null,
        fairHousingFlags: Array.isArray(authoring?.fair_housing_flags) ? authoring!.fair_housing_flags! : [],
        concept: authoring?.concept ?? null,
        clonedFromId: provenance?.cloned_from_id ?? null,
        clonedFromName: provenance?.cloned_from_name ?? null,
      },
    }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to load magnet" }
  }
}

/**
 * PROACTIVE IDEAS (wave 141): the tenant's own evidence → deterministic suggestions, each also recorded
 * on the manager-signal bus (deduped per idea key). Tenant from the session; nothing is created —
 * "Draft this with AI" is the human's next click.
 */
export async function suggestLeadMagnetIdeasAction() {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const { runLeadMagnetSuggestions } = await import("@/lib/lead-magnets/suggestions")
    const r = await runLeadMagnetSuggestions(createServiceClient(), ctx.brokerageId, { publish: true })
    if (!r.ok) return { success: false as const, error: r.error ?? "Suggestions unavailable" }
    return { success: true as const, suggestions: r.suggestions, published: r.published, deduped: r.deduped }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to suggest ideas" }
  }
}

/**
 * Persist the AI-generated landing copy + GEO FAQ + JSON-LD onto a lead magnet so the public
 * /lm/[slug] page can render it for AI-search visibility. Brokerage-scoped (a user can only write
 * to their own brokerage's magnet). Marketing copy only — separate from the kernel-owned portal view.
 */
export async function saveMagnetLandingContentAction(
  magnetId: string,
  landing: import("@/lib/marketing/lead-magnet-copy").LandingContent,
) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("lead_capture_forms")
      .update({ landing_content: landing })
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to save landing content" }
  }
}

// Delegates to kernel publishLeadMagnet which reads/writes lead_capture_forms
export async function publishLeadMagnetAction(
  magnetId: string,
  // ABSORBED from the retired /api/lead-magnets/[magnetId]/publish route, which
  // took the channel list from its body. Hard-coding ["landing_page"] here made
  // the kernel's `qr_code` branch unreachable from the product. Default keeps the
  // previous behaviour for the existing caller (MagnetBuilder).
  channels: Array<"qr_code" | "email" | "landing_page" | "social"> = ["landing_page"],
) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    if (!channels?.length) return { success: false as const, error: "At least one channel required" }
    const published = await publishLeadMagnet({
      magnetId,
      brokerageId: ctx.brokerageId,
      channels,
      // ABSORBED: actor_user_id FKs users(id) — see createLeadMagnetAction above.
      actorUserId: ctx.userId,
      // ABSORBED: the retired route derived the origin from the request headers.
      // `process.env.NEXT_PUBLIC_APP_URL ?? ""` alone meant that on any deploy
      // without that env var the kernel refused with "Missing required fields:
      // … baseUrl" — a publish that fails for a reason no user can act on.
      baseUrl: process.env.NEXT_PUBLIC_APP_URL || (await requestOrigin()),
    })
    // OMNIPRESENCE (wave 142, lane 142E; owner: "any lead attraction systems should include the omnipresence
    // philosophy"): a magnet approved for social / email is PROPOSED as one omnipresence_topic_fanout action
    // (lib/agents/marketing-agent-actions.ts — newsletter + blog + social through each channel's own staging
    // and gates) on the marketing-actions approval surface. Proposed, never auto-sent: the human who approved
    // the page approves its distribution with one more click. Best-effort; the publish already landed.
    const fanoutChannels = [...(channels.includes("social") ? ["social", "blog"] : []), ...(channels.includes("email") ? ["newsletter"] : [])]
    if (published.success && fanoutChannels.length > 0) {
      try {
        const { recordProposedActions } = await import("@/lib/agents/marketing-agent-actions")
        await recordProposedActions({
          brokerageId: ctx.brokerageId,
          managedAgentSessionId: null,
          actions: [{
            action_type: "omnipresence_topic_fanout",
            action_input: { lead_magnet_id: magnetId, channels: fanoutChannels },
            rationale: `The lead magnet was approved and published with ${channels.join(", ")} — fan its page out across ${fanoutChannels.join(", ")} so every channel points at the capture page.`,
          }],
        })
      } catch (e) {
        console.warn("[lead-magnets] omnipresence proposal not recorded:", (e as Error)?.message ?? String(e))
      }
    }
    return published
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to publish" }
  }
}

// ── THE BOOK (wave 142, lane 142E) — lib/lead-magnets/book-creator.ts on the booklet / PDF / delivery survivors ──

/** Concept + audience → a DRAFT lead magnet carrying a NEW book project (stage research). Tenant + actor from the session. */
export async function startBookProjectAction(input: { concept: string; audience: "buyer" | "seller"; area?: string | null; brand?: string | null }) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.agentId) return { success: false as const, error: "Not authenticated" }
    const { startBookProject } = await import("@/lib/lead-magnets/book-creator")
    const r = await startBookProject({ brokerageId: ctx.brokerageId, agentId: ctx.agentId, createdBy: ctx.userId, concept: input.concept, audience: input.audience, area: input.area ?? null, brand: input.brand ?? null, actor: { userType: ctx.role ?? null } })
    if (!r.success || !r.magnetId) return { success: false as const, error: r.error ?? "The book project was not created." }
    return { success: true as const, magnetId: r.magnetId, slug: r.slug ?? "", title: r.title ?? "" }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to start the book" }
  }
}

/** Run the book's NEXT stage (research → outline → chapters → fact check → edit → layout → ready). The review surface auto-continues until done. */
export async function advanceBookProjectAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const { advanceBookProject } = await import("@/lib/lead-magnets/book-creator")
    const r = await advanceBookProject({ brokerageId: ctx.brokerageId, magnetId, actorUserId: ctx.userId, actor: { userType: ctx.role ?? null } })
    if (!r.success) return { success: false as const, stage: r.stage ?? null, error: r.error ?? "The stage did not land." }
    return { success: true as const, stage: r.stage!, done: !!r.done, note: r.note ?? "", book: bookSummaryOf(r.project ?? null) }
  } catch (err: any) {
    return { success: false as const, stage: null, error: err?.message ?? "Failed to advance the book" }
  }
}

/** The book project on a magnet (tenant-scoped read) — what the review surface renders. */
export async function getBookProjectAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { data, error } = await supabase.from("lead_capture_forms").select("id, settings").eq("id", magnetId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (error) return { success: false as const, error: error.message }
    if (!data) return { success: false as const, error: "Magnet not found" }
    const settings = ((data as { settings?: Record<string, unknown> | null }).settings ?? {}) as Record<string, unknown>
    const project = (settings.book ?? null) as import("@/lib/lead-magnets/book-creator").BookProject | null
    return { success: true as const, book: bookSummaryOf(project), ref: leadMagnetBookRefOf(settings) }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to load the book" }
  }
}

/** The reviewer's OWN rewrite of a chapter (an escalated one, or any): re-scanned for fair housing, saved, and a finished book goes back to layout for a fresh PDF. */
export async function reviseBookChapterAction(magnetId: string, chapter: number, body: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, stage: null, error: "Not authenticated" }
    const { reviseBookChapter } = await import("@/lib/lead-magnets/book-creator")
    const r = await reviseBookChapter({ brokerageId: ctx.brokerageId, magnetId, chapter, body, actorUserId: ctx.userId })
    if (!r.success) return { success: false as const, stage: r.stage ?? null, error: r.error ?? "The revision was not saved." }
    return { success: true as const, stage: r.stage!, done: !!r.done, note: r.note ?? "", book: bookSummaryOf(r.project ?? null) }
  } catch (err: any) {
    return { success: false as const, stage: null, error: err?.message ?? "Failed to revise the chapter" }
  }
}

// ── THE KDP PACKAGE (wave 143, lane 143F) — lib/lead-magnets/book-publishing-produce.ts ──
// KDP has no publishing API: the platform builds + evidences the package; a person uploads it in their own KDP account.

type KdpSummary = {
  title: string; subtitle: string | null; builtAt: string; words: number; coverArt: "image_rail" | "typographic_only"
  keywords: string[]; categorySuggestions: string[]; descriptionHtml: string
  aiDisclosure: { text: string; images: string; explanation: string }
  attestations: Array<{ id: string; text: string }>
  paperback: { estimatedPages: number; insideMarginIn: number | null; blockers: string[] }
  warnings: string[]; approval: { by: string; at: string } | null
}

function kdpSummaryOf(r: import("@/lib/lead-magnets/book-publishing-produce").KdpPackageRecord): KdpSummary {
  return {
    title: r.metadata.title, subtitle: r.metadata.subtitle, builtAt: r.built_at, words: r.words, coverArt: r.cover_art,
    keywords: r.metadata.keywords, categorySuggestions: r.metadata.categorySuggestions, descriptionHtml: r.metadata.descriptionHtml,
    aiDisclosure: { text: r.rights.aiDisclosure.text, images: r.rights.aiDisclosure.images, explanation: r.rights.aiDisclosure.explanation },
    attestations: r.rights.attestations.map((a) => ({ id: a.id, text: a.text })),
    paperback: { estimatedPages: r.paperback.estimatedPages, insideMarginIn: r.paperback.insideMarginIn, blockers: r.paperback.blockers },
    warnings: r.warnings, approval: r.approval ? { by: r.approval.by, at: r.approval.at } : null,
  }
}

/** The recorded KDP package of a book (tenant-pinned), or null when none was built. */
export async function getKdpPackageAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { data, error } = await supabase.from("lead_capture_forms").select("settings").eq("id", magnetId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    if (error) return { success: false as const, error: error.message }
    if (!data) return { success: false as const, error: "Magnet not found" }
    const { kdpPackageOf } = await import("@/lib/lead-magnets/book-publishing-produce")
    const pkg = kdpPackageOf((data as { settings?: Record<string, unknown> | null }).settings ?? null)
    return { success: true as const, kdp: pkg ? kdpSummaryOf(pkg) : null }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to load the KDP package" }
  }
}

/** Build (or rebuild) the KDP package of a FINISHED book. Names every blocker it refuses on. */
export async function buildKdpPackageAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false as const, error: "Not authenticated" }
    const supabase = createServiceClient()
    const { data } = await supabase.from("lead_capture_forms").select("slug").eq("id", magnetId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
    const origin = process.env.NEXT_PUBLIC_APP_URL || (await requestOrigin())
    const slug = (data as { slug?: string | null } | null)?.slug
    const { buildKdpPackage } = await import("@/lib/lead-magnets/book-publishing-produce")
    const r = await buildKdpPackage({ brokerageId: ctx.brokerageId, magnetId, actorUserId: ctx.userId, landingUrl: origin && slug ? `${origin}/lm/${slug}` : null })
    if (!r.ok) {
      const b = r.blockers
      return {
        success: false as const, error: r.error,
        blockers: b ? [
          ...(b.claims ?? []).map((c) => `${c.where}: "${c.phrase}" — ${c.rule}`),
          ...(b.fairHousing ?? []).map((f) => `fair housing: ${f}`),
          ...(b.metadata ?? []).map((m) => `${m.field}: ${m.problem}`),
          ...(b.cover ?? []).map((c) => `cover: ${c}`),
        ] : [],
      }
    }
    return { success: true as const, kdp: kdpSummaryOf(r.record) }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to build the KDP package" }
  }
}

/** The human's approval of the package: every attestation, by id. The session user is recorded as the approver. */
export async function approveKdpPackageAction(magnetId: string, attested: string[]) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId || !ctx.userId) return { success: false as const, error: "Not authenticated" }
    if (!Array.isArray(attested)) return { success: false as const, error: "Attestations required" }
    const { approveKdpPackage } = await import("@/lib/lead-magnets/book-publishing-produce")
    const r = await approveKdpPackage({ brokerageId: ctx.brokerageId, magnetId, actorUserId: ctx.userId, attested: attested.filter((x) => typeof x === "string") })
    return r.ok ? { success: true as const, kdp: kdpSummaryOf(r.record) } : { success: false as const, error: r.error }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to approve the KDP package" }
  }
}

/** Fresh signed links for the EPUB and cover (the bucket is private). */
export async function getKdpDownloadsAction(magnetId: string) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    const { kdpPackageDownloads } = await import("@/lib/lead-magnets/book-publishing-produce")
    const r = await kdpPackageDownloads({ brokerageId: ctx.brokerageId, magnetId })
    return r.ok ? { success: true as const, epubUrl: r.epubUrl, coverUrl: r.coverUrl } : { success: false as const, error: r.error }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to link the KDP files" }
  }
}

/** The review surface's view of a project — never the whole manuscript on every poll (an ESCALATED chapter carries its body, so the human can rewrite it). Not exported ("use server"). */
function bookSummaryOf(p: import("@/lib/lead-magnets/book-creator").BookProject | null) {
  if (!p) return null
  return {
    stage: p.stage, title: p.title, subtitle: p.subtitle, tagline: p.tagline, audience: p.audience,
    outline: (p.outline ?? []).map((o) => o.heading),
    chapters: p.chapters.map((c, i) => ({ n: i + 1, heading: c.heading, words: c.words, edited: !!c.edited, escalated: !!c.edited?.escalated, findings: c.edited?.findings ?? [], preview: c.body.slice(0, 280), body: c.edited?.escalated ? c.body : null })),
    factFindings: p.fact_check?.findings.length ?? 0,
    needsHumanReview: p.needs_human_review ?? [],
    pdfUrl: p.pdf_url, documentId: p.document_id, pageCount: p.page_count,
    cost: p.cost, log: p.log.slice(-8), updatedAt: p.updated_at,
  }
}

/** Same-origin base url from the incoming request — ABSORBED from the retired
 *  publish route. Not exported: this file is "use server", where every export is
 *  a public HTTP endpoint (CLAUDE.md §4). */
async function requestOrigin(): Promise<string> {
  try {
    const h = await headers()
    const host = h.get("host") ?? ""
    if (!host) return ""
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")
    return `${proto}://${host}`
  } catch {
    return ""
  }
}

// Writes to lead_capture_forms (canonical table used by kernel)
export async function updateMagnetSettingsAction(magnetId: string, settings: Record<string, unknown>, isActive?: boolean) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Map known setting keys to REAL lead_capture_forms columns — there is no `settings` column, so the
    // old `{ settings }` write silently errored (every settings update failed). isActive may arrive as
    // the 3rd arg OR inside the settings bag (the MagnetLibrary toggle passes { isActive }).
    const s = (settings ?? {}) as Record<string, unknown>
    const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof s.name === "string") updatePayload.name = s.name
    if (typeof s.thankYouMessage === "string") updatePayload.thank_you_message = s.thankYouMessage
    if (typeof s.redirectUrl === "string") updatePayload.redirect_url = s.redirectUrl
    if (typeof s.tcpaDisclosureText === "string") updatePayload.tcpa_disclosure_text = s.tcpaDisclosureText
    // Merged from the deleted kernel command updateMagnetSettings (lib/kernel/lead-magnets.ts):
    // the capture-form FIELD LIST is a legitimate setting too.
    if (Array.isArray(s.fields)) updatePayload.fields = s.fields
    const active = isActive !== undefined ? isActive : (typeof s.isActive === "boolean" ? s.isActive : undefined)
    if (active !== undefined) updatePayload.is_active = active
    // Wave 142 (the Forms Manager merge): the declared persona lives in the settings bag — MERGED onto what the
    // row holds (lifecycle / authoring / book), never a clobbering write; "" clears it.
    if (typeof s.defaultContactType === "string") {
      const { data: cur, error: curErr } = await supabase.from("lead_capture_forms").select("settings").eq("id", magnetId).eq("brokerage_id", ctx.brokerageId).maybeSingle()
      if (curErr) return { success: false as const, error: `settings unreadable: ${curErr.message}` }
      const { default_contact_type: _prior, ...rest } = (((cur as { settings?: Record<string, unknown> | null } | null)?.settings ?? {}) as Record<string, unknown>)
      const v = s.defaultContactType.trim().toLowerCase()
      updatePayload.settings = (FORM_DECLARABLE_CONTACT_TYPES as readonly string[]).includes(v) ? { ...rest, default_contact_type: v } : rest
    }
    if (Object.keys(updatePayload).length === 1) return { success: false as const, error: "No recognized settings to update" }
    const { error } = await supabase
      .from("lead_capture_forms")
      .update(updatePayload)
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }
    // Audit trail (merged from the kernel command): who changed which settings.
    // Best-effort — the settings write above already succeeded.
    const kernelEmit = await import("@/lib/kernel/emit")
    const { error: auditError } = kernelEmit.asWriteResult(await kernelEmit.emitKernelEvent({
      entityType: "lead_capture_form",
      entityId: magnetId,
      event: "lead_magnet_updated",
      actorUserId: ctx.userId ?? null,
      brokerageId: ctx.brokerageId,
      metadata: { updatedFields: Object.keys(updatePayload).filter((k) => k !== "updated_at") },
    }))
    if (auditError) console.warn("[lead-magnets] settings updated but audit event refused:", auditError.message)
    return { success: true as const }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to update settings" }
  }
}

export async function getMagnetPerformanceAction(magnetId: string) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Verify the form belongs to this brokerage before reading submissions
    const { data: form } = await supabase
      .from("lead_capture_forms")
      .select("id")
      .eq("id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (!form) return { success: false as const, error: "Magnet not found" }
    const { data, error } = await supabase
      .from("form_submissions")
      .select("*")
      .eq("form_id", magnetId)
      .eq("brokerage_id", ctx.brokerageId)
    if (error) return { success: false as const, error: error.message }

    // ABSORBED from the retired /api/lead-magnets/performance route: the real
    // metrics. This action used to return raw submission rows only, and
    // PerformanceDashboard then INVENTED the rest of the panel from them —
    // totalViews = submissions.length, conversionRate = 1 whenever a single
    // submission existed, totalQrScans = 0 always. The kernel command counts
    // lead_magnet_view and lead_magnet_qr_scan off lifecycle_events, so the
    // numbers are the ledger's rather than the component's.
    const perf = await getMagnetPerformance({ magnetId, brokerageId: ctx.brokerageId })

    return {
      success: true as const,
      submissions: data ?? [],
      total: data?.length ?? 0,
      performance: perf.success ? perf.performance : undefined,
    }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to get performance" }
  }
}

/**
 * generateQRCodeAction — the session gate in front of the ONE lead-magnet QR minter.
 *
 * MERGED-THEN-DELETED: this action's own `qr_codes` insert is gone. It was the third of three
 * lead-magnet minters, each with a different dedupe key — this one had NO dedupe at all and a
 * random slug, so every click of "Generate Tracked QR Code" minted another code and the magnet's
 * scans split across them. The write now goes through lib/kernel/lead-magnets.ts:generateQRCode →
 * lib/marketing/tracked-qr.ts:mintTrackedQr, deduped on `lead_magnet:<magnetId>`.
 *
 * WHAT THIS PATH CONTRIBUTED AND KEPT (merged onto the survivor before it died):
 *   • purpose 'lead_magnet' — every reader of a lead-magnet QR filters on it; writing "general"
 *     meant a freshly generated QR was never found again (the tab kept offering "Generate", the
 *     library never showed a scan count).
 *   • destination_type 'landing_page' — neither of the other two set it.
 *   • the agents.id stamp: qr_codes.agent_id FKs agents(id); ctx.agentId is that PK, and a users
 *     id in that column is a refused insert.
 *
 * It also now returns the rendered PNG so the UI stops fetching it from api.qrserver.com.
 *
 * THE FOURTH DOOR IS GONE TOO (wave H5). `POST /api/lead-magnets/qr/[magnetId]`
 * reached the SAME generateQRCode with the same four arguments, but took
 * `brokerageId` and `agentId` from the REQUEST BODY and handed them to the
 * service-client minter behind nothing but "some user is signed in" — the
 * body-supplied-tenant IDOR shape CLAUDE.md §4 names. It is deleted; the
 * tombstone with the full reasoning is at
 * app/api/lead-magnets/qr/[magnetId]/route.ts. THIS action is the survivor: the
 * tenant comes from getAgentContext() and the magnet is re-read scoped by
 * brokerage_id before anything is minted.
 */
export async function generateQRCodeAction(input: { magnetId: string; url: string }) {
  try {
    const supabase = createServiceClient()
    const ctx = await getAgentContext()
    if (!ctx.brokerageId) return { success: false as const, error: "Not authenticated" }
    // Verify the form belongs to this brokerage before creating a QR code for it.
    // GATE-THEN-SERVICE: the minter writes with the service client, so this check is the only gate.
    const { data: form, error: formError } = await supabase
      .from("lead_capture_forms")
      .select("id")
      .eq("id", input.magnetId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (formError) return { success: false as const, error: formError.message }
    if (!form) return { success: false as const, error: "Magnet not found" }

    const { generateQRCode } = await import("@/lib/kernel/lead-magnets")
    const result = await generateQRCode({
      magnetId: input.magnetId,
      brokerageId: ctx.brokerageId,
      agentId: ctx.agentId ?? null,
      label: `Lead Magnet QR: ${input.magnetId}`,
      targetUrl: input.url,
    })
    if (!result.success) return { success: false as const, error: result.error ?? "Failed to generate QR" }

    return {
      success: true as const,
      qrCode: {
        id: result.qrCodeId!,
        slug: result.slug!,
        target_url: result.targetUrl!,
        scan_url: result.scanUrl!,
        image_url: result.qrImageUrl!,
      },
    }
  } catch (err: any) {
    return { success: false as const, error: err?.message ?? "Failed to generate QR" }
  }
}

// Re-exports are illegal in "use server" files — wrap instead.
import { captureFormSubmissionAction as _captureFormSubmission } from "./lead-magnet-capture"
export async function captureFormSubmissionAction(...args: Parameters<typeof _captureFormSubmission>) {
  return _captureFormSubmission(...args)
}
