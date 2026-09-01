/**
 * lib/kernel/compliance/outbound-predicates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE OUTBOUND SUPPRESSION PREDICATES — the client-safe leaf.
 *
 * WHY THIS FILE EXISTS (and why it is not a resurrection of the deleted twin):
 * lib/kernel/communication-compliance.ts is the kernel gate; its very first
 * import is `createServiceClient`, so any `"use client"` component that wanted
 * the eligibility rule had to either drag the server kernel into the browser
 * bundle or hand-roll the rule again. It hand-rolled it — twice, and both
 * copies were WEAKER than the real one:
 *
 *   app/crm/page.tsx (portal-invite button)   checked 2 of the 6 arms
 *   app/dashboard/admin/compliance/tcpa/page.tsx  spelled 2 arms as a PostgREST
 *                                             filter chain
 *
 * The tombstone at lib/kernel/communication-compliance.ts:286 already ruled on
 * the fix: "If a client-safe pure split is ever actually needed, re-extract
 * from these survivors — do not resurrect the twin." This IS that re-extraction:
 * the bodies below were MOVED (not copied) out of those survivors, and
 * communication-compliance.ts now re-exports them, so the names the tombstone
 * points at still resolve at that path and no second definition exists.
 *
 * CLIENT-SAFE CONTRACT — enforced by review, and cheap to re-verify:
 * the ONLY import in this file is a TYPE-ONLY import of ContactStatus from
 * lib/contact-promotion/qualification.ts, which itself imports nothing at all
 * (and is already imported by the "use client" app/crm/page.tsx, proving it
 * bundles). No createServiceClient, no next/headers, no "server-only", no
 * process/fs/net. Anything added here that reaches the server kernel puts the
 * service-role client back in the browser bundle — do not add one.
 *
 * ── THE ARMS, AND WHY THEY ARE NAMED SEPARATELY ─────────────────────────────
 * `isEligibleForOutbound` is the union of two DIFFERENT questions, and callers
 * legitimately need one without the other:
 *
 *   hasRecordedOptOut()             "this person told us to stop"
 *   needsConsentInRestrictedState() "we never had permission here in the first
 *                                    place"
 *
 * The TCPA board's actionable list is exactly the second case — contacts you
 * should go COLLECT consent from — so it must filter on the first question
 * only, or it would hide the very people it exists to surface. That is one
 * vocabulary composed two ways (§6), not two spellings of one rule: there is
 * still exactly one definition of each arm, here.
 */

import type { ContactStatus } from "@/lib/contact-promotion/qualification"

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EXACTLY the seven `contacts` columns the four predicates below read — nothing
 * else. This is the parameter type of every predicate in this file, deliberately
 * narrower than ContactData, so a caller holding any row shape carrying these
 * columns (a CRM page's own local `Contact` interface, a raw PostgREST row) can
 * pass it whole. Passing the WHOLE row is the point: hand-listing the fields at
 * a call site is how an arm added here silently stops being checked there.
 *
 * Deliberately nullable throughout — every one of these is a NULLABLE column on
 * hrvaqgvukzxfskkcrwbt.contacts.
 *
 * CALLER WARNING — this shape fails OPEN, by necessity: a field that was never
 * SELECTed is indistinguishable from a field that is false. Feed these
 * predicates a row loaded with `select("*")`, or one naming all nine columns
 * explicitly — never a narrow list projection. `SUPPRESSION_COLUMNS` below is
 * that select list, kept beside the fields so the two cannot drift.
 */
export interface OutboundSuppressionFields {
  dnc_status?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  call_stop_flag?: boolean | null
  /** See CHANNEL_OPT_OUT_COLUMNS — the SECOND phone spelling. */
  phone_opt_out?: boolean | null
  /** See CHANNEL_OPT_OUT_COLUMNS — the direct-mail flag. */
  direct_mail_opt_out?: boolean | null
  tcpa_consent?: boolean | null
  opt_out_channels?: string[] | null
  state?: string | null
}

/**
 * The PostgREST select list that makes these predicates honest. Anything not
 * named here reads as `false` and the check fails OPEN.
 */
export const SUPPRESSION_COLUMNS =
  "dnc_status, email_opt_out, sms_opt_out, call_stop_flag, phone_opt_out, direct_mail_opt_out, tcpa_consent, opt_out_channels, state"

/**
 * The compliance-relevant slice of a `contacts` row as the MASTER GATE
 * (lib/kernel/communication-compliance.ts evaluateOutboundCompliance) needs it:
 * the seven suppression columns above, plus the identity/routing fields and the
 * lifecycle status only the gate's RULE 8 reads. Deliberately partial — callers
 * routinely hold a partially-loaded row.
 */
export interface ContactData extends OutboundSuppressionFields {
  id: string
  email?: string | null
  phone?: string | null
  /** contacts.status — canonical vocabulary in
   *  lib/contact-promotion/qualification.ts CONTACT_STATUSES. Only 'inactive'
   *  matters to compliance (soft warn); the DNC fact lives on dnc_status. */
  status?: ContactStatus
}

/**
 * US states whose law requires prior express TCPA consent before outreach.
 * Tested against `contact.state` (geographic).
 *
 * NOT to be confused with REPRESENTATION_LOCK_STATES in lib/kernel/compliance.ts:94,
 * which is tested against `contact.status` (lifecycle). That set was renamed away
 * from this identifier on 2026-09-01 precisely so the two can never be merged by
 * accident — see the note at lib/kernel/compliance.ts:80.
 */
export const RESTRICTED_STATES = new Set([
  "CA", // California (CCPA strong)
  "NY", // New York
  "DC", // Washington DC
])

/**
 * The channel vocabulary. Identical to `CommunicationChannel` in
 * lib/kernel/communication-compliance.ts, which re-exports these predicates —
 * declared here because that module imports the server kernel and this leaf
 * must not.
 */
export type OutboundChannel =
  | "email" | "sms" | "phone" | "voicemail" | "direct_mail" | "social_dm"

/**
 * ═══ THE ONE HOME FOR "WHICH COLUMN MEANS *OPTED OUT OF CHANNEL X*" ═══
 * (CLAUDE.md §6 — read-side survivor.)
 *
 * `contacts` records a phone opt-out in FOUR different places and a mail opt-out
 * in THREE. Verified by whole-tree census on 2026-09-01:
 *
 *   PHONE  · contacts.call_stop_flag        read by evaluateOutboundCompliance RULE 2,
 *                                           check-suppression.ts:91, voice-dial-batch.ts:36
 *          · contacts.phone_opt_out         read by lib/kernel/compliance.ts:177 (content gate),
 *                                           check-suppression.ts:91, contact-channel-gate.ts:71,
 *                                           ai-isa/contact-channel-policy, speed-to-lead-policy,
 *                                           next-best-touch, campaign-publisher, phone-reachability
 *          · contacts.opt_out_channels ∋ 'phone'   read by evaluateOutboundCompliance RULE 5
 *          · contact_suppression_list row, channel='phone'  (a TABLE, not a column —
 *                                           read by checkSuppression; out of reach of a
 *                                           pure predicate and deliberately not modelled here)
 *   MAIL   · contacts.direct_mail_opt_out   read by lib/kernel/compliance.ts:180,
 *                                           check-suppression.ts:101, dispatch.ts:848,
 *                                           farm-mail, direct-mail reactors, audience-sync
 *          · contacts.opt_out_channels ∋ 'direct_mail'
 *          · contact_suppression_list row, channel='mail'
 *
 * The WRITERS disagree, which is what makes this dangerous rather than merely
 * untidy: `addSuppression` (check-suppression.ts:~322) writes call_stop_flag AND
 * dnc_status AND phone_opt_out together, but the CRM header-card channel toggle
 * (app/crm/page.tsx onChannelToggle) writes phone_opt_out **alone** — so a
 * contact switched off there is invisible to every reader that keys on
 * call_stop_flag, which until now included both predicates in this file.
 *
 * THIS MAP IS THE SURVIVOR ON THE READ SIDE. Every predicate below derives its
 * columns from it; adding a spelling means editing one object literal.
 *
 * ── WHAT A LATER MIGRATION SHOULD COLLAPSE (not written here — CLAUDE.md §3:
 *    lanes do not apply migrations, and this one needs a backfill + a reader
 *    sweep across ~30 files that this lane does not own) ─────────────────────
 *   1. Collapse `call_stop_flag` INTO `phone_opt_out`. `phone_opt_out` is the
 *      recommended storage survivor: it has strictly more readers, and it is the
 *      column BOTH live opt-out writers already key phone on
 *      (lib/lead-intent/lead-opt-out.ts:109 CHANNEL_FLAG_COLUMN, and
 *      app/actions/ai-isa/process-opt-out.ts:111). Backfill
 *      `phone_opt_out = phone_opt_out OR call_stop_flag` before dropping.
 *   2. Decide whether `opt_out_channels` or the per-channel booleans is the one
 *      storage form, and make the other a generated column, so a writer cannot
 *      set one and leave the other stale.
 * Until then the union below is the read-side fix, and it is deliberately a
 * UNION — an opt-out recorded in ANY spelling suppresses.
 */
export const CHANNEL_OPT_OUT_COLUMNS: Record<
  OutboundChannel,
  ReadonlyArray<keyof OutboundSuppressionFields>
> = {
  email:       ["email_opt_out"],
  sms:         ["sms_opt_out"],
  // call_stop_flag and phone_opt_out are the same fact spelled twice; voicemail
  // is a phone call that nobody answered, and the master gate's RULE 2 has
  // always treated the two channels identically.
  phone:       ["call_stop_flag", "phone_opt_out"],
  voicemail:   ["call_stop_flag", "phone_opt_out"],
  direct_mail: ["direct_mail_opt_out"],
  // No dedicated column exists for social DM. It is reachable ONLY through
  // dnc_status and an opt_out_channels entry — stated rather than left to be
  // discovered, because an empty list here reads exactly like an oversight.
  social_dm:   [],
}

/** Every per-channel opt-out column, deduped — the "any channel" arm. */
const ALL_OPT_OUT_COLUMNS: ReadonlyArray<keyof OutboundSuppressionFields> = [
  ...new Set(Object.values(CHANNEL_OPT_OUT_COLUMNS).flat()),
]

/** Human label per column, for getSuppressionReasons. One home, same as above. */
const OPT_OUT_COLUMN_LABEL: Record<string, string> = {
  email_opt_out:       "Email Opt-Out",
  sms_opt_out:         "SMS Opt-Out",
  call_stop_flag:      "Call Stop Flag",
  phone_opt_out:       "Phone Opt-Out",
  direct_mail_opt_out: "Direct Mail Opt-Out",
}

// ─────────────────────────────────────────────────────────────────────────────
// PREDICATES
// ─────────────────────────────────────────────────────────────────────────────

/** The opt-out columns that matter for `channel`, or all of them when omitted. */
function optOutColumnsFor(
  channel?: OutboundChannel,
): ReadonlyArray<keyof OutboundSuppressionFields> {
  return channel ? CHANNEL_OPT_OUT_COLUMNS[channel] : ALL_OPT_OUT_COLUMNS
}

/** Does `opt_out_channels` suppress this channel? Omit channel = any entry does. */
function arraySuppresses(
  contact: OutboundSuppressionFields,
  channel?: OutboundChannel,
): boolean {
  const entries = contact.opt_out_channels ?? []
  if (!channel) return entries.length > 0
  // Exact match, the same comparison the master gate's RULE 5 makes. Voicemail
  // additionally honours a 'phone' entry, because CHANNEL_OPT_OUT_COLUMNS already
  // rules that the two channels are one fact — leaving the array arm to disagree
  // with the column arm is how the next spelling gets created.
  return entries.includes(channel) || (channel === "voicemail" && entries.includes("phone"))
}

/**
 * ARM A — "this person told us to stop."
 *
 * With NO channel: true if ANY opt-out is recorded on ANY channel — the National
 * DNC flag, either phone spelling, email, SMS, direct mail, or any entry in the
 * `opt_out_channels` array. Strictly conservative, for callers that cannot say
 * which channel they are about to use.
 *
 * With a channel: true if the DNC flag is set (it blocks every channel) or if
 * ANY spelling of an opt-out for THAT channel is recorded — the union defined by
 * CHANNEL_OPT_OUT_COLUMNS plus the array arm.
 *
 * Mirrors RULES 1-5 of the master gate
 * (lib/kernel/communication-compliance.ts evaluateOutboundCompliance), and since
 * 2026-09-01 also the two per-channel flags that gate reads through
 * lib/kernel/compliance.ts:177/180 — phone_opt_out and direct_mail_opt_out.
 */
export function hasRecordedOptOut(
  contact: OutboundSuppressionFields,
  channel?: OutboundChannel,
): boolean {
  // dnc_status is global: it is not in CHANNEL_OPT_OUT_COLUMNS because it belongs
  // to no single channel, and it blocks all of them.
  if (contact.dnc_status) return true
  for (const column of optOutColumnsFor(channel)) {
    if (contact[column]) return true
  }
  if (arraySuppresses(contact, channel)) return true
  // status === "do_not_contact" removed 2026-08-31 — never a contacts.status
  // value; the DNC fact is dnc_status, checked above.
  return false
}

/**
 * ARM B — "we never had permission in this jurisdiction."
 *
 * Mirrors RULE 6 of the master gate. The pure form checks only the explicit
 * `tcpa_consent` flag; the master gate additionally accepts IMPLIED consent
 * from an active representation relationship (open transaction / signed
 * agreement / live offer — lib/kernel/compliance/active-representation.ts),
 * which is a DB lookup no pure predicate can make. So this arm is strictly
 * MORE restrictive than the gate, never less: it can refuse a contact the
 * gate would allow, and never allows one the gate would refuse.
 */
export function needsConsentInRestrictedState(contact: OutboundSuppressionFields): boolean {
  return RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent
}

/**
 * HELPER: Check if contact is eligible for ANY outbound
 * (Used for quick checks before queuing work)
 *
 * Union of every per-channel HARD block the master gate can raise: a contact
 * this returns true for can still be blocked per-channel (RULE 2-4/7 are
 * channel-scoped and RULE 6 consults active representation, a DB lookup this
 * pure predicate cannot make) — but it never passes a contact the master gate
 * would hard-block on every channel. Strictly conservative when no channel is
 * given: any recorded opt-out on any channel fails the quick check.
 *
 * Pass a channel ONLY when the call site truly knows it. Omitting it is the
 * safe default and the wider refusal; passing one narrows what is checked.
 */
export function isEligibleForOutbound(
  contact: OutboundSuppressionFields,
  channel?: OutboundChannel,
): boolean {
  if (hasRecordedOptOut(contact, channel)) return false
  if (needsConsentInRestrictedState(contact)) return false
  return true
}

/**
 * HELPER: Get all suppression reasons for a contact
 * (Used for UI display)
 *
 * Every arm `isEligibleForOutbound` can fail on names itself here, so a UI that
 * refuses a send can always say WHY. An empty array is the same statement as
 * `isEligibleForOutbound(contact, channel) === true` — the two walk the SAME
 * column list (optOutColumnsFor), so a new spelling added to
 * CHANNEL_OPT_OUT_COLUMNS starts refusing AND starts explaining itself in the
 * same edit. A refusal a UI cannot name is how a user is told "no" with no way
 * to find out why.
 */
export function getSuppressionReasons(
  contact: OutboundSuppressionFields,
  channel?: OutboundChannel,
): string[] {
  const reasons: string[] = []
  if (contact.dnc_status) reasons.push("Do Not Call Registry")
  for (const column of optOutColumnsFor(channel)) {
    if (contact[column]) reasons.push(OPT_OUT_COLUMN_LABEL[column] ?? column)
  }
  for (const entry of contact.opt_out_channels ?? []) {
    // Same narrowing the predicate applies, so the reasons list never claims a
    // block the predicate does not make.
    if (!channel || entry === channel || (channel === "voicemail" && entry === "phone")) {
      reasons.push(`Channel Opt-Out (${entry})`)
    }
  }
  // "Marked Do Not Contact" via status removed 2026-08-31 — dnc_status (above)
  // is the DNC rail; 'do_not_contact' was never a contacts.status value.
  if (needsConsentInRestrictedState(contact)) {
    reasons.push(`Restricted State (${contact.state}) - No TCPA Consent`)
  }
  return reasons
}
