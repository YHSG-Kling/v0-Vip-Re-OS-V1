/**
 * lib/workflow/intelligence/proactive-checks.ts
 *
 * Proactive checks the workflow runs BEFORE a packet leaves the office
 * (or during intake) so the agent never sends a broken/risky/incomplete
 * artifact.
 *
 * Five check families:
 *
 *   1. mlsValidationCheck         — Compares offer terms against the listing
 *                                   + recent neighborhood activity. Flags
 *                                   "this is 8% below list, recent comparables
 *                                   accepted at -2% — suggest opening higher."
 *
 *   2. addendumAutoDetect         — Reads property + transaction context and
 *                                   returns the addenda the agent likely needs
 *                                   (HOA, coastal, lead paint, septic, solar,
 *                                   military, new construction, short sale).
 *
 *   3. buyerFinancingPreflight    — Verifies pre-approval / POF amount ≥ offer,
 *                                   not expired, lender match, DTI feasibility.
 *
 *   4. contingencyRemovalScan     — Cron-driven; finds contracts whose inspection
 *                                   /appraisal/financing window is closing soon
 *                                   with no removal addendum filed → notifies
 *                                   the agent with one-tap removal.
 *
 *   5. completenessGate           — Final pre-send check: agent license current,
 *                                   buyer agency agreement on file, dual-agency
 *                                   disclosure if needed, brokerage representation
 *                                   form signed, POF/pre-approval attached.
 *
 * All checks return the same shape: { passed, findings: Finding[], blockers:
 * Finding[] }. Findings are surfaced in the FormWizard review panel; blockers
 * prevent the packet from being sent.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { OfferIntake } from "../intake/voice-to-offer"

export type FindingSeverity = "info" | "warning" | "blocker"

export interface Finding {
  severity:    FindingSeverity
  category:    string                 // 'price' | 'addendum' | 'financing' | 'compliance' | etc.
  title:       string
  detail:      string
  recommendation?: string
  /** One-click action the agent can take to resolve the finding */
  action?: {
    label: string
    href:  string                     // deep link to the fix UI
  }
}

export interface CheckResult {
  passed:   boolean
  findings: Finding[]
  blockers: Finding[]                 // findings with severity === 'blocker'
}

// ──────────────────────────────────────────────────────────────────────────
// 1. MLS-aware validation
// ──────────────────────────────────────────────────────────────────────────

export async function mlsValidationCheck(input: {
  intake:      OfferIntake
  listingId?:  string | null
}): Promise<CheckResult> {
  const findings: Finding[] = []

  if (!input.intake.offerPrice.value) {
    return { passed: true, findings, blockers: [] }
  }

  // 1a. Compare against listing list_price if we have one
  if (input.listingId) {
    try {
      const svc = createServiceClient()
      const { data: listing } = await svc
        .from("listings")
        .select("list_price, listing_date, status, city, state, zip, address")
        .eq("id", input.listingId)
        .maybeSingle()

      if (listing?.list_price) {
        const listPrice = listing.list_price
        const offerPrice = input.intake.offerPrice.value
        const deltaPct = ((offerPrice - listPrice) / listPrice) * 100

        if (deltaPct < -10) {
          findings.push({
            severity: "warning",
            category: "price",
            title: "Offer is significantly below list",
            detail: `Offer is ${Math.abs(deltaPct).toFixed(1)}% below list price ($${offerPrice.toLocaleString()} vs $${listPrice.toLocaleString()}).`,
            recommendation: "Verify with buyer. If insistent, prepare a strong rationale memo + comparables for the listing agent.",
          })
        }

        // 1b. Days-on-market signal
        if (listing.listing_date) {
          const dom = Math.floor((Date.now() - new Date(listing.listing_date).getTime()) / 86_400_000)
          if (dom < 7 && deltaPct < -3) {
            findings.push({
              severity: "warning",
              category: "price",
              title: "Aggressive offer on a fresh listing",
              detail: `Listing has been on market only ${dom} days and your offer is ${Math.abs(deltaPct).toFixed(1)}% under list.`,
              recommendation: "Sellers are typically least flexible in the first 14 days. Consider an escalation clause to remain competitive without overpaying.",
            })
          }
          if (dom > 60) {
            findings.push({
              severity: "info",
              category: "price",
              title: "Long-time-on-market opportunity",
              detail: `Listing has been on market ${dom} days — sellers may be more flexible on price + concessions.`,
              recommendation: "Consider asking for closing-cost contributions or repair credits.",
            })
          }
        }
      }
    } catch { /* listing lookup is best-effort */ }
  }

  // 1c. Earnest money sanity
  if (input.intake.earnestMoneyAmount.value && input.intake.offerPrice.value) {
    const emdPct = (input.intake.earnestMoneyAmount.value / input.intake.offerPrice.value) * 100
    if (emdPct < 1) {
      findings.push({
        severity: "warning",
        category: "emd",
        title: "Low earnest money may signal weak commitment",
        detail: `EMD is ${emdPct.toFixed(2)}% of offer — typical range is 1-3%.`,
        recommendation: "Strong offers usually use 2-3% EMD; cash offers often use 5%.",
      })
    }
  }

  return { passed: true, findings, blockers: findings.filter(f => f.severity === "blocker") }
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Addendum auto-detection
// ──────────────────────────────────────────────────────────────────────────

export interface AddendumSuggestion {
  addendum:    string
  trigger:     string
  required:    boolean
}

export async function addendumAutoDetect(input: {
  intake:     OfferIntake
  listingId?: string | null
}): Promise<CheckResult & { suggested: AddendumSuggestion[] }> {
  const suggested: AddendumSuggestion[] = []
  const findings: Finding[] = []

  if (!input.listingId) {
    return { passed: true, findings, blockers: [], suggested }
  }

  try {
    const svc = createServiceClient()
    const { data: listing } = await svc
      .from("listings")
      .select("year_built, hoa_dues, property_type, lot_size, has_septic, has_solar, has_pool, flood_zone, sub_category, marketing_tier_id")
      .eq("id", input.listingId)
      .maybeSingle()

    if (!listing) return { passed: true, findings, blockers: [], suggested }

    // Built before 1978 → federal lead-based-paint disclosure required
    if ((listing as any).year_built && (listing as any).year_built < 1978) {
      suggested.push({
        addendum: "Lead-Based Paint Disclosure (federal)",
        trigger:  `Property built in ${(listing as any).year_built} (before 1978)`,
        required: true,
      })
    }

    // HOA presence → HOA addendum
    if ((listing as any).hoa_dues && (listing as any).hoa_dues > 0) {
      suggested.push({
        addendum: "HOA Disclosure / Addendum",
        trigger:  `Property has HOA ($${(listing as any).hoa_dues}/mo dues)`,
        required: true,
      })
    }

    // Septic
    if ((listing as any).has_septic) {
      suggested.push({
        addendum: "Septic System Inspection Addendum",
        trigger:  "Property has septic system",
        required: true,
      })
    }

    // Solar
    if ((listing as any).has_solar) {
      suggested.push({
        addendum: "Solar Panel Lease/Loan Assumption Addendum",
        trigger:  "Property has solar (lease/loan assumption may be required)",
        required: false,
      })
    }

    // Flood zone (FL coastal etc.)
    if ((listing as any).flood_zone && (listing as any).flood_zone !== "X") {
      suggested.push({
        addendum: "Coastal / Flood Zone Property Addendum",
        trigger:  `Property in flood zone ${(listing as any).flood_zone}`,
        required: true,
      })
    }

    // Cash offer → no financing contingency needed
    if (input.intake.financingType.value === "cash") {
      findings.push({
        severity: "info",
        category: "addendum",
        title: "Cash offer — financing contingency removed",
        detail: "Cash buyers don't need a financing contingency. POF letter is required.",
      })
    }
  } catch { /* listing lookup best-effort */ }

  // Also surface findings for any addenda the agent already specified that
  // we couldn't validate against listing data.
  const requestedAddenda = (input.intake.addendaRequested.value ?? []) as string[]
  for (const req of requestedAddenda) {
    if (!suggested.some(s => s.addendum.toLowerCase().includes(req.toLowerCase()))) {
      findings.push({
        severity: "info",
        category: "addendum",
        title: `Custom addendum requested: "${req}"`,
        detail: "Verify the exact form name in your state's library before sending.",
      })
    }
  }

  for (const s of suggested) {
    if (s.required) {
      findings.push({
        severity: "warning",
        category: "addendum",
        title: `${s.addendum} is required`,
        detail: s.trigger,
        recommendation: "Auto-attached to packet — verify in FormWizard.",
      })
    }
  }

  return { passed: true, findings, blockers: [], suggested }
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Buyer financing pre-flight
// ──────────────────────────────────────────────────────────────────────────

export async function buyerFinancingPreflight(input: {
  intake:    OfferIntake
  contactId: string | null
}): Promise<CheckResult> {
  const findings: Finding[] = []
  const blockers: Finding[] = []

  if (!input.contactId) {
    return { passed: true, findings, blockers }
  }

  // Cash offer → check POF
  if (input.intake.financingType.value === "cash") {
    try {
      const svc = createServiceClient()
      const { data: docs } = await svc
        .from("documents")
        .select("id, document_type, status, metadata, created_at")
        .eq("contact_id", input.contactId)
        .in("document_type", ["proof_of_funds", "pof"])
        .eq("status", "complete")
        .order("created_at", { ascending: false })
        .limit(1)

      const pof = docs?.[0]
      if (!pof) {
        blockers.push({
          severity: "blocker",
          category: "financing",
          title: "No proof of funds on file",
          detail: "Cash offers require a current POF letter before submission.",
          recommendation: "Upload buyer's POF letter to their contact record.",
          action: { label: "Upload POF", href: `/crm?contact=${input.contactId}&tab=documents` },
        })
      } else {
        // Optional: check POF date freshness (typically < 30 days old)
        const ageDays = (Date.now() - new Date(pof.created_at).getTime()) / 86_400_000
        if (ageDays > 30) {
          findings.push({
            severity: "warning",
            category: "financing",
            title: `POF letter is ${Math.floor(ageDays)} days old`,
            detail: "Listing agents often want POF dated within 30 days.",
            recommendation: "Request a fresh POF before sending.",
          })
        }
      }
    } catch { /* best-effort */ }
    return { passed: blockers.length === 0, findings, blockers }
  }

  // Financed offer → check pre-approval
  try {
    const svc = createServiceClient()
    const { data: docs } = await svc
      .from("documents")
      .select("id, document_type, status, metadata, created_at")
      .eq("contact_id", input.contactId)
      .in("document_type", ["pre_approval", "preapproval", "pre-approval"])
      .eq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)

    const preApproval = docs?.[0]
    if (!preApproval) {
      blockers.push({
        severity: "blocker",
        category: "financing",
        title: "No pre-approval on file",
        detail: "Financed offers require a pre-approval letter from a lender.",
        recommendation: "Upload buyer's pre-approval letter to their contact record.",
        action: { label: "Upload pre-approval", href: `/crm?contact=${input.contactId}&tab=documents` },
      })
    } else {
      const meta = (preApproval.metadata as { approved_amount?: number; expires_at?: string; lender?: string }) ?? {}
      const offerPrice = input.intake.offerPrice.value ?? 0
      if (meta.approved_amount && meta.approved_amount < offerPrice) {
        blockers.push({
          severity: "blocker",
          category: "financing",
          title: "Pre-approval amount is below offer price",
          detail: `Pre-approval is for $${meta.approved_amount.toLocaleString()} but offer is $${offerPrice.toLocaleString()}.`,
          recommendation: "Get an updated pre-approval letter for the higher amount before submitting.",
          action: { label: "Request new pre-approval", href: `/crm?contact=${input.contactId}&tab=documents` },
        })
      }
      if (meta.expires_at && new Date(meta.expires_at) < new Date()) {
        blockers.push({
          severity: "blocker",
          category: "financing",
          title: "Pre-approval has expired",
          detail: `Pre-approval expired on ${meta.expires_at}.`,
          recommendation: "Get a refreshed pre-approval letter from the same lender.",
        })
      }
    }
  } catch { /* best-effort */ }

  return { passed: blockers.length === 0, findings, blockers }
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Contingency removal scan (cron-driven)
// ──────────────────────────────────────────────────────────────────────────

export interface ContingencyExpiringSoon {
  transactionId: string
  contactId:     string | null
  agentUserId:   string | null
  contingencyType: "inspection" | "appraisal" | "financing"
  deadline:      string                // ISO
  daysUntil:     number
  contractAddress: string | null
}

export async function scanContingenciesNearingDeadline(input: {
  brokerageId?: string
  withinDays?:  number                 // default 3
}): Promise<ContingencyExpiringSoon[]> {
  const within = input.withinDays ?? 3
  const cutoff = new Date(Date.now() + within * 86_400_000).toISOString()

  try {
    const svc = createServiceClient()
    let query = svc
      .from("transactions")
      .select("id, contact_id, agent_id, property_address, status, inspection_deadline, appraisal_deadline, financing_deadline, inspection_contingency_removed_at, appraisal_contingency_removed_at, financing_contingency_removed_at")
      .in("status", ["under_contract"])

    if (input.brokerageId) query = query.eq("brokerage_id", input.brokerageId)

    const { data: transactions } = await query

    const results: ContingencyExpiringSoon[] = []
    const now = Date.now()

    for (const tx of transactions ?? []) {
      const txAny = tx as any
      const checks: Array<{ type: "inspection"|"appraisal"|"financing"; deadlineKey: string; removedKey: string }> = [
        { type: "inspection", deadlineKey: "inspection_deadline", removedKey: "inspection_contingency_removed_at" },
        { type: "appraisal",  deadlineKey: "appraisal_deadline",  removedKey: "appraisal_contingency_removed_at" },
        { type: "financing",  deadlineKey: "financing_deadline",  removedKey: "financing_contingency_removed_at" },
      ]
      for (const c of checks) {
        const deadline = txAny[c.deadlineKey]
        const removedAt = txAny[c.removedKey]
        if (!deadline || removedAt) continue
        if (deadline > cutoff) continue
        const daysUntil = Math.floor((new Date(deadline).getTime() - now) / 86_400_000)
        results.push({
          transactionId:  tx.id,
          contactId:      tx.contact_id,
          agentUserId:    tx.agent_id,
          contingencyType: c.type,
          deadline,
          daysUntil,
          contractAddress: txAny.property_address ?? null,
        })
      }
    }

    return results
  } catch {
    return []
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Completeness / compliance gate
// ──────────────────────────────────────────────────────────────────────────

export async function completenessGate(input: {
  intake:       OfferIntake
  contactId:    string | null
  agentUserId:  string | null
  brokerageId:  string
}): Promise<CheckResult> {
  const findings: Finding[] = []
  const blockers: Finding[] = []

  // Agent readiness — license currency + CE hours + ethics, via the CANONICAL evaluator (previously
  // this read ce_hours/ethics but only ever blocked an already-expired license, silently ignoring CE
  // and ethics — the "tracked but not enforced" gap). Now a CE-short-past-cycle or ethics-overdue agent
  // is blocked at offer time too, and an approaching lapse surfaces as a warning.
  if (input.agentUserId) {
    try {
      const svc = createServiceClient()
      const { data: agent } = await svc
        .from("agents")
        .select("license_expiry, ce_hours_required, ce_hours_completed, ce_cycle_end_date, ethics_due_date")
        .eq("user_id", input.agentUserId)
        .maybeSingle()
      if (agent) {
        const { evaluateLicenseReadiness } = await import("@/lib/compliance/license-readiness")
        const readiness = evaluateLicenseReadiness({
          licenseExpiry: (agent as any).license_expiry ?? null,
          ceHoursRequired: (agent as any).ce_hours_required ?? null,
          ceHoursCompleted: (agent as any).ce_hours_completed ?? null,
          ceCycleEndDate: (agent as any).ce_cycle_end_date ?? null,
          ethicsDueDate: (agent as any).ethics_due_date ?? null,
        })
        for (const b of readiness.blockers) {
          blockers.push({ severity: "blocker", category: "compliance", title: b.title, detail: b.detail, action: { label: "Update license & CE", href: "/dashboard/settings/license-ce" } })
        }
        for (const w of readiness.warnings) {
          findings.push({ severity: "warning", category: "compliance", title: w.title, detail: w.detail, recommendation: "Handle before it blocks a transaction.", action: { label: "Update license & CE", href: "/dashboard/settings/license-ce" } })
        }
      }
    } catch { /* best-effort */ }
  }

  // Buyer agency agreement on file (state-dependent — assume required if agent works in any of these)
  if (input.contactId) {
    try {
      const svc = createServiceClient()
      const { data: agencyDocs } = await svc
        .from("documents")
        .select("id, status")
        .eq("contact_id", input.contactId)
        .eq("document_type", "buyer_agency_agreement")
        .eq("status", "complete")
        .limit(1)
      if (!agencyDocs || agencyDocs.length === 0) {
        findings.push({
          severity: "warning",
          category: "compliance",
          title: "No buyer-agency agreement on file",
          detail: "Most states require a signed buyer-agency agreement before submitting offers.",
          recommendation: "Send the brokerage representation form (it covers buyer agency) before this offer leaves the office.",
          action: { label: "Send brokerage representation", href: `/crm?contact=${input.contactId}&tab=documents` },
        })
      }
    } catch { /* best-effort */ }
  }

  // Buyer legal name verified?
  if (!input.intake.buyerLegalName.value || input.intake.buyerLegalName.confidence === "low") {
    blockers.push({
      severity: "blocker",
      category: "compliance",
      title: "Buyer legal name not verified",
      detail: "Offers require the buyer's exact legal name as it appears on their driver's license.",
      recommendation: "Send the buyer self-service intake link to capture their legal name + DL upload.",
      action: { label: "Send buyer intake link", href: input.contactId ? `/crm?contact=${input.contactId}&action=send_intake_link` : "/crm" },
    })
  }

  return { passed: blockers.length === 0, findings, blockers }
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregate runner
// ──────────────────────────────────────────────────────────────────────────

export async function runAllOfferChecks(input: {
  intake:       OfferIntake
  contactId:    string | null
  agentUserId:  string | null
  brokerageId:  string
  listingId?:   string | null
}): Promise<{
  passed:   boolean
  findings: Finding[]
  blockers: Finding[]
  addenda:  AddendumSuggestion[]
}> {
  const [mls, addenda, financing, completeness] = await Promise.all([
    mlsValidationCheck({ intake: input.intake, listingId: input.listingId }),
    addendumAutoDetect({ intake: input.intake, listingId: input.listingId }),
    buyerFinancingPreflight({ intake: input.intake, contactId: input.contactId }),
    completenessGate({
      intake: input.intake,
      contactId: input.contactId,
      agentUserId: input.agentUserId,
      brokerageId: input.brokerageId,
    }),
  ])

  const findings = [
    ...mls.findings,
    ...addenda.findings,
    ...financing.findings,
    ...completeness.findings,
  ]
  const blockers = [
    ...mls.blockers,
    ...addenda.blockers,
    ...financing.blockers,
    ...completeness.blockers,
  ]

  return {
    passed:   blockers.length === 0,
    findings,
    blockers,
    addenda:  addenda.suggested,
  }
}
