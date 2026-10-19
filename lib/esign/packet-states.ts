/**
 * lib/esign/packet-states.ts — THE ONE E-SIGN PACKET LIFECYCLE (wave 142, lane 142B). PURE.
 *
 * Owner (2026-10-18, verbatim): "it is listings and offers and then the offer turns into a
 * transaction after the offer passes compliance for an executed contract." Lifecycle:
 * Listing → Offer → Signatures → Compliance → Fully Executed Contract → Transaction → Closing.
 * "States: draft · sent · partially_signed · all_signed · compliance_pending · correction_required
 * · compliance_approved · fully_executed · declined/voided/expired. Provider completion ≠
 * compliance approval."
 *
 * ── THE SURVIVOR, EXTENDED (CLAUDE.md §1, §6) ─────────────────────────────────────────────────
 * The column is `esign_status` on `offers` AND `listing_agreements` — ONE live CHECK vocabulary on
 * both (scripts/check-vocabularies.ts: declined · fully_signed · partially_signed · pending · sent
 * · voided), with the code ladder in lib/transactions/coordination-status.ts
 * LISTING_AGREEMENT_ESIGN_STATUSES (now derived from this tuple, never restated). The owner's
 * states that already existed keep the SURVIVOR'S SPELLING — renaming a live CHECK value is a data
 * migration across every row and ~27 reader files, which is not "smallest complete change":
 *
 *     owner's name        survivor spelling   meaning
 *     draft            →  pending             staged, not yet sent (awaiting the agent's send)
 *     all_signed       →  fully_signed        the PROVIDER says every party signed
 *
 * `OWNER_STATE_ALIASES` records that mapping so a reader of the ruling and a reader of the column
 * meet in one place; `fromOwnerState` turns the owner's word into the column's. The six states the
 * column lacked are ADDED by supabase/migrations/m783 (written, not applied): compliance_pending,
 * correction_required, compliance_approved, fully_executed, expired (+ draft/all_signed are NOT
 * added — they would be second spellings, §6).
 *
 * ── RANK: provider completion is NOT compliance approval ────────────────────────────────────────
 * The ladder is ordered. `fully_signed` (rank 4) is the provider's statement; `compliance_pending`
 * … `fully_executed` (5–8) are OUR compliance decisions over that signed packet; the three
 * terminal failures (declined · voided · expired) rank 9 and are never advanced past. A writer may
 * only move UP the ladder (`canAdvancePacketState`): a redelivered "envelope completed" webhook that
 * arrives while the packet is in compliance must not regress it to fully_signed — which is exactly
 * what the raw `esign_status !== "fully_signed"` guards in lib/forms/esign-execution-loop.ts and
 * lib/esign-webhooks/finalize-packet.ts would have done once the compliance states existed. Those
 * guards now ask `isAtOrPastAllSigned`.
 *
 * No I/O. The writer is lib/esign/packet-state-writer.ts; the proof is
 * scripts/listing-offer-lifecycle-guard.ts (npm run test:listing-offer-lifecycle).
 */

/** The column vocabulary — the m783 CHECK on offers.esign_status + listing_agreements.esign_status. */
export const ESIGN_PACKET_STATES = [
  "pending",
  "sent",
  "partially_signed",
  "fully_signed",
  "compliance_pending",
  "correction_required",
  "compliance_approved",
  "fully_executed",
  "declined",
  "voided",
  "expired",
] as const
export type EsignPacketState = (typeof ESIGN_PACKET_STATES)[number]

/** The owner's eleven words, in the owner's order (the ruling, verbatim). */
export const OWNER_PACKET_STATES = [
  "draft", "sent", "partially_signed", "all_signed", "compliance_pending", "correction_required",
  "compliance_approved", "fully_executed", "declined", "voided", "expired",
] as const
export type OwnerPacketState = (typeof OWNER_PACKET_STATES)[number]

/** Owner's word → the survivor's column spelling. Identity for every state the column already spelled the owner's way. */
export const OWNER_STATE_ALIASES: Readonly<Record<OwnerPacketState, EsignPacketState>> = Object.freeze({
  draft:               "pending",
  sent:                "sent",
  partially_signed:    "partially_signed",
  all_signed:          "fully_signed",
  compliance_pending:  "compliance_pending",
  correction_required: "correction_required",
  compliance_approved: "compliance_approved",
  fully_executed:      "fully_executed",
  declined:            "declined",
  voided:              "voided",
  expired:             "expired",
})

/** PURE: the column spelling for an owner's word (null for a word that is not in the ruling). */
export function fromOwnerState(word: string | null | undefined): EsignPacketState | null {
  if (!word) return null
  return (OWNER_STATE_ALIASES as Record<string, EsignPacketState>)[word] ?? null
}

/** The rank of each state on the ladder. Terminal failures share the top rank: nothing advances past them. */
// compliance_pending and correction_required share a rank ON PURPOSE: a corrected packet RE-ENTERS
// review (correction_required → compliance_pending on the next upload), and review may find more to
// correct — the two alternate until approval, so neither outranks the other.
const RANK: Readonly<Record<EsignPacketState, number>> = Object.freeze({
  pending: 0,
  sent: 1,
  partially_signed: 2,
  fully_signed: 4,
  compliance_pending: 5,
  correction_required: 5,
  compliance_approved: 6,
  fully_executed: 7,
  declined: 8,
  voided: 8,
  expired: 8,
})

/**
 * PURE: the terminal failure a provider's event/status names, or null. Read from the adapted webhook
 * payload (lib/kernel/schema-adaptation.ts ESIGN_COMPLETION_CONTRACTS): DocuSign "envelope-declined" /
 * "envelope-voided" / status "declined"|"voided"; SkySlope / Authentisign "signing.declined", "expired".
 * A completion word wins over nothing; an unrelated event is null (ignored by the route, as today).
 */
export function providerTerminalState(event: string | null | undefined, status: string | null | undefined): EsignTerminalFailureState | null {
  const text = `${event ?? ""} ${status ?? ""}`.toLowerCase()
  if (/declin/.test(text)) return "declined"
  if (/void/.test(text)) return "voided"
  if (/expir/.test(text)) return "expired"
  return null
}

export function isEsignPacketState(value: unknown): value is EsignPacketState {
  return typeof value === "string" && (ESIGN_PACKET_STATES as readonly string[]).includes(value)
}

/** PURE: the ladder position; -1 for an unknown/legacy value so an unknown never outranks a real state. */
export function esignPacketRank(state: string | null | undefined): number {
  return isEsignPacketState(state) ? RANK[state] : -1
}

/** The three terminal failures — the envelope will never complete; the agent re-sends through the proper workflow. */
export const ESIGN_TERMINAL_FAILURE_STATES = ["declined", "voided", "expired"] as const satisfies readonly EsignPacketState[]
export type EsignTerminalFailureState = (typeof ESIGN_TERMINAL_FAILURE_STATES)[number]

export function isTerminalFailureState(state: string | null | undefined): state is EsignTerminalFailureState {
  return (ESIGN_TERMINAL_FAILURE_STATES as readonly string[]).includes(state ?? "")
}

/**
 * PURE: has the PROVIDER's "every party signed" moment already been recorded — i.e. is the packet
 * at fully_signed or anywhere in compliance after it? The replacement for the raw
 * `esign_status === "fully_signed"` tests: a packet in compliance_pending IS past all-signed.
 */
export function isAtOrPastAllSigned(state: string | null | undefined): boolean {
  const r = esignPacketRank(state)
  return r >= RANK.fully_signed && r < RANK.declined
}

/** PURE: the compliance decision states — ours, never the provider's. */
export const ESIGN_COMPLIANCE_STATES = ["compliance_pending", "correction_required", "compliance_approved", "fully_executed"] as const satisfies readonly EsignPacketState[]

export type PacketAdvanceVerdict =
  | { ok: true; noop: boolean }
  | { ok: false; reason: string }

/**
 * PURE — THE RULE a writer obeys: only UP the ladder. Equal = idempotent no-op (a redelivered
 * webhook, a loop re-entered on an upload). A terminal failure may be recorded from any live state
 * (the provider declined/voided/expired it) but never over fully_executed, and nothing is ever
 * written over a terminal failure. An unknown current value (legacy text) may be advanced from.
 */
export function canAdvancePacketState(from: string | null | undefined, to: EsignPacketState): PacketAdvanceVerdict {
  if (!isEsignPacketState(to)) return { ok: false, reason: `'${String(to)}' is not an e-sign packet state` }
  const fromRank = esignPacketRank(from)
  const toRank = RANK[to]
  if (from === to) return { ok: true, noop: true }
  if (fromRank >= RANK.declined) return { ok: false, reason: `packet is already ${from} — a terminal provider outcome is never overwritten; re-send through the proper workflow` }
  if (to === "fully_executed" && fromRank < RANK.compliance_pending && fromRank >= 0 && fromRank < RANK.fully_signed) {
    return { ok: false, reason: `cannot mark fully_executed from ${from}: the packet has not been reported all-signed by the provider` }
  }
  if (from === "fully_executed" && isTerminalFailureState(to)) return { ok: false, reason: "a fully executed packet cannot be declined, voided or expired by the provider" }
  if (toRank < fromRank) return { ok: false, reason: `cannot move esign_status backwards from ${from} to ${to}` }
  return { ok: true, noop: false }
}

/** PURE: the owner's hop notice per state — what the agent's bell says. No legal terms, no amounts. */
export const PACKET_HOP_NOTICE: Readonly<Record<EsignPacketState, { title: string; body: string }>> = Object.freeze({
  pending:             { title: "Packet staged — not yet sent", body: "The packet is staged for your send. Open the e-sign window to send it to the signers." },
  sent:                { title: "Packet sent for signature", body: "The e-sign provider has emailed the signers. You will be told as each party signs." },
  partially_signed:    { title: "A party signed", body: "A signer has completed their part. The packet is waiting on the remaining signers." },
  fully_signed:        { title: "All parties signed — going to compliance", body: "The provider reports every party has signed. The signed copies are being retrieved and the packet is submitted to compliance automatically." },
  compliance_pending:  { title: "Compliance review started", body: "Compliance is checking required documents, initials, signatures and disclosures. Nothing is executed until it approves." },
  correction_required: { title: "Compliance needs corrections", body: "Compliance found deficiencies. The blockers are listed on the deal; fix them and the packet re-enters review automatically on upload." },
  compliance_approved: { title: "Compliance approved", body: "Compliance approved the executed packet." },
  fully_executed:      { title: "Fully executed", body: "The contract is fully executed and on file. The next stage has started." },
  declined:            { title: "Signature declined", body: "A signer declined the envelope. Review the reason with the party and re-send through the proper workflow." },
  voided:              { title: "Envelope voided", body: "The envelope was voided at the provider. Re-send the packet when ready." },
  expired:             { title: "Envelope expired", body: "The envelope expired before every party signed. Re-send the packet when ready." },
})

/** The owner's lifecycle vocabulary — the stages a deal walks, in order (never 30/60/90, never a status). */
export const DEAL_LIFECYCLE_STAGES = [
  "listing", "offer", "signatures", "compliance", "fully_executed_contract", "transaction", "closing",
] as const
