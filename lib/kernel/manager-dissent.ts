// lib/kernel/manager-dissent.ts
//
// MANAGER DISSENT — peer review before the human ever sees a proposal. Every AI tool on
// the market shows you raw machine output and makes YOU the quality control. A real team
// doesn't work that way: before something reaches the broker's desk, a colleague has
// looked at it. Here, every gate proposal is reviewed by a DIFFERENT manager than the
// one who wrote it (Campaign Orchestrator reviews everyone; the Data Steward reviews
// the Campaign Orchestrator — nobody reviews their own work):
//
//   · VETO (machine-rejected, auditable, no forged approver) — only for proposals that
//     should never reach the human: the relationship is WITHDRAWN (the consent chain
//     promised "nothing further"), or the channel itself was revoked by the recipient.
//   · DISSENT (annotated, human still decides) — Fair Housing steering language (the
//     SHARED pattern list — one source of truth with the messaging + ads gates), a live
//     fire drill on this client's deal (hold routine touches while the team fights the
//     fire), or the client heard from us within 48h (spacing).
//   · PASS — the proposal carries "peer-reviewed, no objections," so approving it is
//     one glance instead of a proofread.
//
// The dissent is VISIBLE — the rationale shows the reviewing manager disagreeing with a
// colleague, which is exactly what makes the approvals trustworthy.
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"
import { FAIR_HOUSING_PATTERNS } from "@/lib/compliance-rules/fair-housing-patterns"

type Svc = ReturnType<typeof createServiceClient>

/** Every review annotation carries this mark — it is also the idempotency key. */
export const REVIEW_MARK = "⚖️"

/** Pure: nobody reviews their own work. The comms governor reviews everyone;
 *  the Data Steward (facts + consent owner) reviews the comms governor. */
export function pickReviewer(proposer: string): ManagerKey {
  return proposer === "campaign_orchestrator" ? "data_steward" : "campaign_orchestrator"
}

export interface ProposalUnderReview {
  proposer: string
  channel: string
  subject: string | null
  body: string
}

export interface ReviewContext {
  /** The consent chain marked this relationship withdrawn — nothing further, ever. */
  recipientWithdrawn: boolean
  /** The recipient revoked the proposal's own channel. */
  emailRevoked: boolean
  smsRevoked: boolean
  /** Hours since the client last actually heard from us (sent), null if never. */
  hoursSinceLastSend: number | null
  /** A fire drill ran on this client's deal in the last 24h. */
  openFireDrill: boolean
}

export interface ReviewVerdict {
  verdict: "pass" | "dissent" | "veto"
  objections: string[]
}

/** The Compliance Officer's slice of the review — the regulatory findings this manager is
 *  ACCOUNTABLE for (Fair Housing steering + revoked/withdrawn consent), separated from the
 *  peer reviewer's coordination checks (fire-drill timing, spacing). `blocking` findings are
 *  hard stops (a proposal that must never reach the human → veto); `advisories` annotate. */
export interface ComplianceFinding {
  blocking: string[]
  advisories: string[]
}

/** Pure: the Compliance Officer's pre-flight on a proposal — consent first (a closed channel
 *  or a withdrawn relationship is a hard block), then Fair Housing steering language against
 *  the SHARED pattern list (one source of truth with the messaging + ads gates). Owned by the
 *  Compliance Officer; reused by reviewProposal so there is exactly one compliance evaluator. */
export function evaluateCompliance(p: ProposalUnderReview, ctx: ReviewContext): ComplianceFinding {
  const blocking: string[] = []
  if (ctx.recipientWithdrawn) {
    blocking.push("relationship is WITHDRAWN — the consent chain promised nothing further would be proposed")
  }
  if (p.channel === "email" && ctx.emailRevoked) {
    blocking.push("the recipient revoked email — this channel is closed to us")
  }
  if (p.channel === "sms" && ctx.smsRevoked) {
    blocking.push("the recipient revoked sms — this channel is closed to us")
  }

  const advisories: string[] = []
  const text = `${p.subject ?? ""} ${p.body}`
  for (const fh of FAIR_HOUSING_PATTERNS) {
    fh.pattern.lastIndex = 0
    if (fh.pattern.test(text)) {
      advisories.push(`Fair Housing (${fh.severity}): "${fh.phrase}" — say "${fh.fix}" instead (${fh.reference})`)
    }
  }
  return { blocking, advisories }
}

/** The Compliance Officer's pre-flight VERDICT for the egress (Command Center proposal card):
 *  blocked (a hard consent stop), advisory (Fair Housing language to fix), or clear. Always
 *  attributed to the compliance_officer so the human sees WHO cleared it, not anonymous output. */
export interface CompliancePreflight {
  manager: ManagerKey
  status: "clear" | "advisory" | "blocked"
  findings: string[]
}
export function compliancePreflight(p: ProposalUnderReview, ctx: ReviewContext): CompliancePreflight {
  const c = evaluateCompliance(p, ctx)
  const status = c.blocking.length > 0 ? "blocked" : c.advisories.length > 0 ? "advisory" : "clear"
  return { manager: "compliance_officer", status, findings: [...c.blocking, ...c.advisories] }
}

/** Pure: the full peer review. The Compliance Officer's findings (consent + Fair Housing) compose
 *  FIRST — a consent block is a veto; everything else is dissent (annotated) and the human stays
 *  the decider. The peer reviewer adds coordination checks (fire-drill timing, spacing) on top. */
export function reviewProposal(p: ProposalUnderReview, ctx: ReviewContext): ReviewVerdict {
  const compliance = evaluateCompliance(p, ctx)
  if (compliance.blocking.length > 0) return { verdict: "veto", objections: compliance.blocking }

  const objections = [...compliance.advisories]
  if (ctx.openFireDrill && p.proposer !== "deal_coordinator") {
    objections.push("a FIRE DRILL is live on this client's deal — hold routine touches until the save lands")
  }
  if (ctx.hoursSinceLastSend !== null && ctx.hoursSinceLastSend < 48) {
    objections.push(`the client heard from us ${Math.max(1, Math.round(ctx.hoursSinceLastSend))}h ago — consider spacing this touch`)
  }

  return objections.length > 0 ? { verdict: "dissent", objections } : { verdict: "pass", objections: [] }
}

export interface DissentRunResult {
  reviewed: number
  passed: number
  dissents: number
  vetoes: number
}

/**
 * Review every un-reviewed pending proposal in the brokerage. Runs AFTER Team Plays in
 * the cron, so the consolidated play gets reviewed — not the fragments it absorbed.
 * Idempotent: the ⚖️ mark in the rationale means reviewed; vetoes only fire while the
 * proposal is still 'proposed' (a human decision is never overridden).
 */
export async function runManagerDissent(
  brokerageId: string,
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<DissentRunResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  const { data: proposals } = await supabase
    .from("agent_client_messages")
    .select("id, agent_kind, channel, subject, body, rationale, recipient_contact_id, status")
    .eq("brokerage_id", brokerageId).eq("status", "proposed")
    .limit(100)

  let reviewed = 0, passed = 0, dissents = 0, vetoes = 0

  for (const p of (proposals ?? []) as any[]) {
    if (((p.rationale ?? "") as string).includes(REVIEW_MARK)) continue

    // Context — every fact from a real table, nothing assumed.
    let ctx: ReviewContext = {
      recipientWithdrawn: false, emailRevoked: false, smsRevoked: false,
      hoursSinceLastSend: null, openFireDrill: false,
    }
    if (p.recipient_contact_id) {
      const [{ data: contact }, { data: lastSent }, { data: txns }] = await Promise.all([
        supabase.from("contacts").select("nurture_status, email_opt_out, email_unsubscribed, sms_opt_out")
          .eq("id", p.recipient_contact_id).maybeSingle(),
        supabase.from("agent_client_messages").select("sent_at")
          .eq("recipient_contact_id", p.recipient_contact_id).eq("status", "sent")
          .not("sent_at", "is", null).order("sent_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("transactions").select("id")
          .or(`buyer_contact_id.eq.${p.recipient_contact_id},seller_contact_id.eq.${p.recipient_contact_id},contact_id.eq.${p.recipient_contact_id}`)
          .is("deleted_at", null).limit(10),
      ])
      const txnIds = ((txns ?? []) as Array<{ id: string }>).map((t) => t.id)
      let openFireDrill = false
      if (txnIds.length > 0) {
        const { data: drill } = await supabase.from("notifications").select("id")
          .eq("type", "fire_drill").in("entity_id", txnIds)
          .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString())
          .limit(1).maybeSingle()
        openFireDrill = !!drill
      }
      const sentAt = (lastSent as { sent_at: string | null } | null)?.sent_at ?? null
      ctx = {
        recipientWithdrawn: (contact as any)?.nurture_status === "withdrawn",
        emailRevoked: !!(contact as any)?.email_opt_out || !!(contact as any)?.email_unsubscribed,
        smsRevoked: !!(contact as any)?.sms_opt_out,
        hoursSinceLastSend: sentAt ? (now.getTime() - new Date(sentAt).getTime()) / 3_600_000 : null,
        openFireDrill,
      }
    }

    const reviewer = pickReviewer(p.agent_kind)
    const reviewerLabel = MANAGERS[reviewer].label
    const complianceLabel = MANAGERS.compliance_officer.label
    const proposal = { proposer: p.agent_kind, channel: p.channel, subject: p.subject, body: p.body }
    // The Compliance Officer owns the consent + Fair Housing slice; the peer reviewer owns the
    // coordination slice (timing/spacing) — attributed separately so the human sees WHO flagged what.
    const compliance = evaluateCompliance(proposal, ctx)
    const result = reviewProposal(proposal, ctx)
    const coordination = result.objections.filter((o) => !compliance.advisories.includes(o))
    reviewed += 1

    if (result.verdict === "veto") {
      // Machine veto — a Compliance Officer pre-flight HARD STOP (consent). Auditable, no forged
      // human approver, only while still proposed.
      const { data: done } = await supabase.from("agent_client_messages")
        .update({ status: "rejected", send_error: `vetoed by ${complianceLabel} pre-flight: ${result.objections[0]}` })
        .eq("id", p.id).eq("status", "proposed").select("id").maybeSingle()
      if (done) vetoes += 1
    } else if (result.verdict === "dissent") {
      // The Compliance Officer leads the header when Fair Housing is involved (it owns that finding);
      // otherwise the coordination peer reviewer does. Each line is attributed inline to its owner.
      const who = compliance.advisories.length > 0 ? complianceLabel : reviewerLabel
      const lines = [
        ...compliance.advisories.map((o) => `- [${complianceLabel}] ${o}`),
        ...coordination.map((o) => `- [${reviewerLabel}] ${o}`),
      ]
      const annotation = `\n\n${REVIEW_MARK} PEER REVIEW — ${who} DISSENTS:\n${lines.join("\n")}`
      const { data: done } = await supabase.from("agent_client_messages")
        .update({ rationale: `${p.rationale ?? ""}${annotation}` })
        .eq("id", p.id).eq("status", "proposed").select("id").maybeSingle()
      if (done) dissents += 1
    } else {
      const annotation = `\n\n${REVIEW_MARK} Peer-reviewed by ${reviewerLabel} — no objections.`
      const { data: done } = await supabase.from("agent_client_messages")
        .update({ rationale: `${p.rationale ?? ""}${annotation}` })
        .eq("id", p.id).eq("status", "proposed").select("id").maybeSingle()
      if (done) passed += 1
    }
  }

  return { reviewed, passed, dissents, vetoes }
}
