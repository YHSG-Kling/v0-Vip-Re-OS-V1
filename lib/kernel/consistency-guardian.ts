// lib/kernel/consistency-guardian.ts
//
// CROSS-CHANNEL CONSISTENCY GUARDIAN (compliance_officer, shine #12) — an
// agent watching every OUTBOUND message that names a price or a listing claim
// and flagging it when it DISAGREES with the live listing before it confuses
// a client or becomes a compliance headache. The OS already gates every
// client message (agent_client_messages) and Fair-Housing-scans the body;
// what nothing did was cross-check the PRICE in a proposed message against
// the listing's LIVE list_price. A stale "$500,000" in a draft after the
// seller cut to $485,000 is exactly the inconsistency this catches.
//
// Deterministic, pure detector (no LLM): extract $ amounts from the body,
// compare to the listing's current price with a tolerance band, flag only a
// MATERIAL mismatch. Honest: no price in the body, or no live price, → no
// finding (never a fabricated flag). Runs over PROPOSED messages so the
// catch happens BEFORE a human releases it — the flag rides the same
// compliance_flags ledger the Compliance Officer already owns.

export const PRICE_TOLERANCE_PCT = 2 // within 2% = rounding/estimate, not a mismatch

/** PURE: pull plausible USD price amounts ($250k, $1.2M, $485,000) from text. */
export function extractPrices(text: string): number[] {
  const out: number[] = []
  const re = /\$\s?([\d,]+(?:\.\d+)?)\s?([kKmM])?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ""))
    if (Number.isNaN(n)) continue
    const suffix = (m[2] ?? "").toLowerCase()
    if (suffix === "k") n *= 1_000
    else if (suffix === "m") n *= 1_000_000
    // Only amounts in a plausible real-estate range are treated as a price.
    if (n >= 10_000 && n <= 100_000_000) out.push(n)
  }
  return out
}

export interface ConsistencyFinding {
  messageId: string
  listingPrice: number
  offendingPrice: number
  deltaPct: number
}

/** PURE: does this body carry a price that MATERIALLY disagrees with the listing? */
export function checkPriceConsistency(
  messageId: string,
  body: string,
  listingPrice: number | null,
): ConsistencyFinding | null {
  if (!listingPrice || listingPrice <= 0) return null
  const prices = extractPrices(body)
  if (prices.length === 0) return null
  // The worst material offender wins the flag.
  let worst: ConsistencyFinding | null = null
  for (const p of prices) {
    const deltaPct = Math.abs((p - listingPrice) / listingPrice) * 100
    if (deltaPct > PRICE_TOLERANCE_PCT && (!worst || deltaPct > worst.deltaPct)) {
      worst = { messageId, listingPrice, offendingPrice: p, deltaPct: Math.round(deltaPct * 10) / 10 }
    }
  }
  return worst
}

/** PURE: the compliance-ledger line for a finding (charter tone, actionable). */
export function composeConsistencyFlag(f: ConsistencyFinding): string {
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`
  return `Price mismatch in a queued client message: it says ${usd(f.offendingPrice)} but the listing's live price is ${usd(f.listingPrice)} (${f.deltaPct}% off). Fix the message or confirm the listing price before releasing — a stale figure confuses the client and creates advertising exposure.`
}

export interface GuardianResult { scanned: number; flagged: number }

/**
 * Scan PROPOSED listing-scoped client messages for price inconsistency and
 * flag material mismatches onto compliance_flags (deduped per message).
 * Best-effort; deterministic.
 */
export async function runConsistencyGuardian(svc: any, brokerageId: string): Promise<GuardianResult> {
  const out: GuardianResult = { scanned: 0, flagged: 0 }
  const { data: msgs } = await svc.from("agent_client_messages")
    .select("id, body, entity_type, entity_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "proposed")
    .eq("entity_type", "listing")
    .not("entity_id", "is", null)
    .limit(300)

  for (const m of ((msgs ?? []) as any[])) {
    out.scanned += 1
    const { data: listing } = await svc.from("listings").select("list_price").eq("id", m.entity_id).maybeSingle()
    const finding = checkPriceConsistency(m.id, String(m.body ?? ""), (listing as any)?.list_price ?? null)
    if (!finding) continue

    const tag = `[CONSISTENCY:${finding.messageId}]`
    const { data: dup } = await svc.from("compliance_flags")
      .select("id").ilike("flagged_content", `%${tag}%`).limit(1).maybeSingle()
    if (dup) continue

    const { error } = await svc.from("compliance_flags").insert({
      brokerage_id: brokerageId,
      violation_type: "price_inconsistency",
      content_type: "client_message",
      flagged_content: `${composeConsistencyFlag(finding)} ${tag}`,
      severity: finding.deltaPct >= 10 ? "high" : "medium",
      // LIVE CHECK vocabulary: flagged/reviewed/resolved/overridden (not 'open').
      status: "flagged",
      detected_at: new Date().toISOString(),
    })
    if (!error) out.flagged += 1
  }
  return out
}

/** Autonomous: every brokerage (rides the CI-compliance-watch cron). */
export async function runConsistencyGuardianAll(svc: any): Promise<{ brokerages: number; flagged: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(500)
  let flagged = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runConsistencyGuardian(svc, b.id).catch(() => null)
    if (r) flagged += r.flagged
  }
  return { brokerages: (brokerages ?? []).length, flagged }
}
