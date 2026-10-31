"use server"

import { createHash } from "node:crypto"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { captureContact } from "@/lib/contact-pipeline/contact-capture"
import { gatewayChat } from "@/lib/ai/gateway-chat"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { VENDOR_CATEGORY_OTHER } from "@/lib/kernel/vendor-categories"
import { requireCallerWithAgent as requireCaller } from "@/lib/auth/require-caller"
import {
  CARD_FIELDS,
  CARD_FIELD_TO_CONTACT_COLUMN,
  assessCardExtraction,
  cardStampsForContact,
  classifyCardSubject,
  confidentCardFields,
  decideCardFieldWrite,
  humanConfirmedExtraction,
  isExistingTenantMember,
  parseCardExtraction,
  resolvePreScanChoice,
  unconfirmedCardNote,
  type CardExtraction,
  type CardField,
  type CardSubjectType,
  type PreScanChoice,
  type ScanEntity,
} from "@/lib/contacts/card-classifier"

// ─── THE PRE-SCAN CHOICE (wave 142, lane 142D) ──────────────────────────────────────────────
// Owner, verbatim (2026-10-18): "why is the business card being saved as a contactid? it depends on what
// type of person it is — user type they are vendor, contact or agent. before scanning, the user chooses
// which type and then scans. these types of mislabeling keeps happening." So the TYPE is chosen BEFORE
// the scan: `subjectType` is REQUIRED on uploadBusinessCard (fail closed — no silent auto-detect default),
// "auto" is an EXPLICIT pick that still HOLDS the scan until the human confirms the type, and the scan
// row carries which domain entity it became in TYPED columns (m789: vendor_id / recruit_id /
// routed_entity_type beside contact_id) — a card is "saved as a contactid" only when it IS a contact.
// SELECT TYPE → SCAN → EXTRACT → VERIFY → IDENTITY/DEDUP → CORRECT DOMAIN ENTITY → ENRICH → workflow.
// The vocabulary (PreScanChoice / ScanEntity / resolvePreScanChoice) is PURE and lives in
// lib/contacts/card-classifier.ts, shared with the review surface.

/** The sentence a caller that made no choice gets — the one place it is spelled. */
const PRE_SCAN_CHOICE_REQUIRED = "Choose who this card is for — a vendor, a contact, or a fellow agent — before scanning. (\"Not sure\" reads the card and asks you to confirm the type before anything is filed.)"

// Was trusting caller-supplied agentId + brokerageId. Caller could
// upload business cards attributed to any agent in any brokerage
// (creating fraudulent contacts + burning Claude Vision API budget).
// Now: identity resolved from session, agent_id verified to belong to
// caller's brokerage.
// TOMBSTONE: local requireCaller merged onto lib/auth/require-caller.ts:185
// requireCallerWithAgent (imported above as `requireCaller`) — §1/§6 SAME BODY
// census round 3, 2026-09-09.

// ─── THE VISION CALL'S ECONOMICS (wave 141F) ─────────────────────────────────
// ONE vision path — gatewayChat through the Vercel AI Gateway (owner: AI is ALL
// through the gateway; no second OCR system). It was the one gateway caller that
// booked NOTHING on ai_tool_usage: every card scan was an unmetered model call on
// a platform-covered ledger that feeds meter_readings.ai_tokens and the overage
// projection (CLAUDE.md §5 — a wrong number there is a wrong invoice; zero is a
// wrong number). The gateway's own `usage` is booked when it reports one; else an
// ESTIMATE, labelled as such on the row. mayUseAndAfford gates the call first.
const CARD_VISION_MODEL = "anthropic/claude-sonnet-4-20250514"
/** A typical phone photo of a card (≤ ~1.2 MP after the browser resizes) costs about this many
 *  image tokens on the Anthropic tokenizer (w × h / 750) — used ONLY when the gateway reports no usage. */
const CARD_IMAGE_TOKEN_ESTIMATE = 1600
const CARD_VISION_MAX_OUTPUT_TOKENS = 500
const CARD_VISION_PROMPT =
  "Read this business card. Return ONLY a JSON object whose keys are first_name,last_name,email,phone,company,title,address,website. " +
  "Each key's value is an object {\"value\": string, \"confidence\": number} where confidence is 0 to 1 — how sure you are the value is exactly what is printed " +
  "(lower it for glare, blur, handwriting, ambiguous characters such as 0/O, 1/l, rn/m). Use an empty string value when a field is not on the card. No other text."

type ScanResultShape = {
  scanId: string
  contactId: string | null
  vendorId: string | null
  recruitId: string | null
  /** Wave 142 (lane 142D): WHICH domain entity the scan became. TOMBSTONE for the pre-142 `target`
   *  ("contact" | "vendor" | "recruit") — a 3-way projection that reported "contact" for a sphere /
   *  unclassified card that produced NO contacts row, which is exactly the "saved as a contactid"
   *  reading the owner refused. A card that became nothing says `none`. */
  entity: ScanEntity
  /** Wave 143 (143D): set when the "agent" card is a colleague who already has a seat in THIS tenant — nothing was filed
   *  (entity `none`); the review surface can say "already on your team" instead of a bare "no record". */
  existingUserId?: string | null
  cardSubjectType: CardSubjectType
  subjectUserId: string | null
  viable: boolean
  /** Wave 141F — the reading is viable but an identity field is below the confidence floor:
   *  NOTHING was routed or written to a contact; the scan row waits (review_status 'pending')
   *  for confirmBusinessCardScan. Wave 142: ALSO true when the agent chose "auto" — the type itself
   *  must be confirmed before the card becomes a record. */
  needsConfirmation: boolean
  /** Wave 142: the hold is (at least) for the TYPE — the human picks vendor / contact / agent on confirm. */
  needsTypeConfirmation: boolean
  /** Wave 142: what the reader + notes SUGGEST the card is (never written as a record until confirmed). */
  suggestedSubjectType: CardSubjectType | null
  /** The reader's values (normalised) and per-field confidence, for the review surface. */
  extracted: Record<CardField, string>
  fieldConfidence: Record<CardField, number | null>
  lowFields: CardField[]
}

export async function uploadBusinessCard(params: {
  imageBase64: string
  mimeType: "image/jpeg" | "image/png" | "image/webp"
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
  /** Free-text notes the scanning agent types on the card review surface —
   *  priority-2 determination source (lib/contacts/card-classifier.ts). */
  notes?: string | null
  /** THE PRE-SCAN CHOICE (wave 142, owner 2026-10-18: "before scanning, the user chooses which type and
   *  then scans") — REQUIRED. A concrete CardSubjectType wins outright over the reader and the notes
   *  (owner ruling 2026-09-10); "auto" lets the reader + notes SUGGEST a type and HOLDS the scan until the
   *  human confirms it (nothing is filed on a suggestion). Absent → the scan is refused. */
  subjectType: PreScanChoice
  /** @deprecated pre-wave-48 3-way override, kept for source compatibility with
   *  any stale caller — mapped onto subjectType ('recruit' → 'agent') when
   *  `subjectType` itself is not passed. TOMBSTONE: the 3-way CardTarget this
   *  mirrored was merged onto CardSubjectType, lib/contacts/card-classifier.ts:38. */
  target?: "contact" | "vendor" | "recruit"
}): Promise<ScanResultShape> {
  const auth = await requireCaller()
  if (!auth.ok) throw new Error(auth.error)
  const brokerageId = auth.brokerageId
  // NOT `?? auth.userId` (m361) — business_card_scans.agent_id FKs agents.
  const agentId = auth.agentId
  if (!agentId) throw new Error("No agent profile for this user yet — finish account setup.")

  // FAIL CLOSED on the TYPE (wave 142): no choice, no scan — never a silent "auto-detect" default.
  const pick = resolvePreScanChoice(params.subjectType, params.target)
  if (!pick) throw new Error(PRE_SCAN_CHOICE_REQUIRED)

  const supabase = createServiceClient()
  const scanId = crypto.randomUUID()
  const now = new Date().toISOString()

  // 0) ENTITLEMENT BEFORE THE PAID CALL (fail closed): the tenant must be allowed
  //    to spend AI tokens and have budget for this scan.
  const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
  const estPromptTokens = CARD_IMAGE_TOKEN_ESTIMATE + Math.ceil(CARD_VISION_PROMPT.length / 4)
  const gate = await mayUseAndAfford({ brokerageId, capability: "ai.generate", estTokens: estPromptTokens + CARD_VISION_MAX_OUTPUT_TOKENS })
  if (!gate.allowed) {
    throw new Error(gate.message ?? `Business-card scanning is not available right now (${gate.reason}).`)
  }

  // 1) Upload image to Supabase storage
  const buffer = Buffer.from(params.imageBase64, "base64")
  const path = `${brokerageId}/${scanId}.jpg`
  await supabase.storage
    .from("business-cards")
    .upload(path, buffer, { contentType: params.mimeType, upsert: true })
  const { data: pub } = supabase.storage.from("business-cards").getPublicUrl(path)
  const raw_image_url = pub.publicUrl

  // 2) Call Claude Vision — JSON extraction only, PER-FIELD CONFIDENCE asked for.
  // Claude Vision OCR via the Vercel AI Gateway (image passed as a data URL).
  const startedAt = Date.now()
  const response = await gatewayChat({
    model: CARD_VISION_MODEL,
    maxTokens: CARD_VISION_MAX_OUTPUT_TOKENS,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${params.mimeType};base64,${params.imageBase64}` } },
          { type: "text", text: CARD_VISION_PROMPT },
        ],
      },
    ],
  })

  // 2b) BOOK THE COST — the gateway's count when it gave one, an estimate (and said so) otherwise.
  try {
    const { logAIUsage } = await import("@/lib/ai/cost-tracking")
    const outputText = response.content ?? ""
    const tokenBasis = response.usage ? "gateway_usage" : "estimated"
    await logAIUsage({
      userId: auth.userId,
      brokerageId,
      agentId,
      model: "claude-sonnet",
      inputTokens: response.usage?.inputTokens ?? estPromptTokens,
      outputTokens: response.usage?.outputTokens ?? Math.ceil(outputText.length / 4),
      feature: "business_card_vision",
      manager: "data_steward",
      executionTimeMs: Date.now() - startedAt,
      success: response.ok,
      contextExtra: { scan_id: scanId, token_basis: tokenBasis, image_token_estimate: response.usage ? null : CARD_IMAGE_TOKEN_ESTIMATE },
    })
  } catch (err) {
    console.error("[business-card] ai_tool_usage not booked:", err instanceof Error ? err.message : String(err))
  }

  let extraction: CardExtraction
  try {
    const text = response.content ?? "{}"
    const match = text.match(/\{[\s\S]*\}/)
    extraction = parseCardExtraction(JSON.parse(match ? match[0] : "{}"))
  } catch {
    extraction = parseCardExtraction({})
  }

  // 3) Confidence = the reader's own per-field confidence (mean over the fields it read) —
  //    no longer `filled fields / 8`, which was a completeness ratio wearing a confidence badge.
  const assessment = assessCardExtraction(extraction)
  const { viable } = assessment

  // 3b) THE TYPE (wave 142). An explicit choice is stored as the picker's verdict right on the scan row,
  //     so a scan held for a doubtful field is confirmed without asking the type twice. "auto" stores the
  //     reader + notes SUGGESTION (classifyCardSubject — reader fields, then notes, default UNKNOWN, never
  //     'contact') and HOLDS the scan: the type is confirmed by a human before anything is filed.
  const suggestion = pick.kind === "auto"
    ? classifyCardSubject({ title: extraction.fields.title || null, company: extraction.fields.company || null, notes: params.notes ?? null })
    : null
  const needsTypeConfirmation = pick.kind === "auto"
  const needsConfirmation = viable && (assessment.needsConfirmation || needsTypeConfirmation)
  const preScanClassification = pick.kind === "explicit"
    ? { card_subject_type: pick.type, classified_by: "picker" as const }
    : { card_subject_type: suggestion!.subjectType, classified_by: suggestion!.source }

  // 4) Always insert scan row (audit trail regardless of viability). A viable reading with a
  //    doubtful identity field — or a type still to confirm — waits as 'pending' (live CHECK: approved |
  //    pending | rejected): nothing is routed and no entity is written until a human confirms.
  const { data: scan, error: scanRowErr } = await supabase
    .from("business_card_scans")
    .insert({
      id: scanId,
      brokerage_id: brokerageId,
      agent_id: agentId,
      raw_image_url,
      extracted_data: { ...extraction.fields, field_confidence: extraction.confidence, needs_confirmation: needsConfirmation, needs_type_confirmation: needsTypeConfirmation },
      confidence_score: assessment.overall,
      review_status: !viable ? "rejected" : needsConfirmation ? "pending" : "approved",
      reviewed_by: null,
      reviewed_at: needsConfirmation ? null : now,
      ...preScanClassification,
      subject_notes: params.notes ?? null,
    })
    .select("id")
    .single()
  if (scanRowErr) console.error(`[business-card] scan audit row NOT recorded: ${scanRowErr.message}`)

  // BUSINESS_CARD_UPLOADED — was a direct lifecycle_events insert (audit-only,
  // no reactor fan-out: notification_rules' live business_card_uploaded row
  // never fired). Real moment: right after the scan row lands, tenant/entity
  // read off it. void/catch so a fan-out hiccup never fails the upload.
  void emitKernelEvent({
    event:       KernelEvent.BUSINESS_CARD_UPLOADED,
    brokerageId,
    entityType:  "business_card",
    entityId:    scan!.id,
    agentId,
    metadata:    { confidence: assessment.overall, viable, needs_confirmation: needsConfirmation, low_fields: assessment.lowFields },
  }).catch((err) => console.error("[businessCardUpload] BUSINESS_CARD_UPLOADED emit failed:", err))

  const base = {
    scanId: scan!.id,
    extracted: extraction.fields,
    fieldConfidence: extraction.confidence,
    lowFields: assessment.lowFields,
  }

  if (!viable) {
    // Notify agent of failed extraction
    const { data: agentRow } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", agentId)
      .single()

    if (agentRow?.user_id) {
      await sentinelWrite(supabase, supabase.from("notifications").insert({
        user_id: agentRow.user_id,
        brokerage_id: brokerageId,
        type: "business_card_scan",
        title: "Business card scan could not extract contact info",
        body: "Missing name or contact method. Try a clearer photo.",
        entity_type: "business_card",
        entity_id: scan!.id,
        priority: "low",
        channel: "in_app",
        is_read: false,
      }), { table: "notifications", flow: "business_card_actions_notify", brokerageId: brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    }

    return { ...base, contactId: null, vendorId: null, recruitId: null, entity: { kind: "none", id: null }, cardSubjectType: "unknown", subjectUserId: null, viable: false, needsConfirmation: false, needsTypeConfirmation: false, suggestedSubjectType: suggestion?.subjectType ?? null }
  }

  if (needsConfirmation) {
    // HUMAN CONFIRMATION WHERE CONFIDENCE IS LOW — or where the TYPE is still the human's to pick
    // (owner rulings): the reading is shown to the scanning agent on the review surface with the
    // doubtful fields marked; a bell is left in case they navigate away. confirmBusinessCardScan
    // routes it once a human has said so.
    const { data: agentRow } = await supabase.from("agents").select("user_id").eq("id", agentId).single()
    if (agentRow?.user_id) {
      const why = [
        assessment.lowFields.length ? `The reader was unsure about: ${assessment.lowFields.map((f) => f.replace(/_/g, " ")).join(", ")}.` : null,
        needsTypeConfirmation ? `You chose "not sure" — the reader suggests ${suggestion!.subjectType.replace(/_/g, " ")}; pick who this is (vendor, contact, or fellow agent).` : null,
      ].filter(Boolean).join(" ")
      await sentinelWrite(supabase, supabase.from("notifications").insert({
        user_id: agentRow.user_id,
        brokerage_id: brokerageId,
        type: "business_card_scan",
        title: "A scanned business card needs your confirmation",
        body: `${why} Confirm it on the Business Card Scanner page before it becomes a record.`,
        entity_type: "business_card",
        entity_id: scan!.id,
        priority: "low",
        channel: "in_app",
        is_read: false,
      }), { table: "notifications", flow: "business_card_actions_notify", brokerageId: brokerageId, reason: "in-app notification — a lost row is a missed bell, never the business write it follows" })
    }
    return { ...base, contactId: null, vendorId: null, recruitId: null, entity: { kind: "none", id: null }, cardSubjectType: suggestion?.subjectType ?? "unknown", subjectUserId: null, viable: true, needsConfirmation: true, needsTypeConfirmation, suggestedSubjectType: suggestion?.subjectType ?? null }
  }

  // An explicit choice, a confident reading: route now. (An "auto" scan never reaches here — it is held above.)
  return routeClassifiedCard({
    supabase, brokerageId, agentId, actorUserId: auth.userId, scanId: scan!.id, extraction,
    notes: params.notes ?? null, subjectTypePick: pick.kind === "explicit" ? pick.type : undefined, human: false, base,
  })
}

/**
 * THE ROUTING BODY — one for both doors (the confident auto path of uploadBusinessCard and the
 * human path of confirmBusinessCardScan). Module-private: a "use server" file's exports are
 * all public async endpoints, and this takes a service client.
 *
 * Structured columns (vendors / recruits / contacts) only ever receive readings at or above
 * the confidence floor (confidentCardFields — a human confirmation is 1.0 everywhere);
 * doubtful readings ride the notes as "unconfirmed" so nothing read is thrown away and
 * nothing doubtful becomes a record.
 */
async function routeClassifiedCard(args: {
  supabase: ReturnType<typeof createServiceClient>
  brokerageId: string
  agentId: string
  actorUserId: string | null
  scanId: string
  extraction: CardExtraction
  notes: string | null
  subjectTypePick?: CardSubjectType
  human: boolean
  base: Pick<ScanResultShape, "scanId" | "extracted" | "fieldConfidence" | "lowFields">
}): Promise<ScanResultShape> {
  const { supabase, brokerageId, agentId, scanId, extraction, base } = args
  const extracted = extraction.fields
  const confident = confidentCardFields(extraction)
  const unconfirmedNote = unconfirmedCardNote(extraction)
  const scanRef = { id: scanId }

  // 6) CLASSIFY the card's subject (owner ruling 2026-09-10 — never assume
  // 'contact'). Priority 1 (reader fields) and 2 (notes) are the PURE
  // classifier; priority 3 (an existing-user/contact/vendor match by
  // email/phone) is database-backed and lives here; an explicit picker on the
  // review surface (params.subjectType) always wins outright over all three.
  const { classifyCardSubject } = await import("@/lib/contacts/card-classifier")
  const detected = classifyCardSubject({
    title: extracted.title || null,
    company: extracted.company || null,
    notes: args.notes ?? null,
  })

  // (The pre-wave-48 3-way `target` is resolved into the pre-scan pick by uploadBusinessCard — wave 142.)

  // Priority 3 — an existing platform user / contact / vendor matched by
  // email or phone. The ONLY tier that can attach a real subject_user_id
  // (owner ruling: "should be a userid user type"), and it can upgrade an
  // otherwise-UNKNOWN card — never overrides a signal the reader or the
  // notes already gave. Matched on CONFIDENT readings only: a doubtful email
  // must not attach somebody else's seat to this card.
  let subjectUserId: string | null = null
  // The owner's own words: "should be a userid user type" — the card carries a
  // USER ID *and* USER TYPE. A matched `users` row is resolved with its real
  // user_type so the classification below is decided from that (vendor-typed
  // user → vendor, contact-typed user → contact) instead of assuming every
  // matched platform user is a fellow agent. Carried into the routing metadata
  // (processKernelEvent/lifecycle_events below) for the receiving manager.
  let subjectUserType: string | null = null
  let matchedContactId: string | null = null
  let matchedVendorId: string | null = null
  const cardEmail = (confident.email ?? "").trim().toLowerCase()
  const cardPhone = (confident.phone ?? "").trim()
  if (cardEmail || cardPhone) {
    // Wave 143 (lane 143D): the three identity lookups used `.maybeSingle()` and read only `data` — two rows sharing an email
    // (a contact duplicated before the merge ran) is a PGRST116 REFUSAL that resolved as "no match", so a card for a person
    // who already exists was filed as a stranger; a refused read looked the same (CLAUDE.md §3: supabase-js RESOLVES
    // refusals). `.limit(1)` takes the first of many, and the error is READ and said — the lookup is advisory (the type was
    // chosen before the scan), so a refused one degrades to "no match" LOUDLY instead of silently.
    const firstMatch = async <T,>(table: "users" | "contacts" | "vendors", columns: string): Promise<T | null> => {
      const q = supabase.from(table).select(columns).eq("brokerage_id", brokerageId)
      const { data, error } = await (cardEmail ? q.eq("email", cardEmail) : q.eq("phone", cardPhone)).limit(1)
      if (error) { console.error(`[businessCardUpload] ${table} identity lookup refused (treated as no match):`, error.code, error.message); return null }
      return ((data ?? [])[0] as T | undefined) ?? null
    }
    const matchedUser = await firstMatch<{ id: string; user_type: string | null }>("users", "id, user_type")
    if (matchedUser) {
      subjectUserId = matchedUser.id
      subjectUserType = matchedUser.user_type ?? null
    } else {
      const matchedContact = await firstMatch<{ id: string }>("contacts", "id")
      if (matchedContact) {
        matchedContactId = matchedContact.id
      } else {
        const matchedVendor = await firstMatch<{ id: string }>("vendors", "id")
        if (matchedVendor) matchedVendorId = matchedVendor.id
      }
    }
  }

  let cardSubjectType: CardSubjectType = detected.subjectType
  let classifiedBy: "picker" | "reader" | "notes" | "match" | "default" = detected.source
  if (cardSubjectType === "unknown") {
    if (subjectUserId) {
      // Decided from the REAL users.user_type (owner ruling 2026-09-10), not an
      // assumption that any matched platform user is a fellow agent — a
      // vendor-seated user (users.user_type='vendor', CLAUDE.md §4) or a
      // contact-seated portal user routes as such; every other seat (agent,
      // broker/broker_admin/broker_owner/team_lead/admin/compliance_officer,
      // isa/tc/support/system/superadmin) is the platform-staff/professional
      // bucket this tier has always meant by 'agent'.
      cardSubjectType = subjectUserType === "vendor" ? "vendor" : subjectUserType === "contact" ? "contact" : "agent"
      classifiedBy = "match"
    }
    else if (matchedVendorId) { cardSubjectType = "vendor"; classifiedBy = "match" }
    else if (matchedContactId) { cardSubjectType = "contact"; classifiedBy = "match" }
  }
  // Priority 4 — the explicit pick (pre-scan, or on confirm) wins outright.
  if (args.subjectTypePick) { cardSubjectType = args.subjectTypePick; classifiedBy = "picker" }

  const category = cardSubjectType === "vendor" ? (detected.category ?? VENDOR_CATEGORY_OTHER) : null
  const classificationColumns = {
    card_subject_type: cardSubjectType,
    subject_user_id: subjectUserId,
    subject_notes: args.notes ?? null,
    classified_by: classifiedBy,
  }
  const resultBase = { ...base, cardSubjectType, subjectUserId, viable: true, needsConfirmation: false, needsTypeConfirmation: false, suggestedSubjectType: null }

  if (cardSubjectType === "vendor") {
    const fullName = [confident.first_name, confident.last_name].filter(Boolean).join(" ").trim()
    // vendors.category/status CHECK vocabularies verified live; a scanned
    // vendor lands PENDING — the vendor verification rail vets it before use.
    const { data: vendor, error: vendorError } = await supabase.from("vendors").insert({
      brokerage_id: brokerageId,
      name: (confident.company ?? "").trim() || fullName || "Scanned vendor",
      category,
      email: confident.email ?? null,
      phone: confident.phone ?? null,
      website: confident.website ?? null,
      status: "pending",
      notes: [
        `Scanned from a business card.`,
        fullName ? `Contact person: ${fullName}${confident.title ? ` (${confident.title})` : ""}.` : null,
        confident.address ? `Address on card: ${confident.address}.` : null,
        unconfirmedNote || null,
      ].filter(Boolean).join(" "),
    }).select("id").single()
    if (vendorError || !vendor) throw new Error(`Vendor create failed: ${vendorError?.message ?? "no data"}`)

    // IDENTITY / DEDUP (wave 142): a vendor's card is a BUSINESS identity — the B2B2C crosswalk (the
    // business_identity capability) answers whether this person already exists in the tenant's contacts.
    const crosswalk = await crosswalkBusinessIdentity({ supabase, brokerageId, scanId: scanRef.id, actorUserId: args.actorUserId, agentId, confident, entityKind: "vendor" })

    // Classification rides the typed m617 columns (card_subject_type/
    // subject_user_id/subject_notes/classified_by); the ENTITY the scan became rides the typed m789
    // columns (vendor_id + routed_entity_type) — the jsonb routed_to/vendor_id keys stay one wave as
    // the backfill source and for older readers, never as the only truth.
    const { error: scanUpdateVendorError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, field_confidence: extraction.confidence, routed_to: "vendor", vendor_id: vendor.id, ...(crosswalk ? { identity_crosswalk: crosswalk } : {}) },
      ...classificationColumns,
      vendor_id: vendor.id,
      routed_entity_type: "vendor",
    }).eq("id", scanRef.id)
    if (scanUpdateVendorError) console.error("[businessCardUpload] scan classification update (vendor) failed:", scanUpdateVendorError)

    // Wave 102C (owner ruling: one emit where the row metadata is a SUPERSET the reactor reads by named
    // key). The 101C census kept this pair apart because the row stored `category ?? VENDOR_CATEGORY_OTHER`
    // and the payload the raw `category` — but in this branch `category` is ALREADY
    // `detected.category ?? VENDOR_CATEGORY_OTHER` (line ~240), so the two were the same value. One emit:
    // the row carries the whole routing payload (subject_user_type per the 2026-09-10 ruling — the
    // reactor forwards `metadata` as the manager-signal payload, the handler reads `scanId`).
    await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId: brokerageId,
      entityType: "vendor",
      entityId: vendor.id,
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scanRef.id, routed_to: "vendor", category, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy, human_confirmed: args.human },
      agentUserId: null,
    }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    return { ...resultBase, contactId: null, vendorId: vendor.id, recruitId: null, entity: { kind: "vendor", id: vendor.id } }
  }

  // Wave 143 (lane 143D) — BROKERAGE AFFILIATION: a card whose email / phone is ALREADY a user of THIS tenant in an internal seat
  // (agent, broker, team lead, admin, ISA, TC …) is a colleague, not a recruit. A recruits row is a prospect from OUTSIDE the
  // brokerage; filing a teammate as one pollutes the recruiting funnel and makes a recruiter "recruit" their own team. A matched
  // portal CONTACT or VENDOR seat does not count (that person is a client / a vendor who may also be a fellow agent elsewhere).
  // The scan keeps `subject_user_id`, files nothing, and says why — never an account, never a recruit.
  const existingMember = isExistingTenantMember(cardSubjectType, subjectUserId, subjectUserType)

  if (cardSubjectType === "agent") {
    if (existingMember) {
      // A colleague already in this tenant: nothing is filed (no recruit, no account). Same typed-column answer as a
      // sphere card — routed_entity_type 'none' — with the extracted_data saying WHICH user it already is.
      const { error: scanUpdateMemberError } = await supabase.from("business_card_scans").update({
        extracted_data: { ...extracted, field_confidence: extraction.confidence, routed_to: "existing_member", existing_user_id: subjectUserId, existing_user_type: subjectUserType },
        ...classificationColumns,
        routed_entity_type: "none",
      }).eq("id", scanRef.id)
      if (scanUpdateMemberError) console.error("[businessCardUpload] scan classification update (existing member) failed:", scanUpdateMemberError)
      await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
        brokerageId: brokerageId,
        entityType: "business_card",
        entityId: scanRef.id,
        event: KernelEvent.BUSINESS_CARD_APPROVED,
        metadata: { scanId: scanRef.id, routed_to: "existing_member", card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy, human_confirmed: args.human },
      }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })
      return { ...resultBase, contactId: null, vendorId: null, recruitId: null, entity: { kind: "none", id: null }, existingUserId: subjectUserId }
    }
    // A fellow agent's card = a RECRUITING prospect (agents are platform
    // users, owner rule) — NEVER a CRM contact. recruits.status CHECK
    // vocabulary verified live.
    const { data: recruit, error: recruitError } = await supabase.from("recruits").insert({
      brokerage_id: brokerageId,
      recruiter_agent_id: agentId,
      first_name: confident.first_name ?? null,
      last_name: confident.last_name ?? null,
      email: confident.email ?? null,
      phone: confident.phone ?? null,
      current_brokerage: confident.company ?? null,
      status: "prospect",
      referral_source: "business_card",
      notes: [
        `Scanned from a business card.`,
        confident.title ? `Title on card: ${confident.title}.` : null,
        confident.website ? `Website: ${confident.website}` : null,
        unconfirmedNote || null,
        args.notes ? `Agent notes: ${args.notes}` : null,
      ].filter(Boolean).join(" "),
    }).select("id").single()
    if (recruitError || !recruit) throw new Error(`Recruit create failed: ${recruitError?.message ?? "no data"}`)

    // IDENTITY / DEDUP (wave 142): a fellow agent's card is a BUSINESS identity — the crosswalk's consumer
    // email says whether this person is already a contact here (a sphere relationship, say). Evidence on
    // the scan only: a recruit is NEVER written a consumer contact point to be messaged on (consent).
    const crosswalk = await crosswalkBusinessIdentity({ supabase, brokerageId, scanId: scanRef.id, actorUserId: args.actorUserId, agentId, confident, entityKind: "recruit" })

    const { error: scanUpdateAgentError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, field_confidence: extraction.confidence, routed_to: "recruit", recruit_id: recruit.id, ...(crosswalk ? { identity_crosswalk: crosswalk } : {}) },
      ...classificationColumns,
      recruit_id: recruit.id,
      routed_entity_type: "recruit",
    }).eq("id", scanRef.id)
    if (scanUpdateAgentError) console.error("[businessCardUpload] scan classification update (agent) failed:", scanUpdateAgentError)

    // ONE EMIT (wave 101C): the audit row + its fan-out are one emitKernelEvent; the metadata is the
    // fan-out's (a superset of the row's old keys, same values), so the reactor input is unchanged.
    await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId: brokerageId,
      entityType: "recruit",
      entityId: recruit.id,
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scanRef.id, routed_to: "recruit", card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy, human_confirmed: args.human },
    }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    return { ...resultBase, contactId: null, vendorId: null, recruitId: recruit.id, entity: { kind: "recruit", id: recruit.id } }
  }

  if (cardSubjectType === "sphere" || cardSubjectType === "unknown") {
    // NEVER auto-create a contact for sphere/unknown — the owner ruling's
    // whole point. The card stays a business_card_scans row; the warm-intro
    // (sphere) / classify-me (unknown) handler reads it directly off the scan.
    // routed_entity_type 'none' says so in a typed column (m789) — "nothing" is an answer, not an absence.
    const { error: scanUpdateSphereError } = await supabase.from("business_card_scans").update({
      extracted_data: { ...extracted, field_confidence: extraction.confidence },
      ...classificationColumns,
      routed_entity_type: "none",
    }).eq("id", scanRef.id)
    if (scanUpdateSphereError) console.error("[businessCardUpload] scan classification update (sphere/unknown) failed:", scanUpdateSphereError)

    // ONE EMIT (wave 101C) — same rule as the recruit branch above.
    await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
      brokerageId: brokerageId,
      entityType: "business_card",
      entityId: scanRef.id,
      event: KernelEvent.BUSINESS_CARD_APPROVED,
      metadata: { scanId: scanRef.id, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy, human_confirmed: args.human },
    }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

    return { ...resultBase, contactId: null, vendorId: null, recruitId: null, entity: { kind: "none", id: null } }
  }

  // cardSubjectType is 'contact' or 'potential_contact' — the only two classes
  // the owner ruling permits to auto-create a contacts row. tcpa_consent=false
  // always (a physical card is not TCPA digital consent). Owner agent resolves
  // via brokerage assignment rules — the scanner doesn't own the contact just
  // because they scanned it. Company/title/website from the card ride the
  // notes (previously extracted then DROPPED). ONLY CONFIDENT READINGS reach
  // the columns; captureContact's own dedup/merge (lib/contact-pipeline/
  // contact-capture.ts — fill-if-empty, conflicts preserved in notes, never an
  // overwrite) is the identity layer every capture door shares.
  const { contactId, action: captureAction } = await captureContact({
    brokerageId: brokerageId,
    ownerAgentId: null,
    source: "business_card",
    first_name: confident.first_name ?? null,
    last_name: confident.last_name ?? null,
    email: confident.email ?? null,
    phone: confident.phone ?? null,
    address: confident.address ?? null,
    // 'prospect' is the live contacts.contact_type CHECK value for a not-yet-
    // qualified potential client (scripts/check-vocabularies.ts:538) — leaving
    // it unset for 'contact' keeps captureContact's own default.
    contact_type: cardSubjectType === "potential_contact" ? "prospect" : undefined,
    notes: [
      confident.title || confident.company
        ? `From their card: ${[confident.title, confident.company].filter(Boolean).join(" @ ")}.`
        : null,
      confident.website ? `Website: ${confident.website}` : null,
      unconfirmedNote || null,
      args.notes ? `Agent notes: ${args.notes}` : null,
    ].filter(Boolean).join("\n") || undefined,
    tcpa_consent: false,
    tcpa_consent_date: null,
  })

  // 7) Link scan to contact — the ONE case a scan is rightly "saved as a contact id" (typed: routed_entity_type 'contact').
  const { error: scanUpdateContactError } = await supabase
    .from("business_card_scans")
    .update({
      contact_id: contactId,
      extracted_data: { ...extracted, field_confidence: extraction.confidence },
      ...classificationColumns,
      routed_entity_type: "contact",
    })
    .eq("id", scanRef.id)
  if (scanUpdateContactError) console.error("[businessCardUpload] scan classification update (contact) failed:", scanUpdateContactError)

  // 7b) EVIDENCE PER FIELD (wave 141F): the columns the contact now holds from this card are
  // stamped with the reading's confidence (or the confirming human), by value equality —
  // never over an existing stamp (a provider match or a staff edit outranks a card).
  await stampCardProvenance(supabase, { brokerageId, contactId, extraction, human: args.human, actor: args.actorUserId })

  // ONE EMIT (wave 101C) — same rule as the recruit branch above.
  await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
    brokerageId: brokerageId,
    entityType: "contact",
    entityId: contactId,
    event: KernelEvent.BUSINESS_CARD_APPROVED,
    metadata: { scanId: scanRef.id, autoApproved: !args.human, capture_action: captureAction, card_subject_type: cardSubjectType, subject_user_id: subjectUserId, subject_user_type: subjectUserType, classified_by: classifiedBy, human_confirmed: args.human },
  }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

  return { ...resultBase, contactId, vendorId: null, recruitId: null, entity: { kind: "contact", id: contactId } }
}

/** What the crosswalk left on the scan row — evidence, never a contact point written to the entity. */
type IdentityCrosswalkEvidence = {
  via: "versium_b2b2c"
  /** The tenant's contacts row the crosswalk resolved this business identity to, when one exists. */
  matched_contact_id: string | null
  consumer_emails_found: number
  cost_usd: number
  skipped: string | null
  at: string
}

/**
 * B2B2C IDENTITY MATCHING for a VENDOR / AGENT card (wave 142, lane 142D; owner: "B2B2C identity
 * matching … exposed through existing kernel-governed capabilities"). The card is a BUSINESS identity
 * (a LinkedIn URL on the card, or the printed name + the city/state of the printed address); the
 * business_identity capability (lib/ai-isa/property-lookup-rail.ts runVersiumBusinessIdentityLeg —
 * budget-gated, health-routed, booked) crosswalks it to a CONSUMER email, which is matched against the
 * tenant's own contacts. The answer is EVIDENCE on the scan (dedup: "this vendor is also Dana, your
 * sphere contact"); nothing is written onto the vendor / recruit and no outreach channel is created.
 * Ledgered (withActionLedger business_card.identity_crosswalk — who, which scan, what it cost).
 * Best-effort: a refusal is recorded by name; a throw never fails the scan.
 */
async function crosswalkBusinessIdentity(args: {
  supabase: ReturnType<typeof createServiceClient>
  brokerageId: string
  scanId: string
  actorUserId: string | null
  agentId: string
  confident: Partial<Record<CardField, string>>
  entityKind: "vendor" | "recruit"
}): Promise<IdentityCrosswalkEvidence | null> {
  const { supabase, brokerageId, scanId, confident } = args
  const website = (confident.website ?? "").trim()
  const linkedinUrl = /linkedin\.com\/in\//i.test(website) ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null
  // "City, ST 12345" at the tail of the printed address — the documented name + city + state input.
  const geo = /,\s*([A-Za-z .'-]{2,}),\s*([A-Za-z]{2})\b(?:\s+(\d{5}))?/.exec(confident.address ?? "")
  const identity = {
    linkedinUrl,
    firstName: confident.first_name ?? null,
    lastName: confident.last_name ?? null,
    city: geo?.[1]?.trim() ?? null,
    state: geo?.[2]?.toUpperCase() ?? null,
    zip: geo?.[3] ?? null,
  }
  const askable = !!identity.linkedinUrl || !!(identity.firstName && identity.lastName && identity.city && identity.state)
  if (!askable) return null
  try {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const { runVersiumBusinessIdentityLeg } = await import("@/lib/ai-isa/property-lookup-rail")
    return await withActionLedger<IdentityCrosswalkEvidence | null>(
      {
        brokerageId,
        action: "business_card.scan.identity_crosswalk",
        actor: { type: "user", userId: args.actorUserId, agentId: args.agentId },
        subject: { type: "business_card_scan", id: scanId },
        reasonCode: "HUMAN_REQUESTED",
        reasonDetail: `the scanning agent filed a ${args.entityKind === "vendor" ? "vendor" : "fellow agent"}'s card — its business identity is matched against the tenant's contacts`,
        idempotencyKey: `business_card_crosswalk:${scanId}`,
        riskClass: "LOW_RISK_WRITE",
        systemSource: "business-card-actions",
        detail: { entity_kind: args.entityKind, keyed_by: identity.linkedinUrl ? "li_url" : "name_city_state" },
      },
      async () => {
        const leg = await runVersiumBusinessIdentityLeg({
          brokerageId,
          identity,
          outputs: ["consumer_email"],
          systemSource: "business_card_scan",
          metadata: { scanId, entity_kind: args.entityKind },
        })
        let matchedContactId: string | null = null
        for (const email of leg.consumerEmails) {
          const { data: hit, error } = await supabase.from("contacts").select("id").eq("brokerage_id", brokerageId).eq("email", email.toLowerCase()).maybeSingle()
          if (error) { console.error("[business-card] crosswalk contact match read refused:", error.message); break }
          if (hit) { matchedContactId = (hit as { id: string }).id; break }
        }
        return { via: "versium_b2b2c", matched_contact_id: matchedContactId, consumer_emails_found: leg.consumerEmails.length, cost_usd: leg.cost, skipped: leg.skipped, at: new Date().toISOString() }
      },
      {
        settle: (r) => r ? { status: "executed", outcome: r.matched_contact_id ? "matched" : r.skipped ? "skipped" : "no_match", provider: r.skipped ? null : "versium" } : { status: "failed", outcome: "refused", error: "no identity" },
        // WAVE 147 (lane 147F, ruling 11): the hook used to answer EVERY non-acting claim with `null`, so a ledger
        // REFUSAL (no paid lookup ran, nothing was recorded) left the scan with no trace — the header's "a refusal is
        // recorded by name" was not true for the ledger's own refusal. A refusal now rides the scan as evidence that
        // names it (no provider was called, cost 0); a replay / in-flight / unknown claim still adds nothing (the
        // first run's evidence is the record).
        replay: (claim) => claim.kind === "refused"
          ? { via: "versium_b2b2c", matched_contact_id: null, consumer_emails_found: 0, cost_usd: 0, skipped: `ledger_refused: ${claim.error}`.slice(0, 300), at: new Date().toISOString() }
          : null,
      },
      { client: supabase },
    )
  } catch (err) {
    console.error("[business-card] identity crosswalk threw (scan kept):", err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Read the contact back and stamp provenance on the columns that now carry the card's reading. */
async function stampCardProvenance(
  supabase: ReturnType<typeof createServiceClient>,
  args: { brokerageId: string; contactId: string; extraction: CardExtraction; human: boolean; actor: string | null },
): Promise<void> {
  try {
    const { data: row, error } = await supabase
      .from("contacts")
      .select("first_name, last_name, email, phone, address, enrichment_profile")
      .eq("id", args.contactId)
      .eq("brokerage_id", args.brokerageId)
      .maybeSingle()
    if (error || !row) {
      if (error) console.error("[business-card] provenance read refused:", error.message)
      return
    }
    const { fieldProvenanceOf } = await import("@/lib/lead-pipeline/enrichment-column-map")
    const stamps = cardStampsForContact(args.extraction, row as Record<string, unknown>, fieldProvenanceOf((row as { enrichment_profile?: Record<string, unknown> | null }).enrichment_profile), { human: args.human, actor: args.actor })
    if (Object.keys(stamps).length === 0) return
    const { persistFieldProvenance } = await import("@/lib/enrichment/field-provenance-store")
    const stamped = await persistFieldProvenance(supabase as any, { table: "contacts", id: args.contactId, brokerageId: args.brokerageId }, stamps)
    if (!stamped.ok) console.error(`[business-card] provenance not stamped for ${args.contactId}: ${stamped.error}`)
  } catch (err) {
    console.error("[business-card] provenance stamping threw:", err instanceof Error ? err.message : String(err))
  }
}

type ConfirmBusinessCardResult =
  | { ok: true; mode: "routed"; result: ScanResultShape }
  | { ok: true; mode: "corrected"; contactId: string; applied: CardField[]; kept: Array<{ field: CardField; reason: string }> }
  /** Wave 142: the scan was held for its TYPE and the confirmation named none — pick one (the suggestion is shown). */
  | { ok: false; error: string; needsSubjectType: true; suggestedSubjectType: CardSubjectType | null }
  | { ok: false; error: string; needsSubjectType?: false }

/**
 * HUMAN CONFIRMATION (wave 141F) — the scanning agent confirms or corrects the reader's fields.
 * Two cases, one door:
 *   · a scan HELD as 'pending' (an identity field below the floor): the confirmed fields are
 *     confidence 1.0 and the card is routed exactly as a confident scan would have been;
 *   · a scan that already produced a contact ("Report extraction error" on the review surface):
 *     each corrected column is written ONLY where the field-level merge rule allows it —
 *     a human beats a card reading, never a provider match, a staff edit or the contact's own
 *     portal entry (decideCardFieldWrite); what was kept is reported with its reason.
 * Tenant from the session; the scan is read under it (fail closed). Ledgered (withActionLedger
 * business_card.confirm, HUMAN_REQUESTED) — who confirmed what, and which columns moved.
 */
export async function confirmBusinessCardScan(params: {
  scanId: string
  fields: Partial<Record<CardField, string>>
  notes?: string | null
  subjectType?: CardSubjectType
}): Promise<ConfirmBusinessCardResult> {
  const auth = await requireCaller()
  if (!auth.ok) return { ok: false, error: auth.error }
  const brokerageId = auth.brokerageId
  const agentId = auth.agentId
  if (!agentId) return { ok: false, error: "No agent profile for this user yet — finish account setup." }
  if (!params?.scanId) return { ok: false, error: "No scan id supplied." }

  const supabase = createServiceClient()
  const { data: scan, error: scanError } = await supabase
    .from("business_card_scans")
    .select("id, agent_id, contact_id, review_status, extracted_data, subject_notes, card_subject_type, classified_by")
    .eq("id", params.scanId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  if (scanError) return { ok: false, error: `Could not read the scan: ${scanError.message}` }
  if (!scan) return { ok: false, error: "That scan is not in your brokerage." }
  const row = scan as { id: string; agent_id: string | null; contact_id: string | null; review_status: string | null; extracted_data: Record<string, unknown> | null; subject_notes: string | null; card_subject_type: CardSubjectType | null; classified_by: string | null }
  if (row.review_status !== "pending" && !row.contact_id) {
    return { ok: false, error: "This scan was already routed (to a vendor, a recruiting prospect, or left unfiled) — there is nothing to confirm on it." }
  }

  // THE TYPE IS THE HUMAN'S (wave 142): a held scan routes only under a type a person chose — the one
  // picked before the scan (stored as classified_by 'picker') or the one named now. A reader/notes
  // SUGGESTION is shown back, never promoted on its own.
  const storedPick: CardSubjectType | null = row.classified_by === "picker" ? row.card_subject_type : null
  const subjectType: CardSubjectType | null = params.subjectType ?? storedPick
  if (!row.contact_id && !subjectType) {
    return { ok: false, needsSubjectType: true, suggestedSubjectType: row.card_subject_type ?? null, error: `Pick who this card is for (vendor, contact, or fellow agent) to file it${row.card_subject_type && row.card_subject_type !== "unknown" ? ` — the reader suggests ${row.card_subject_type.replace(/_/g, " ")}` : ""}.` }
  }

  const extraction = humanConfirmedExtraction(params.fields ?? {})
  const assessment = assessCardExtraction(extraction)
  if (!assessment.viable) return { ok: false, error: "A name and an email or phone number are required." }

  const now = new Date().toISOString()
  const corrected = CARD_FIELDS.filter((f) => extraction.fields[f] !== ((row.extracted_data?.[f] as string | undefined) ?? ""))
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  // WAVE 147 (lane 147F, ruling 11): the key used to end in `${now}` (a millisecond timestamp), so every call minted a
  // fresh key and a retried / double-submitted confirmation RAN TWICE — the ledger's at-most-once never engaged. The
  // cycle is now WHAT was confirmed: the scan, the mode, the fields, the chosen type and the notes. The same
  // confirmation submitted twice replays; a genuinely different correction later is a new action.
  const confirmationKey = confirmationFingerprint({
    mode: row.contact_id ? "corrected" : "routed",
    fields: extraction.fields as Record<string, unknown>,
    subjectType: subjectType ?? null,
    notes: params.notes === undefined ? null : params.notes ?? null,
  })

  return withActionLedger<ConfirmBusinessCardResult>(
    {
      brokerageId,
      action: "business_card.scan.confirm",
      actor: { type: "user", userId: auth.userId, agentId },
      subject: { type: "business_card_scan", id: row.id },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: row.contact_id ? "the scanning agent corrected a card reading on an existing contact" : "the scanning agent confirmed a card reading the reader was unsure of",
      idempotencyKey: `business_card_confirm:${row.id}:${confirmationKey}`,
      riskClass: "LOW_RISK_WRITE",
      systemSource: "business-card-actions",
      detail: { mode: row.contact_id ? "corrected" : "routed", corrected_fields: corrected, previous_status: row.review_status },
    },
    async () => {
      const scanPatch = {
        extracted_data: { ...(row.extracted_data ?? {}), ...extraction.fields, field_confidence: extraction.confidence, needs_confirmation: false, needs_type_confirmation: false },
        confidence_score: 1,
        review_status: "approved",
        reviewed_by: auth.userId,
        reviewed_at: now,
        ...(params.notes !== undefined ? { subject_notes: params.notes ?? null } : {}),
      }

      if (row.contact_id) {
        // ── CORRECTION on an existing contact — the field-level merge rule, per column ──
        const { data: contact, error: contactError } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, email, phone, address, enrichment_profile, notes")
          .eq("id", row.contact_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()
        if (contactError) return { ok: false as const, error: `Could not read the contact: ${contactError.message}` }
        if (!contact) return { ok: false as const, error: "The contact this scan produced is no longer in your brokerage." }
        const c = contact as Record<string, unknown>
        const { fieldProvenanceOf } = await import("@/lib/lead-pipeline/enrichment-column-map")
        const provenance = fieldProvenanceOf(c.enrichment_profile as Record<string, unknown> | null)
        const patch: Record<string, unknown> = {}
        const applied: CardField[] = []
        const kept: Array<{ field: CardField; reason: string }> = []
        for (const f of CARD_FIELDS) {
          const column = CARD_FIELD_TO_CONTACT_COLUMN[f]
          if (!column) continue
          const decision = decideCardFieldWrite({
            field: f, existingValue: c[column], existingStamp: (provenance[column] as { source: string; matchConfidence: string | null } | undefined) ?? null,
            incomingValue: extraction.fields[f], incomingConfidence: 1, incomingHuman: true,
          })
          if (decision.write) { patch[column] = extraction.fields[f]; applied.push(f) }
          else if (decision.reason !== "no_incoming" && decision.reason !== "same_value") kept.push({ field: f, reason: decision.reason })
        }
        const keptLine = kept.length
          ? `[card correction ${now.slice(0, 10)}] kept over the card: ${kept.map((k) => `${k.field.replace(/_/g, " ")} (${k.reason.replace(/_/g, " ")}: card said "${extraction.fields[k.field]}")`).join("; ")}`
          : null
        if (Object.keys(patch).length > 0 || keptLine) {
          const { data: updated, error: updateError } = await supabase
            .from("contacts")
            .update({ ...patch, ...(keptLine ? { notes: [c.notes as string | null, keptLine].filter(Boolean).join("\n") } : {}), updated_at: now })
            .eq("id", row.contact_id)
            .eq("brokerage_id", brokerageId)
            .select("id")
          if (updateError) return { ok: false as const, error: `Could not apply the correction: ${updateError.message}` }
          if (!Array.isArray(updated) || updated.length !== 1) return { ok: false as const, error: "The correction matched no contact row in your brokerage." }
        }
        await stampCardProvenance(supabase, { brokerageId, contactId: row.contact_id, extraction, human: true, actor: auth.userId })
        const { error: scanUpdateError } = await supabase.from("business_card_scans").update(scanPatch).eq("id", row.id).eq("brokerage_id", brokerageId)
        if (scanUpdateError) console.error("[business-card] confirmed scan row update failed:", scanUpdateError.message)
        return { ok: true as const, mode: "corrected" as const, contactId: row.contact_id, applied, kept }
      }

      // ── A HELD scan — approve it, then route it exactly as a confident reading ──
      const { data: approved, error: approveError } = await supabase
        .from("business_card_scans")
        .update(scanPatch)
        .eq("id", row.id)
        .eq("brokerage_id", brokerageId)
        .select("id")
      if (approveError) return { ok: false as const, error: `Could not approve the scan: ${approveError.message}` }
      if (!Array.isArray(approved) || approved.length !== 1) return { ok: false as const, error: "The scan matched no row in your brokerage." }

      const result = await routeClassifiedCard({
        supabase, brokerageId, agentId: row.agent_id ?? agentId, actorUserId: auth.userId, scanId: row.id, extraction,
        notes: params.notes ?? row.subject_notes ?? null, subjectTypePick: subjectType ?? undefined, human: true,
        base: { scanId: row.id, extracted: extraction.fields, fieldConfidence: extraction.confidence, lowFields: [] },
      })
      return { ok: true as const, mode: "routed" as const, result }
    },
    {
      settle: (r) => r.ok
        ? { status: "executed", outcome: r.mode, provider: null }
        : { status: "failed", outcome: "refused", error: r.error },
      // WAVE 147 (lane 147F): one message used to cover every non-acting claim — "This confirmation was already
      // recorded." — which was FALSE for a refused claim (nothing was recorded and nothing ran). Each kind now says
      // what actually happened; none of them acts (fail closed).
      replay: (claim) => claim.kind === "replay"
        ? { ok: false, error: "This exact confirmation was already recorded — nothing was changed a second time." }
        : claim.kind === "in_flight"
          ? { ok: false, error: "This confirmation is being recorded right now — refresh in a moment." }
          : claim.kind === "unknown"
            ? { ok: false, error: "An earlier attempt at this confirmation ended in an unknown state — check the scan before trying again." }
            : { ok: false, error: `The confirmation could not be recorded, so nothing was changed (${claim.error}).` },
    },
    { client: supabase },
  )
}

/** The idempotency cycle of one confirmation: a short stable digest of what was confirmed (key order is fixed). */
function confirmationFingerprint(c: { mode: string; fields: Record<string, unknown>; subjectType: string | null; notes: string | null }): string {
  const fields = Object.keys(c.fields).sort().map((k) => [k, c.fields[k] ?? ""])
  return createHash("sha256").update(JSON.stringify([c.mode, fields, c.subjectType, c.notes])).digest("hex").slice(0, 24)
}

/**
 * WHO REVIEWED THE SCAN. `business_card_scans.reviewed_by` FKs users(id)
 * (scripts/schema-fk-map.ts). Its writers: uploadBusinessCard above stamps a
 * LITERAL `null` (the viability gate is automatic, `reviewed_at` is the moment
 * it ran) and — since wave 141F — confirmBusinessCardScan stamps the confirming
 * user's id and the moment they confirmed. `review_status` is the gate's
 * verdict: approved (routed), pending (held for a human), rejected (not viable).
 * Both columns are read and returned so the surface can render "confirmed by
 * you" versus "auto-gated, not reviewed by a person" truthfully.
 */
export async function getRecentScans(params: {
  agentId?: string  // ignored — derived from session
  brokerageId?: string  // ignored — derived from session
  limit?: number
}): Promise<{
  id: string
  created_at: string
  extracted_data: Record<string, string>
  confidence_score: number
  review_status: "approved" | "pending" | "rejected"
  contact_id: string | null
  raw_image_url: string
  /** users.id of the human who confirmed the scan (confirmBusinessCardScan); null when auto-gated. */
  reviewed_by: string | null
  /** When the viability gate ran, or when a human confirmed. */
  reviewed_at: string | null
  /** Read off the typed m617 column business_card_scans.card_subject_type
   *  (lib/contacts/card-classifier.ts CardSubjectType — one vocabulary, §6,
   *  asserted against scripts/check-vocabularies.ts's CHECK by
   *  scripts/business-card-classification-simulator.ts). Null for scans made
   *  before wave 48 / before the migration backfill. */
  cardSubjectType: CardSubjectType | null
  subjectUserId: string | null
  /** business_card_scans.subject_notes — the scanning agent's free-text note,
   *  rendered on the review surface beside class + classifiedBy. */
  subjectNotes: string | null
  classifiedBy: "picker" | "reader" | "notes" | "match" | "default" | null
  /** Wave 141F — per-field reader confidence (extracted_data.field_confidence); {} for older scans. */
  fieldConfidence: Partial<Record<CardField, number | null>>
  /** Wave 141F — held for a human (review_status 'pending'). */
  needsConfirmation: boolean
  /** Wave 142 — held for its TYPE ("auto" pre-scan choice): the human picks vendor / contact / agent on confirm. */
  needsTypeConfirmation: boolean
  /** Wave 142 — what the reader + notes suggested for a held scan (null once routed or when nothing was suggested). */
  suggestedSubjectType: CardSubjectType | null
  /** Wave 142 — WHICH domain entity the scan became, from the typed m789 columns (vendor_id / recruit_id /
   *  routed_entity_type beside contact_id): the truthful "what did this card get saved as". `none` is a
   *  sphere / unclassified card kept as a scan row on purpose; `null` kind = not routed (held / rejected / pre-m789). */
  entity: ScanEntity | null
}[]> {
  const auth = await requireCaller()
  if (!auth.ok) return []

  const supabase = createServiceClient()

  // Scope to caller's session — only their own scans within their brokerage
  let query = supabase
    .from("business_card_scans")
    .select("id, created_at, extracted_data, confidence_score, review_status, contact_id, vendor_id, recruit_id, routed_entity_type, raw_image_url, reviewed_by, reviewed_at, card_subject_type, subject_user_id, subject_notes, classified_by")
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 20)

  if (auth.agentId) {
    query = query.eq("agent_id", auth.agentId)
  } else {
    // Non-agent users (admin/broker) without an agents row see all scans in
    // their brokerage. Still tenant-scoped via .eq("brokerage_id", ...).
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to load scans: ${error.message}`)

  return ((data ?? []) as any[]).map((s) => {
    const ed = (s.extracted_data ?? {}) as Record<string, unknown>
    const { field_confidence, needs_confirmation: _nc, needs_type_confirmation: _ntc, identity_crosswalk: _ic, routed_to: _rt, vendor_id: _vid, recruit_id: _rid, ...rest } = ed
    const fieldConfidence = (field_confidence && typeof field_confidence === "object" ? field_confidence : {}) as Partial<Record<CardField, number | null>>
    const routed = (s.routed_entity_type as ScanEntity["kind"] | null | undefined) ?? null
    const entity: ScanEntity | null = routed === "contact" ? { kind: "contact", id: (s.contact_id as string | null) ?? null }
      : routed === "vendor" ? { kind: "vendor", id: (s.vendor_id as string | null) ?? null }
      : routed === "recruit" ? { kind: "recruit", id: (s.recruit_id as string | null) ?? null }
      : routed === "none" ? { kind: "none", id: null }
      // Pre-m789 rows: a contact link is the one typed link that existed; everything else is unknown, not "contact".
      : s.contact_id ? { kind: "contact", id: s.contact_id as string } : null
    const pending = s.review_status === "pending"
    return {
      id: s.id as string,
      created_at: s.created_at as string,
      extracted_data: rest as Record<string, string>,
      confidence_score: Number(s.confidence_score ?? 0),
      review_status: s.review_status as "approved" | "pending" | "rejected",
      contact_id: (s.contact_id as string | null) ?? null,
      raw_image_url: s.raw_image_url as string,
      reviewed_by: (s.reviewed_by as string | null) ?? null,
      reviewed_at: (s.reviewed_at as string | null) ?? null,
      cardSubjectType: (s.card_subject_type as CardSubjectType | null | undefined) ?? null,
      subjectUserId: (s.subject_user_id as string | null | undefined) ?? null,
      subjectNotes: (s.subject_notes as string | null | undefined) ?? null,
      classifiedBy: (s.classified_by as "picker" | "reader" | "notes" | "match" | "default" | null | undefined) ?? null,
      fieldConfidence,
      needsConfirmation: pending,
      needsTypeConfirmation: pending && ed.needs_type_confirmation === true,
      suggestedSubjectType: pending ? ((s.card_subject_type as CardSubjectType | null | undefined) ?? null) : null,
      entity,
    }
  })
}
