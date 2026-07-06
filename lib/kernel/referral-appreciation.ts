// lib/kernel/referral-appreciation.ts
// ─────────────────────────────────────────────────────────────────────────────
// REFERRER LOVE LOOP (sphere_of_influence) — the contacts we keep asking to refer
// friends/family DO refer, and then hear nothing. Audit finding: referrals.referred_by
// was FREE TEXT (a name), so the OS literally could not know WHO to keep updated or
// appreciate. New referrals.referrer_contact_id links the referrer as a CONTACT, and
// this loop closes the ask in two halves:
//   1. PROGRESS UPDATES — as the referred person advances (contacted → qualified →
//      under_contract → closed), propose ONE gated, privacy-tasteful update to the
//      referrer per milestone ("your friend is in great hands / just hit a milestone").
//      NEVER deal specifics: no prices, addresses, lender terms — their friend's
//      business stays their friend's business.
//   2. APPRECIATION — on close, propose the small thank-you gift DECIDED BY the
//      agent / team / brokerage (a settings cascade, most-specific wins; default
//      DISABLED until configured; value hard-capped). COMPLIANCE: most states bar
//      paying unlicensed people cash for referrals — this proposes a modest NON-CASH
//      gift and clamps the value; the human approves + sends, gift_sent flips only
//      when a human records it.
// Division of labor with lib/agents/referral-closer.ts (kept, no drift): the closer
// does close-time BOOKKEEPING + the partner thank-you NOTE; this loop owns the
// referrer's journey updates + the CONFIGURED gift. Both ride the same gated
// agent_client_messages rail and dedupe by rationale tag.

import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

// ── Stages that earn the referrer an update ───────────────────────────────────
export const REFERRAL_UPDATE_STAGES = ["contacted", "qualified", "under_contract", "closed"] as const
export type ReferralUpdateStage = (typeof REFERRAL_UPDATE_STAGES)[number]

export function isUpdateStage(status: string | null | undefined): status is ReferralUpdateStage {
  return !!status && (REFERRAL_UPDATE_STAGES as readonly string[]).includes(status)
}

/** Dedupe tags carried in the proposal rationale — one update per (referral, stage). */
export const updateTag = (referralId: string, stage: string) => `[referral-update:${referralId}:${stage}]`
export const appreciationTag = (referralId: string) => `[referral-appreciation:${referralId}]`

// ── PURE: the privacy-tasteful referrer update ────────────────────────────────

const STAGE_LINE: Record<ReferralUpdateStage, string> = {
  contacted:      "we've connected and they're in great hands",
  qualified:      "we've mapped out a plan together and things are moving",
  under_contract: "they just hit a big milestone in their journey",
  closed:         "they made it to the finish line — all done and celebrating",
}

/**
 * Compose the update the AGENT sends the referrer. Deliberately content-light:
 * no prices, no addresses, no terms — a warm nod that their introduction mattered.
 */
export function composeReferrerUpdate(p: {
  referrerFirstName?: string | null
  referredFirstName?: string | null
  stage: ReferralUpdateStage
}): { subject: string; body: string } {
  const referrer = sanitizeProperNoun(p.referrerFirstName ?? "") || "there"
  const friend = sanitizeProperNoun(p.referredFirstName ?? "") || "your friend"
  return {
    subject: `A quick update on ${friend}`,
    body:
      `Hi ${referrer},\n\n` +
      `Just wanted you to know — ${friend}, who you sent our way, is doing great: ${STAGE_LINE[p.stage]}. ` +
      `Out of respect for their privacy I'll keep the details theirs to share, but your introduction meant a lot ` +
      `and we're taking good care of them.\n\nThank you for trusting us with someone you care about.`,
  }
}

// ── PURE: the appreciation setting cascade (agent → team → brokerage) ─────────

export interface AppreciationSetting {
  enabled: boolean
  /** Modest, NON-CASH appreciation value in cents (hard-capped). */
  maxValueCents: number
  /** e.g. "gift card", "handwritten card + local coffee", "flowers" */
  kind: string
  note?: string | null
}

/** Hard ceiling — referral gifts to unlicensed people must stay modest (state
 *  license law bars cash referral fees; keep it a token of thanks, not a fee). */
export const APPRECIATION_HARD_CAP_CENTS = 25_000
export const DEFAULT_APPRECIATION: AppreciationSetting = { enabled: false, maxValueCents: 5_000, kind: "handwritten card + small gift", note: null }

export interface AppreciationScopes {
  agent?: Partial<AppreciationSetting> | null
  team?: Partial<AppreciationSetting> | null
  brokerage?: Partial<AppreciationSetting> | null
}

/** Most-specific scope wins per the ask ("decided by the agent/team or brokerage");
 *  value always clamped to the hard cap; default DISABLED until someone configures it. */
export function resolveAppreciationSetting(scopes: AppreciationScopes): AppreciationSetting {
  const chosen = scopes.agent ?? scopes.team ?? scopes.brokerage ?? null
  const merged = { ...DEFAULT_APPRECIATION, ...(chosen ?? {}) }
  return {
    enabled: chosen ? merged.enabled !== false : false,
    maxValueCents: Math.max(0, Math.min(Number(merged.maxValueCents) || 0, APPRECIATION_HARD_CAP_CENTS)),
    kind: (merged.kind ?? DEFAULT_APPRECIATION.kind).toString().slice(0, 120),
    note: merged.note ?? null,
  }
}

/** PURE: the gated appreciation proposal body the agent reviews. */
export function composeAppreciationProposal(p: {
  referrerFirstName?: string | null
  referredFirstName?: string | null
  setting: AppreciationSetting
}): { subject: string; body: string } {
  const referrer = sanitizeProperNoun(p.referrerFirstName ?? "") || "your referrer"
  const friend = sanitizeProperNoun(p.referredFirstName ?? "") || "their friend"
  const dollars = (p.setting.maxValueCents / 100).toFixed(0)
  return {
    subject: `Send ${referrer} a thank-you for referring ${friend}`,
    body:
      `${friend}'s journey just closed — time to appreciate ${referrer} for the introduction.\n\n` +
      `Configured appreciation: ${p.setting.kind} (up to $${dollars})` +
      (p.setting.note ? ` — ${p.setting.note}` : "") + `.\n\n` +
      `Keep it a modest, personal thank-you (not a referral fee — state license law bars cash fees to ` +
      `unlicensed people). Approve to log it, then record when the gift actually goes out.`,
  }
}

// ── The runner (rides the proactive-intelligence cron; best-effort) ───────────

export interface ReferralAppreciationRun {
  scanned: number
  updatesProposed: number
  appreciationsProposed: number
  skippedNoReferrerLink: number
  skippedDuplicate: number
}

/** Read the appreciation scopes for an agent out of brokerage_settings.settings. */
export function scopesFromSettings(settings: any, agentId?: string | null, teamId?: string | null): AppreciationScopes {
  const root = settings?.referral_appreciation ?? null
  if (!root) return {}
  return {
    brokerage: root.enabled !== undefined || root.maxValueCents !== undefined || root.kind !== undefined ? root : null,
    team: teamId ? root.byTeam?.[teamId] ?? null : null,
    agent: agentId ? root.byAgent?.[agentId] ?? null : null,
  }
}

export async function runReferralAppreciation(brokerageId: string, svc: any): Promise<ReferralAppreciationRun> {
  const out: ReferralAppreciationRun = { scanned: 0, updatesProposed: 0, appreciationsProposed: 0, skippedNoReferrerLink: 0, skippedDuplicate: 0 }

  const { data: refs } = await svc
    .from("referrals")
    .select("id, brokerage_id, status, referrer_contact_id, referred_contact_id, referring_agent_id, gift_sent")
    .eq("brokerage_id", brokerageId)
    .in("status", [...REFERRAL_UPDATE_STAGES])
    .limit(500)
  const rows = (refs ?? []) as any[]
  out.scanned = rows.length
  if (rows.length === 0) return out

  const { data: settingsRow } = await svc
    .from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  const settings = (settingsRow as any)?.settings ?? null

  for (const r of rows) {
    if (!r.referrer_contact_id) { out.skippedNoReferrerLink++; continue }
    const stage = r.status as ReferralUpdateStage

    const [{ data: referrer }, { data: referred }, { data: agentRow }] = await Promise.all([
      svc.from("contacts").select("id, first_name, agent_id, team_id").eq("id", r.referrer_contact_id).maybeSingle(),
      r.referred_contact_id ? svc.from("contacts").select("first_name").eq("id", r.referred_contact_id).maybeSingle() : Promise.resolve({ data: null }),
      r.referring_agent_id ? svc.from("agents").select("id, team_id").eq("id", r.referring_agent_id).maybeSingle() : Promise.resolve({ data: null }),
    ])
    if (!referrer) { out.skippedNoReferrerLink++; continue }

    // 1) Milestone update — one per (referral, stage), deduped by rationale tag.
    const tag = updateTag(r.id, stage)
    const { count: dupU } = await svc.from("agent_client_messages")
      .select("id", { count: "exact", head: true }).ilike("rationale", `${tag}%`)
    if ((dupU ?? 0) > 0) {
      out.skippedDuplicate++
    } else {
      const msg = composeReferrerUpdate({ referrerFirstName: (referrer as any).first_name, referredFirstName: (referred as any)?.first_name, stage })
      await svc.from("agent_client_messages").insert({
        brokerage_id: brokerageId,
        recipient_contact_id: r.referrer_contact_id,
        entity_type: "referral",
        entity_id: r.id,
        audience: "agent",
        agent_kind: "sphere_of_influence",
        status: "proposed",
        subject: msg.subject,
        body: msg.body,
        rationale: `${tag} Referrer kept in the loop — privacy-tasteful milestone update (no deal details).`,
      })
      out.updatesProposed++
    }

    // 2) On CLOSE — the configured appreciation (only when a scope enabled it).
    if (stage === "closed" && !r.gift_sent) {
      const setting = resolveAppreciationSetting(scopesFromSettings(settings, r.referring_agent_id, (agentRow as any)?.team_id ?? (referrer as any).team_id))
      if (setting.enabled) {
        const aTag = appreciationTag(r.id)
        const { count: dupA } = await svc.from("agent_client_messages")
          .select("id", { count: "exact", head: true }).ilike("rationale", `${aTag}%`)
        if ((dupA ?? 0) > 0) {
          out.skippedDuplicate++
        } else {
          const prop = composeAppreciationProposal({ referrerFirstName: (referrer as any).first_name, referredFirstName: (referred as any)?.first_name, setting })
          await svc.from("agent_client_messages").insert({
            brokerage_id: brokerageId,
            recipient_contact_id: r.referrer_contact_id,
            entity_type: "referral",
            entity_id: r.id,
            audience: "agent",
            agent_kind: "sphere_of_influence",
            status: "proposed",
            subject: prop.subject,
            body: prop.body,
            rationale: `${aTag} Configured appreciation (${setting.kind}, cap $${(setting.maxValueCents / 100).toFixed(0)}) — human approves; gift_sent flips only when recorded.`,
          })
          out.appreciationsProposed++
        }
      }
    }
  }

  return out
}
