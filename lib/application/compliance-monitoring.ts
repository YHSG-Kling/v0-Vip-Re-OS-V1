import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { businessDaysInclusive } from "@/lib/compliance/trid-disclosure-clock"
import { resolveBrokerageComplianceIdentity } from "@/lib/brokerage/compliance-identity"

// ============================================
// AUDIT LOGGING
// ============================================

export async function logAuditEventService(params: {
  userId: string
  action: string
  entityType: string
  entityId: string
  changes?: any
  ipAddress?: string
  userAgent?: string
  complianceRelevant?: boolean
}) {
  const supabase = await createClient()

  const { error } = await supabase.from("audit_log").insert({
    user_id: params.userId,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    // audit_log carries before/after JSONB. The legacy `audit_logs` callsite
    // passed a single `changes` payload; we put it in `after` and fold the
    // request-context (ip / UA / compliance flag) into the same JSONB so we
    // don't lose the data on the schema unification.
    before: null,
    after: {
      changes: params.changes ?? null,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
      compliance_relevant: params.complianceRelevant ?? false,
    },
  })

  if (error) {
    console.error("[ComplianceMonitoring] Error logging audit event:", error)
    throw new Error("Failed to log audit event")
  }

  return { success: true }
}

// ============================================
// COMPLIANCE STATUS
// ============================================

export async function checkComplianceStatusService(transactionId: string) {
  const supabase = await createClient()

  const { data: checklists } = await supabase
    .from("compliance_checklists")
    .select("*")
    .eq("transaction_id", transactionId)

  const { data: trid } = await supabase
    .from("trid_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  const { data: alerts } = await supabase
    .from("compliance_alerts")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("resolved", false)

  return {
    checklists: checklists || [],
    trid: trid || null,
    alerts: alerts || [],
    overallStatus:
      (alerts?.length || 0) > 0
        ? "at_risk"
        : checklists?.every((c) => c.compliance_status === "compliant")
          ? "compliant"
          : "pending",
  }
}

// ============================================
// CERTIFICATION TRACKING
// ============================================

export async function trackCertificationExpirationService(agentId: string, client?: SupabaseClient) {
  // Accept a caller-supplied client so system crons can pass a service-role
  // client (bypasses RLS); UI callers default to the user-context client.
  const supabase = client ?? await createClient()

  const today = new Date()
  const thirtyDaysFromNow = new Date()
  thirtyDaysFromNow.setDate(today.getDate() + 30)

  const { data: certifications } = await supabase
    .from("agent_certifications")
    .select("*")
    .eq("agent_id", agentId)

  const expiringCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expires_at)
    return expDate <= thirtyDaysFromNow && expDate > today
  })

  const expiredCerts = certifications?.filter((cert) => {
    const expDate = new Date(cert.expires_at)
    return expDate <= today
  })

  // agent_certifications has no status column — the expiring/expired/active lifecycle
  // is fully derived from expires_at, so there is nothing to persist.

  return {
    active: certifications?.filter((c) => !c.expires_at || new Date(c.expires_at) > today).length || 0,
    expiring: expiringCerts?.length || 0,
    expired: expiredCerts?.length || 0,
  }
}

// ============================================
// FAIR HOUSING
// ============================================

export async function analyzeFairHousingRiskService(params: {
  contactId: string
  agentId: string
  interactionType: string
  communicationText: string
}) {
  const supabase = await createClient()

  const protectedClasses = [
    "race", "color", "religion", "national origin",
    "sex", "disability", "familial status", "age",
  ]

  const redFlagPhrases = [
    "perfect for families", "great for retirees", "quiet neighborhood",
    "young professional area", "walk to church", "good schools",
    "safe area", "changing neighborhood",
  ]

  const foundPhrases = redFlagPhrases.filter((phrase) =>
    params.communicationText.toLowerCase().includes(phrase.toLowerCase()),
  )

  const { text } = await generateText({
    model: resolveModel("openai/gpt-4o-mini"),
    prompt: `Analyze this real estate communication for potential Fair Housing Act violations.

Communication: "${params.communicationText}"

Protected classes: ${protectedClasses.join(", ")}

Return a JSON object with:
- risk_score: 0.0 to 1.0 (0 = no risk, 1 = high risk)
- protected_class_mentioned: boolean
- steering_detected: boolean
- flagged_content: array of concerning phrases
- explanation: brief explanation of any concerns
- recommendation: what the agent should do

Focus on detecting:
1. Direct or indirect references to protected classes
2. Steering language that suggests or discourages based on demographics
3. Coded language that implies discrimination
4. Familial status violations (families with children)`,
  })

  let aiAnalysis
  try {
    aiAnalysis = JSON.parse(text)
  } catch {
    aiAnalysis = {
      risk_score: foundPhrases.length > 0 ? 0.7 : 0.3,
      protected_class_mentioned: false,
      steering_detected: foundPhrases.length > 0,
      flagged_content: foundPhrases,
      explanation: "Manual review needed",
      recommendation: "Review with compliance officer",
    }
  }

  // Resolve brokerage from the contact (fallback to agent) so every audit row is
  // tenant-scoped and visible to brokerage-scoped reads / RLS.
  const { data: fhContact } = await supabase
    .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
  let brokerageId: string | null = fhContact?.brokerage_id ?? null
  if (!brokerageId && params.agentId) {
    const { data: fhAgent } = await supabase
      .from("agents").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    brokerageId = fhAgent?.brokerage_id ?? null
  }

  // compliance_flags is the CANONICAL compliance ledger (the compliance UI
  // reads it and explicitly ignores fair_housing_logs — that table was a
  // write-only twin nothing consumed; keep-one repoint, open-loop sweep).
  const allFlagged = [...foundPhrases, ...aiAnalysis.flagged_content]
  const { error } = await supabase
    .from("compliance_flags")
    .insert({
      brokerage_id: brokerageId,
      contact_id: params.contactId,
      agent_id: params.agentId,
      violation_type: "fair_housing_violation",
      severity: aiAnalysis.risk_score >= 75 ? "critical" : aiAnalysis.risk_score >= 40 ? "high" : "medium",
      content_type: params.interactionType,
      flagged_content: `${allFlagged.join("; ").slice(0, 300)} :: ${params.communicationText.slice(0, 400)}`,
      detected_at: new Date().toISOString(),
      status: "flagged",
    })

  if (error) {
    console.error("[ComplianceMonitoring] Error logging fair housing analysis:", error)
  }

  if (aiAnalysis.risk_score >= 0.6) {
    await supabase.from("compliance_alerts").insert({
      brokerage_id: brokerageId,
      transaction_id: null,
      alert_type: "FAIR_HOUSING_RISK",
      severity: aiAnalysis.risk_score >= 0.8 ? "critical" : "high",
      message: `Potential fair housing violation detected in ${params.interactionType}`,
      details: {
        contact_id: params.contactId,
        agent_id: params.agentId,
        risk_score: aiAnalysis.risk_score,
        flagged_phrases: aiAnalysis.flagged_content,
        recommendation: aiAnalysis.recommendation,
      },
    })

    // Surface to compliance_flags — the table the compliance dashboard reads
    // (filtered by violation_type='fair_housing' + brokerage_id). Without this,
    // the analysis is invisible to the UI.
    await supabase.from("compliance_flags").insert({
      brokerage_id: brokerageId,
      agent_id: params.agentId,
      contact_id: params.contactId,
      content_type: params.interactionType,
      violation_type: "fair_housing",
      flagged_content: { text: params.communicationText, ...aiAnalysis },
      severity: aiAnalysis.risk_score >= 0.8 ? "critical" : "high",
      status: "flagged",
      detected_at: new Date().toISOString(),
    })
  }

  revalidatePath("/dashboard/compliance")
  return aiAnalysis
}

// ============================================
// TRID
// ============================================

// Single source of truth for the TRID business-day convention (weekends + federal
// holidays excluded) — delegate to the disclosure clock so the post-hoc monitor and
// the forward-looking clock can never drift. Dates may arrive as timestamps; the
// clock expects yyyy-mm-dd, so slice.
const getBusinessDays = (startDate: string, endDate: string) =>
  businessDaysInclusive(startDate.slice(0, 10), endDate.slice(0, 10))

export async function monitorTRIDComplianceService(transactionId: string, client?: SupabaseClient) {
  // Accept a caller-supplied client so the compliance cron can pass a
  // service-role client (bypasses RLS); UI callers default to user context.
  const supabase = client ?? await createClient()

  const { data: timeline } = await supabase
    .from("trid_timeline")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  if (!timeline) {
    return { compliant: true, violations: [] }
  }

  // Resolve brokerage from the transaction so alerts are tenant-scoped.
  const { data: tridTxn } = await supabase
    .from("transactions").select("brokerage_id").eq("id", transactionId).maybeSingle()
  const tridBrokerageId: string | null = tridTxn?.brokerage_id ?? null

  const violations: any[] = []

  if (timeline.loan_application_date && timeline.loan_estimate_delivered_date) {
    const days = getBusinessDays(timeline.loan_application_date, timeline.loan_estimate_delivered_date)
    if (days > 3) {
      violations.push({
        type: "TRID_LE_LATE",
        severity: "high",
        message: `Loan Estimate delivered ${days} business days after application (max 3)`,
        days_violation: days - 3,
      })
    }
  }

  if (timeline.closing_disclosure_delivered_date && timeline.scheduled_close_date) {
    const days = getBusinessDays(timeline.closing_disclosure_delivered_date, timeline.scheduled_close_date)
    if (days < 3) {
      violations.push({
        type: "TRID_CD_EARLY_CLOSE",
        severity: "critical",
        message: `Closing scheduled only ${days} business days after CD delivery (min 3 required)`,
        days_violation: 3 - days,
      })
    }
  }

  await supabase
    .from("trid_timeline")
    .update({
      compliance_status: violations.length > 0 ? "violation" : "compliant",
      violations,
    })
    .eq("id", timeline.id)

  for (const violation of violations) {
    await supabase.from("compliance_alerts").insert({
      brokerage_id: tridBrokerageId,
      transaction_id: transactionId,
      alert_type: violation.type,
      severity: violation.severity,
      message: violation.message,
      details: violation,
    })
  }

  revalidatePath(`/transactions/${transactionId}`)
  return { compliant: violations.length === 0, violations }
}

export async function createTRIDTimelineService(transactionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("trid_timeline")
    .insert({ transaction_id: transactionId })
    .select()
    .single()

  if (error) {
    console.error("[ComplianceMonitoring] Error creating TRID timeline:", error)
    throw new Error("Failed to create TRID timeline")
  }

  return data
}

export async function updateTRIDMilestoneService(params: {
  transactionId: string
  milestone: string
  date: string
}) {
  const supabase = await createClient()

  const updateData: any = {}
  updateData[params.milestone] = params.date

  const { error } = await supabase
    .from("trid_timeline")
    .update(updateData)
    .eq("transaction_id", params.transactionId)

  if (error) {
    console.error("[ComplianceMonitoring] Error updating TRID milestone:", error)
    throw new Error("Failed to update TRID milestone")
  }

  await monitorTRIDComplianceService(params.transactionId)

  revalidatePath(`/transactions/${params.transactionId}`)
  return { success: true }
}

// ============================================
// DOCUMENT RETENTION
// ============================================

export async function applyDocumentRetentionService(transactionId: string) {
  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("actual_close_date:close_date, brokerage_id")
    .eq("id", transactionId)
    .single()

  if (!transaction?.actual_close_date) {
    return { success: false, message: "Transaction not closed yet" }
  }

  const closeDate = new Date(transaction.actual_close_date)
  const retentionYears = 7
  const deleteAfterDate = new Date(closeDate)
  deleteAfterDate.setFullYear(deleteAfterDate.getFullYear() + retentionYears)

  const { data: documents } = await supabase
    .from("client_documents")
    .select("id, document_type")
    .eq("transaction_id", transactionId)

  for (const doc of documents || []) {
    await supabase.from("document_retention").upsert(
      {
        document_id: doc.id,
        retention_category: "transaction",
        retention_years: retentionYears,
        transaction_close_date: transaction.actual_close_date,
        delete_after_date: deleteAfterDate.toISOString().split("T")[0],
        // Tenant anchor — RLS on document_retention gates SELECT/UPDATE on
        // has_brokerage_access(brokerage_id), so rows must carry it to be readable.
        brokerage_id: transaction.brokerage_id,
      },
      { onConflict: "document_id" },
    )
  }

  return { success: true, documents_processed: documents?.length || 0 }
}

// ============================================
// AUDIT TRAIL
// ============================================

export async function exportAuditTrailService(params: {
  transactionId?: string
  startDate: string
  endDate: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("audit_log")
    .select("*")
    .gte("created_at", params.startDate)
    .lte("created_at", params.endDate)
    .order("created_at", { ascending: false })

  if (params.transactionId) {
    query = query.eq("entity_type", "transaction").eq("entity_id", params.transactionId)
  }

  const { data: logs, error } = await query

  // An audit-trail EXPORT that silently returns zero rows is worse than one
  // that fails: the empty file is the artifact someone files as evidence.
  if (error) {
    return { logs: [], count: 0, error: `Audit trail could not be read: ${error.message}` }
  }

  return { logs: logs || [], count: logs?.length || 0, error: null as string | null }
}

// ============================================
// CONTENT COMPLIANCE
// ============================================

export type ProhibitedPhraseRow = {
  phrase: string
  phrase_pattern?: string | null
  category?: string | null
  severity?: string | null
  suggested_alternative?: string | null
}

// TWO VOCABULARIES MEET HERE, AND THEY DO NOT INTERSECT ON THE VALUE THAT
// DECIDES PASS/FAIL. Normalise at this boundary or the gate silently passes.
//
//   the COLUMN stores  {info, warning, critical}
//     — the live CHECK, and exactly what scripts/check-vocabularies.ts:1190
//       declares for prohibited_phrases.severity.
//   scanContentComplianceService grades {info, warning, blocking}
//     — its own literals for the three non-DB issue types, and `passed` is
//       computed as `issues.filter(i => i.severity === "blocking").length === 0`.
//
// So a stored 'critical' row pushed through unmapped lands in `issues` but is
// invisible to that filter, and `passed` comes back TRUE with a Fair Housing
// violation sitting in the list. Seeding the catalogue (m450) without this
// mapping would have fixed nothing — the scan would find the phrase and still
// clear the content.
//
// 'critical' is the CHECK's severest value and is what m450 stores for the 17
// phrases the authored catalogue marked "blocking", so it maps to blocking
// here. Anything else passes through unchanged.
export const DB_SEVERITY_TO_ISSUE_GRADE: Record<string, string> = { critical: "blocking" }

/**
 * The prohibited-phrase scan, as a pure function over rows the caller has
 * already read. Extracted from scanContentComplianceService so the Fair Housing
 * gate can be exercised against the REAL seeded catalogue without a session —
 * see scripts/fair-housing-phrase-gate-simulator.ts. The service calls this; the
 * two do not carry separate copies of the logic.
 *
 * A malformed stored pattern throws out of `new RegExp` and aborts the whole
 * scan. That is deliberate and is left as-is: a scan that cannot compile its own
 * catalogue must fail loudly, not skip the phrase and report the content clean.
 */
export function scanForProhibitedPhrases(phrases: ProhibitedPhraseRow[], contentBody: string) {
  const found: any[] = []
  for (const phrase of phrases) {
    const regex = new RegExp(phrase.phrase_pattern || phrase.phrase, "gi")
    if (regex.test(contentBody)) {
      found.push({
        type: "prohibited_phrase",
        category: phrase.category,
        severity: DB_SEVERITY_TO_ISSUE_GRADE[phrase.severity as string] ?? phrase.severity,
        found: phrase.phrase,
        suggestedAlternative: phrase.suggested_alternative,
        location: "content_body",
      })
    }
  }
  return found
}

export async function scanContentComplianceService(content: {
  contentBody: string
  contentType: string
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  const supabase = await createClient()

  const issues: any[] = []
  const warnings: any[] = []

  // A COMPLIANCE SCAN THAT COULD NOT READ ITS CATALOGUE IS NOT A CLEAN SCAN.
  //
  // supabase-js RESOLVES a failed query: without destructuring `error`, a
  // permission denial arrives here as `data: null` and the loop below reads it
  // as "no prohibited phrases found" — the caller then stores the content with
  // status "pending" (see submitContentForApprovalService), i.e. APPROVED. The
  // same is true of a genuinely empty table, which is how this gate spent its
  // whole life: prohibited_phrases held zero rows until m450 seeded it, so every
  // piece of listing and marketing copy ever scanned came back passed:true.
  //
  // Both cases fail CLOSED now. m450 guarantees the rows exist and m451 asserts
  // it in the database, so neither branch fires in normal operation — but if one
  // ever does, the scan says so instead of quietly clearing the content.
  const { data: prohibitedPhrases, error: phrasesError } = await supabase
    .from("prohibited_phrases")
    .select("*")
    // ORDERING IS A CAPABILITY, NOT A DETAIL. The deleted
    // lib/seed-compliance-rules.ts:getProhibitedPhrases ordered by category, and
    // nothing that replaced it did — so issues surfaced in physical row order on
    // submit-content-form.tsx and pending-approvals-list.tsx, meaning an agent's
    // fair_housing violation could sit below a them_first nitpick. Restored here,
    // with `phrase` as a deterministic tiebreak so the same content always
    // produces the same report. NOTE: no .eq("brokerage_id", …) — m454 unions the
    // federal catalogue with this tenant's own words through RLS, and a filter
    // here would hide all 25 federal phrases (NULL = <uuid> is never true).
    .eq("is_active", true)
    .order("category", { ascending: true })
    .order("phrase", { ascending: true })

  if (phrasesError) {
    throw new Error(
      `Compliance scan could not read the prohibited-phrase catalogue: ${phrasesError.message}. ` +
        "Refusing to report content as compliant against a catalogue that was never read.",
    )
  }
  if (!prohibitedPhrases || prohibitedPhrases.length === 0) {
    throw new Error(
      "Compliance scan aborted: the prohibited-phrase catalogue holds no active phrases, so the " +
        "Fair Housing scan would pass every piece of content. Apply the phrase-catalogue migration " +
        "(supabase/migrations/m450-*) before scanning content.",
    )
  }

  issues.push(...scanForProhibitedPhrases(prohibitedPhrases, content.contentBody))

  if (content.targetAudience === "cold_lead") {
    const allowedChannels = ["email", "print"]
    const invalidChannels = content.distributionChannels.filter((ch) => !allowedChannels.includes(ch))
    if (invalidChannels.length > 0) {
      issues.push({
        type: "channel_violation",
        category: "cold_lead_restriction",
        severity: "blocking",
        message: `Cold leads can only receive email or print mail. Invalid channels: ${invalidChannels.join(", ")}`,
        invalidChannels,
      })
    }
  }

  const { data: requiredDisclosures } = await supabase
    .from("required_disclosures")
    .select("*")
    .eq("is_active", true)

  for (const disclosure of requiredDisclosures || []) {
    const stateMatches =
      !disclosure.required_for_states || disclosure.required_for_states.includes(content.agentState)
    const channelMatch = disclosure.required_for_channels?.some((ch: string) =>
      content.distributionChannels.includes(ch),
    )
    if (stateMatches && channelMatch && !content.contentBody.includes(disclosure.disclosure_text)) {
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: disclosure.disclosure_type,
        requiredText: disclosure.disclosure_text,
        placement: disclosure.placement_requirement,
      })
    }
  }

  // ── TENANT IDENTITY DISCLOSURES — brokerage name + licence number ──────────
  //
  // These two are required disclosures, but they are NOT catalogue rows and
  // never could be. `required_disclosures` is checked with a LITERAL substring
  // test (`contentBody.includes(disclosure_text)`), and the authored catalogue
  // carried two rows whose "text" was a LABEL, not a disclosure:
  //
  //   brokerage_name  → "Brokerage Name Required"
  //   license_number  → "Licensed Real Estate Agent"
  //
  // No real advertisement contains either string, so both would have warned on
  // 100% of content forever while never once checking the thing they name. m452
  // left them out of the seed on purpose. The requirement is real — the VALUE is
  // per-tenant and per-agent, and it lives in the user's own settings — so it is
  // checked here, against the tenant's actual recorded identity.
  //
  // IDENTITY COMES FROM THE SESSION. Not from an argument: a caller-supplied
  // brokerage or agent id would let content be graded against someone else's
  // licence number.
  const { data: { user: scanUser }, error: scanUserError } = await supabase.auth.getUser()
  const identity = await resolveBrokerageComplianceIdentity(supabase, scanUser?.id ?? null)
  if (!scanUser) {
    // No session means no tenant, which means there is nothing to check the
    // content against. Every caller of this service is a server action that has
    // one; if that ever stops being true the scan says so rather than reporting
    // two unchecked requirements as merely "unset".
    identity.unreadable.push(
      scanUserError
        ? `signed-in user (${scanUserError.message})`
        : "no signed-in user — the brokerage and agent identity could not be resolved",
    )
  }

  // Case-insensitive, whitespace-collapsed containment for names.
  const haystackText = content.contentBody.toLowerCase().replace(/\s+/g, " ")
  const namePresent = (value: string | null) => {
    if (!value) return false
    const needle = value.toLowerCase().replace(/\s+/g, " ").trim()
    // A one-character "name" would match nearly any text — that is a data
    // problem, not a compliant advertisement, so it never counts as satisfied.
    return needle.length >= 2 && haystackText.includes(needle)
  }

  // Licence numbers are written a dozen ways in real copy — "FL-SL3456789",
  // "Lic #FL SL3456789", "License No. FLSL3456789". Compare on alphanumerics
  // only so formatting never decides compliance.
  const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
  const haystackAlnum = alnum(content.contentBody)
  const licensePresent = (value: string | null) => {
    if (!value) return false
    const needle = alnum(value)
    return needle.length >= 3 && haystackAlnum.includes(needle)
  }

  // A READ THAT FAILED IS NOT AN EMPTY RECORD. supabase-js resolves a denial as
  // `data: null`; the resolver reports those separately so this never grades a
  // permission error as "the brokerage has no licence".
  if (identity.unreadable.length > 0) {
    warnings.push({
      type: "missing_disclosure",
      severity: "warning",
      disclosureType: "identity_unverifiable",
      message:
        `The brokerage-name and license-number disclosures could not be checked: ` +
        `${identity.unreadable.join("; ")}. This content has NOT been checked against ` +
        `either requirement — treat both as unverified, not as satisfied.`,
      placement: "footer",
    })
  } else {
    // ── Brokerage name ──────────────────────────────────────────────────────
    // The DBA satisfies it too: a brokerage advertising under its registered
    // trade name is identified. This matches the rendered attribution band,
    // which prefers DBA → legal name (lib/ai/image-generation.ts).
    const brokerageNames = [identity.brokerageName, identity.brokerageDba].filter(Boolean) as string[]
    if (brokerageNames.length === 0) {
      // THE CHECK CANNOT RUN. Say so — do not skip, and do not call it passed.
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: "brokerage_name",
        message:
          "No brokerage name is recorded for your account, so this content could not be checked " +
          "for the required brokerage identification. Add the brokerage's legal name (and DBA, if " +
          "it advertises under one) on the brokerage record — Superadmin → Brokerages " +
          "(/dashboard/superadmin/brokerages) — or ask your broker or platform admin to.",
        placement: "footer",
      })
    } else if (!brokerageNames.some(namePresent)) {
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: "brokerage_name",
        requiredText: identity.brokerageDba ?? identity.brokerageName,
        message:
          `This content does not identify the brokerage. Advertising must name ` +
          `"${identity.brokerageDba ?? identity.brokerageName}".`,
        placement: "footer",
      })
    }

    // ── Licence number ──────────────────────────────────────────────────────
    // EITHER licence satisfies it. That is the distinction the rendered
    // attribution band already draws: it prints the brokerage licence, and adds
    // the agent's own only when it differs. Many states accept either on an
    // advertisement, so requiring both here would fail compliant copy.
    const licenses = [identity.agentLicense, identity.brokerageLicense].filter(Boolean) as string[]
    if (licenses.length === 0) {
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: "license_number",
        message:
          "No license number is recorded — neither yours nor your brokerage's — so this content " +
          "could not be checked for the required license disclosure. Set your own license number " +
          "and state on My Profile (/dashboard/profile); it then shows under Settings → License & CE. " +
          "The brokerage license is set on the brokerage record by your broker or platform admin.",
        placement: "footer",
      })
    } else if (!licenses.some(licensePresent)) {
      const shown = identity.agentLicense ?? identity.brokerageLicense
      const state = identity.agentLicense
        ? identity.agentLicenseState
        : identity.brokerageLicenseState
      warnings.push({
        type: "missing_disclosure",
        severity: "warning",
        disclosureType: "license_number",
        requiredText: state ? `Lic #${shown} (${state})` : `Lic #${shown}`,
        message:
          `This content does not carry a license number. Include your license (#${shown}) ` +
          `or your brokerage's.`,
        placement: "footer",
      })
    }
  }

  const selfReferentialTerms = [
    "I can", "I will", "my service", "my expertise", "hire me", "I am the best", "I specialize",
  ]
  const themFirstTerms = [
    "you deserve", "your goals", "your needs", "for you", "help you", "your family", "your future",
  ]

  const selfCount = selfReferentialTerms.filter((term) =>
    new RegExp(term, "gi").test(content.contentBody),
  ).length
  const themCount = themFirstTerms.filter((term) =>
    new RegExp(term, "gi").test(content.contentBody),
  ).length

  if (selfCount > themCount) {
    warnings.push({
      type: "them_first_violation",
      severity: "info",
      message: 'Content appears to be agent-focused rather than client-focused. Consider rewriting with "them-first" philosophy.',
      selfReferentialCount: selfCount,
      clientFocusedCount: themCount,
    })
  }

  return {
    passed: issues.filter((i) => i.severity === "blocking").length === 0,
    issues,
    warnings,
    score: Math.max(0, 100 - issues.length * 20 - warnings.length * 5),
  }
}

export async function submitContentForApprovalService(data: {
  userId: string
  agentId?: string
  contentType: string
  contentTitle: string
  contentBody: string
  contentMetadata?: any
  targetAudience: string
  distributionChannels: string[]
  agentState: string
}) {
  const supabase = await createClient()

  const scanResults = await scanContentComplianceService({
    contentBody: data.contentBody,
    contentType: data.contentType,
    targetAudience: data.targetAudience,
    distributionChannels: data.distributionChannels,
    agentState: data.agentState,
  })

  // Resolve the submitting user's brokerage — the column is brokerage_id, NOT the
  // user id. (Previously stored data.userId here, corrupting tenant scoping.)
  const { data: submitterRow } = await supabase
    .from("users").select("brokerage_id").eq("id", data.userId).maybeSingle()

  const { data: approval, error } = await supabase
    .from("activities")
    .insert({
      brokerage_id: submitterRow?.brokerage_id ?? null,
      agent_user_id: data.userId,
      activity_type: "content.approval",
      entity_type: "content",
      entity_id: crypto.randomUUID(),
      title: data.contentTitle,
      description: data.contentBody,
      status: scanResults.passed ? "pending" : "needs_revision",
      metadata: {
        content_type: data.contentType,
        content_metadata: data.contentMetadata,
        target_audience: data.targetAudience,
        distribution_channels: data.distributionChannels,
        compliance_issues: scanResults.issues,
        auto_scan_results: scanResults,
        agent_id: data.agentId,
      },
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/compliance")
  return approval
}

export async function reviewContentApprovalService(data: {
  approvalId: string
  reviewerId: string
  status: "approved" | "rejected" | "needs_revision"
  reviewNotes?: string
  expiresInDays?: number
}) {
  const supabase = await createClient()

  const updateData: any = {
    status: data.status,
    completed_at: new Date().toISOString(),
    metadata: {},
  }

  const { data: existingActivity } = await supabase
    .from("activities")
    .select("metadata")
    .eq("id", data.approvalId)
    .single()

  if (existingActivity) {
    updateData.metadata = {
      ...existingActivity.metadata,
      reviewed_by: data.reviewerId,
      reviewed_at: new Date().toISOString(),
      review_notes: data.reviewNotes,
    }

    if (data.status === "approved") {
      updateData.metadata.approved_at = new Date().toISOString()
      if (data.expiresInDays) {
        const expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + data.expiresInDays)
        updateData.metadata.expires_at = expiresAt.toISOString()
      }
    }
  }

  const { error } = await supabase
    .from("activities")
    .update(updateData)
    .eq("id", data.approvalId)

  if (error) throw error

  if (data.status === "approved") {
    const { data: approval } = await supabase
      .from("activities")
      .select("*")
      .eq("id", data.approvalId)
      .single()

    if (approval && approval.metadata) {
      await supabase.from("approved_content_library").insert({
        approval_id: approval.id,
        content_category: approval.metadata.content_type,
        content_template: approval.description,
        allowed_channels: approval.metadata.distribution_channels,
        allowed_lead_types: [approval.metadata.target_audience],
        created_by: approval.brokerage_id,
      })
    }
  }

  revalidatePath("/dashboard/compliance")
  return { success: true }
}

export async function logCommunicationWithComplianceService(data: {
  userId: string
  agentId?: string
  contactId?: string
  leadId?: string
  communicationType: string
  leadTemperature: string
  contentId?: string
  contentSnapshot: string
  sentVia?: string
}) {
  const supabase = await createClient()

  // Resolve brokerage from the acting user so audit rows are tenant-scoped.
  const { data: logUser } = await supabase
    .from("users").select("brokerage_id").eq("id", data.userId).maybeSingle()
  const logBrokerageId: string | null = logUser?.brokerage_id ?? null

  let complianceCheck = { passed: true, warnings: [] as any[] }

  if (data.leadTemperature === "cold" && !["email", "print"].includes(data.communicationType)) {
    complianceCheck = {
      passed: false,
      warnings: [
        {
          type: "channel_violation",
          message: "Cold leads can only be contacted via email or print mail",
        },
      ],
    }

    await supabase.from("compliance_flags").insert({
      brokerage_id: logBrokerageId,
      user_id: data.userId,
      agent_id: data.agentId,
      contact_id: data.contactId ?? null,
      content_type: data.communicationType,
      violation_type: "cold_lead_channel_violation",
      flagged_content: {
        channel_used: data.communicationType,
        lead_temperature: data.leadTemperature,
        allowed_channels: ["email", "print"],
      },
      severity: "high",
      status: "flagged",
      detected_at: new Date().toISOString(),
    })
  }

  const { data: log, error } = await supabase
    .from("communication_audit_log")
    .insert({
      brokerage_id: logBrokerageId,
      user_id: data.userId,
      agent_id: data.agentId,
      contact_id: data.contactId,
      lead_id: data.leadId,
      communication_type: data.communicationType,
      lead_temperature: data.leadTemperature,
      was_approved_content: !!data.contentId,
      channel: data.sentVia,
      body_snippet: data.contentSnapshot?.slice(0, 500),
      compliance_passed: complianceCheck.passed,
      sent_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error("[ComplianceMonitoring] Error logging communication:", error)
    throw error
  }

  return { success: true, compliancePassed: complianceCheck.passed, log }
}

export async function getApprovedContentLibraryService(filters?: {
  category?: string
  channel?: string
  leadType?: string
}) {
  const supabase = await createClient()

  let query = supabase
    .from("approved_content_library")
    .select("*, activities(*)")
    .eq("is_active", true)

  if (filters?.category) {
    query = query.eq("content_category", filters.category)
  }

  if (filters?.channel) {
    query = query.contains("allowed_channels", [filters.channel])
  }

  if (filters?.leadType) {
    query = query.contains("allowed_lead_types", [filters.leadType])
  }

  const { data, error } = await query.order("created_at", { ascending: false })

  if (error) {
    console.error("[ComplianceMonitoring] Error fetching approved content:", error)
    return []
  }

  return data || []
}

export async function getPendingApprovalsService() {
  const supabase = await createClient()

  // Resolve brokerage_id from session — never trust caller-supplied value
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userData?.brokerage_id
  if (!brokerageId) return []

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("activity_type", "content.approval")
    .eq("brokerage_id", brokerageId)
    .in("status", ["pending", "needs_revision"])
    .order("created_at", { ascending: true })

  if (error) {
    console.error("[ComplianceMonitoring] Error fetching pending approvals:", error)
    return []
  }

  return data || []
}

export async function getComplianceViolationsService(agentId?: string, userId?: string) {
  const supabase = await createClient()

  // Resolve brokerage_id from session — never trust caller-supplied value
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const brokerageId = userData?.brokerage_id
  if (!brokerageId) return []

  let query = supabase
    .from("compliance_flags")
    .select(`*, users (id, first_name, last_name, email)`)
    .eq("brokerage_id", brokerageId)
    .order("detected_at", { ascending: false })

  if (agentId) {
    query = query.eq("agent_id", agentId)
  }

  if (userId) {
    query = query.eq("user_id", userId)
  }

  const { data, error } = await query.limit(100)

  if (error) {
    console.error("[ComplianceMonitoring] Error fetching compliance violations:", error)
    return []
  }

  return data || []
}

export async function generateComplianceReportService(filters: {
  startDate: string
  endDate: string
  agentId?: string
  userId?: string
}) {
  const supabase = await createClient()

  let logsQuery = supabase
    .from("communication_audit_log")
    .select("*")
    .gte("sent_at", filters.startDate)
    .lte("sent_at", filters.endDate)

  if (filters.agentId) logsQuery = logsQuery.eq("agent_id", filters.agentId)
  if (filters.userId)  logsQuery = logsQuery.eq("user_id", filters.userId)

  // supabase-js RESOLVES a failed query with { data: null, error }. Both reads
  // below used to drop the error, so an unreadable communication_audit_log or
  // compliance_flags produced "0 communications, 0 violations" — which this
  // report then presents as a clean brokerage. A compliance report that cannot
  // read its sources must say so; silence here is the most dangerous kind.
  const { data: logs, error: logsError } = await logsQuery

  let violationsQuery = supabase
    .from("compliance_flags")
    .select("*")
    .gte("detected_at", filters.startDate)
    .lte("detected_at", filters.endDate)

  if (filters.agentId) violationsQuery = violationsQuery.eq("agent_id", filters.agentId)
  if (filters.userId)  violationsQuery = violationsQuery.eq("user_id", filters.userId)

  const { data: violations, error: violationsError } = await violationsQuery

  const unreadable = [
    logsError ? `communications (${logsError.message})` : null,
    violationsError ? `violations (${violationsError.message})` : null,
  ].filter(Boolean) as string[]

  return {
    /**
     * Non-empty when a source could not be read. Every count below is then a
     * FLOOR over whatever did load, not a finding — render this before them.
     */
    unreadableSources: unreadable,
    totalCommunications: logs?.length || 0,
    compliantCommunications: logs?.filter((l) => l.compliance_check_passed).length || 0,
    totalViolations: violations?.length || 0,
    criticalViolations: violations?.filter((v) => v.severity === "critical").length || 0,
    violationsByType:
      violations?.reduce((acc: Record<string, number>, v) => {
        acc[v.violation_type] = (acc[v.violation_type] || 0) + 1
        return acc
      }, {} as Record<string, number>) || {},
    communicationsByChannel:
      logs?.reduce((acc: Record<string, number>, l) => {
        acc[l.communication_type] = (acc[l.communication_type] || 0) + 1
        return acc
      }, {} as Record<string, number>) || {},
    // `?? true` here asserted cold-lead channel compliance from a null read —
    // an unreadable log claimed a clean record. null means "not established".
    coldLeadChannelCompliance: logsError
      ? null
      : (logs
          ?.filter((l) => l.lead_temperature === "cold")
          .every((l) => ["email", "print"].includes(l.communication_type)) ?? true),
  }
}
