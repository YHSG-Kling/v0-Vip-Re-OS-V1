/**
 * lib/direct-mail/address-suppression.ts
 *
 * THE SUPPRESSION IDENTITY OF SOMEBODY WHO HAS A MAILBOX AND NOTHING ELSE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES
 *
 * m493 put an opt-out token on the mail piece: a QR plus a printed line keyed to
 * `direct_mail_recipients.unsubscribe_token`. Somebody holding the postcard can
 * now ask us to stop, and `lib/direct-mail/mail-unsubscribe.ts` binds that
 * request onto whichever entity the recipient row names — a lead, a contact, or
 * both.
 *
 * For a recipient row that names NEITHER it could bind nothing, and said so:
 *
 *     "This request was recorded against the mail piece, but the mailing list
 *      row it came from is not linked to a lead or contact, so no sender gate
 *      can enforce it automatically."
 *
 * That is the purchased farm list, the audience import, the mail-only prospect —
 * i.e. THE NORMAL RECIPIENT of an acquisition mailer, and the one case where the
 * person has no other relationship with us through which to be honoured. We
 * printed a promise on paper we mail to a stranger's house and could not keep it.
 *
 * The reason is structural: `contact_suppression_list` carried three identity
 * columns (contact_id, email, phone) and a direct-mail recipient is identified by
 * an ADDRESS. `checkSuppression`'s list arm ORs over exactly those three, so for
 * an address-only recipient the OR list is EMPTY and the gate answers
 * "not suppressed" having asked no question.
 *
 * m503 adds `contact_suppression_list.mailing_address_key`. This module is the
 * only thing that mints, writes and reads it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NORMALIZER IS NOT WRITTEN HERE, AND THAT IS THE POINT.
 *
 * A raw address cannot be compared — "1234 N. Lamar Boulevard, Apt 5B" and
 * "1234 north lamar blvd #5b" are one mailbox and two strings. The tree already
 * has the normalizer for this: `normalizeAddressKey(street, zip)` in
 * lib/analytics/prediction-accuracy.ts, proved by
 * scripts/prediction-accuracy-simulator.ts (suffix canonicalization, unit
 * designators stripped, ZIP+4 truncated, refusal without a street number or a
 * real ZIP). A SECOND normalizer would be a second answer to "is this the same
 * house", and the two would disagree the first time either was touched — so this
 * module DELEGATES and adds nothing but the refusal semantics its callers need.
 *
 * WHY THAT ONE AND NOT `normalizeStreetAddress` (lib/external/permit-signals):
 * the permit lane's key is STREET ONLY, which is correct there because its query
 * is already scoped to one territory. A suppression list has no such scope.
 * "123 Main St" exists in thousands of ZIPs, and a street-only key would suppress
 * every one of them the moment one household asked to stop. Over-suppression is
 * not the safe direction: it silently deletes reach the brokerage paid for and
 * afterwards cannot be told apart from a genuine opt-out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE + a thin server half. The key minting and every refusal decision are
 * PURE and importable offline (that is how scripts/mail-address-suppression-simulator.ts
 * proves them); the two database functions take a client and are called from
 * server modules only.
 */

import { normalizeAddressKey } from "@/lib/analytics/prediction-accuracy"

/** The channel these rows live on. The live CHECK on
 *  `contact_suppression_list.channel` admits email | sms | phone | mail. */
export const ADDRESS_SUPPRESSION_CHANNEL = "mail" as const

/** The column m503 adds. Named once so a typo cannot exist in two places. */
export const ADDRESS_SUPPRESSION_COLUMN = "mailing_address_key" as const

export interface MailingAddressParts {
  /** Street line as printed — house number required. `address_line2` / unit is
   *  ignored by the normalizer on purpose: a mailbox is the household. */
  street: string | null | undefined
  /** ZIP or ZIP+4. Truncated to 5 by the normalizer. */
  zip: string | null | undefined
}

/**
 * PURE. The suppression key for a mailing address, or NULL when the address is
 * not specific enough to BE an identity.
 *
 * NULL is a refusal, never a wildcard. Every caller must treat it as "this
 * address cannot be suppressed and cannot be checked" — writing a null key would
 * create a row that matches nothing, and CHECKING a null key must never be
 * allowed to widen into "match any row with a null key", which is every email
 * and phone suppression on the table.
 */
export function mailingAddressSuppressionKey(parts: MailingAddressParts): string | null {
  return normalizeAddressKey(parts.street ?? null, parts.zip ?? null)
}

/**
 * Is this PostgREST error the m503 column simply not being there yet?
 *
 * PGRST204 is "column not found in the schema cache" — PostgREST refuses a write
 * naming an absent column ENTIRELY. It is a DEPLOYMENT state, not a data state,
 * and the two must not be reported the same way: a pending migration is
 * something an operator fixes in a minute, while a refused write is something
 * that needs investigating.
 */
export function isAddressColumnMissing(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false
  const code = String(err.code ?? "")
  const msg = String(err.message ?? "")
  return code === "PGRST204" || (msg.includes(ADDRESS_SUPPRESSION_COLUMN) && /column|schema cache/i.test(msg))
}

/** A postgres unique violation — the household already asked once. */
function isDuplicate(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false
  return String(err.code ?? "") === "23505" || /duplicate key/i.test(String(err.message ?? ""))
}

export interface AddressSuppressionWriteResult {
  /** TRUE only when a row keyed on this address is KNOWN to exist afterwards. */
  suppressed: boolean
  /** The household had already asked — nothing new was written, and that is fine. */
  alreadySuppressed: boolean
  /** The address was not specific enough to be an identity (no street number / no ZIP). */
  unkeyable: boolean
  /** m503 has not been applied to this database yet. NOT a data failure. */
  pendingMigration: boolean
  /** The key that was written / would have been written. */
  addressKey: string | null
  error?: string
}

type Client = {
  from: (t: string) => any
}

/**
 * MAKE AN ADDRESS-ONLY OPT-OUT BINDING.
 *
 * Writes ONE row onto the existing `contact_suppression_list` — not a second
 * table, not a second gate — with `channel='mail'`, no contact/email/phone, and
 * the normalized key. That is the row `checkAddressSuppression` (and through it
 * `checkSuppression`, and through that `dispatchDirectMail`) reads.
 *
 * supabase-js RESOLVES a refusal rather than throwing, so every outcome here is
 * derived from a destructured `{ error }` and NOTHING returns `suppressed: true`
 * without one of: an insert that reported no error, or a unique violation that
 * proves the row is already there.
 */
export async function addAddressSuppression(
  client: Client,
  params: {
    brokerageId: string
    street: string | null | undefined
    zip: string | null | undefined
    reason: string
    /** 'inbound_direct_mail' for a token opt-out; 'manual' / 'admin' otherwise. */
    source: string
  },
): Promise<AddressSuppressionWriteResult> {
  const addressKey = mailingAddressSuppressionKey({ street: params.street, zip: params.zip })
  const base: AddressSuppressionWriteResult = {
    suppressed: false, alreadySuppressed: false, unkeyable: false,
    pendingMigration: false, addressKey,
  }
  if (!params.brokerageId) {
    return { ...base, error: "no brokerage — an address suppression is per tenant" }
  }
  if (!addressKey) {
    return {
      ...base,
      unkeyable: true,
      error: "the mailing address has no house number or no 5-digit ZIP, so it cannot identify one household",
    }
  }

  // EVERY COLUMN NAMED HERE IS VERIFIED PRESENT on contact_suppression_list —
  // brokerage_id, contact_id, email, phone, channel, suppression_reason, source,
  // created_at in scripts/schema-snapshot.ts:238, plus mailing_address_key from
  // m503. PostgREST refuses an INSERT naming an absent column ENTIRELY, which is
  // exactly the m503-pending case handled below.
  const { data, error } = await client
    .from("contact_suppression_list")
    .insert({
      brokerage_id: params.brokerageId,
      contact_id: null,
      email: null,
      phone: null,
      channel: ADDRESS_SUPPRESSION_CHANNEL,
      [ADDRESS_SUPPRESSION_COLUMN]: addressKey,
      suppression_reason: params.reason.slice(0, 500),
      source: params.source,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (isDuplicate(error)) {
    // The household is already on the list. The request is honoured; re-ledgering
    // it would make the consent record claim they asked twice.
    return { ...base, suppressed: true, alreadySuppressed: true }
  }
  if (isAddressColumnMissing(error)) {
    console.error(
      `[address-suppression] contact_suppression_list.${ADDRESS_SUPPRESSION_COLUMN} does not exist — migration m503 is not applied. ` +
        `The opt-out for ${addressKey} CANNOT be made binding until it is.`,
    )
    return { ...base, pendingMigration: true, error: error!.message }
  }
  if (error) {
    console.error("[address-suppression] address suppression row REFUSED:", error.message)
    return { ...base, error: error.message }
  }
  // A landed insert with no returned id is not proof. Say what we know.
  return { ...base, suppressed: !!(data as { id?: string } | null)?.id }
}

export interface AddressSuppressionReadResult {
  suppressed: boolean
  reason?: string
  /** The address could not be keyed — nothing was asked, and nothing is claimed. */
  unkeyable: boolean
  /** m503 pending: the column does not exist, so no address suppression CAN exist. */
  pendingMigration: boolean
  /** The read itself was refused — the caller must fail CLOSED on this. */
  unreadable: boolean
}

/**
 * IS THIS HOUSEHOLD ON THE LIST?
 *
 * ── THE THREE "NO"s, AND WHY THEY ARE NOT THE SAME ANSWER ───────────────────
 *
 *   unkeyable        — we cannot form an identity for this address. Nothing was
 *                      asked. The caller must not read this as consent; it reads
 *                      it as "this arm cannot speak", and the other arms decide.
 *   pendingMigration — the column does not exist in this database. This is the
 *                      ONE "no" that is genuinely SAFE to pass: if the column
 *                      does not exist, no row can carry an address key, so there
 *                      is provably nothing this arm could have missed. Failing
 *                      closed here would instead halt EVERY piece of physical
 *                      mail the platform sends the moment the code deployed ahead
 *                      of the migration — a self-inflicted outage in the name of
 *                      caution, protecting nobody.
 *   unreadable       — the database refused the question. "I could not check the
 *                      suppression list" and "they are not on it" are different
 *                      facts and the caller FAILS CLOSED, exactly as
 *                      checkSuppression's other arms do.
 */
export async function checkAddressSuppression(
  client: Client,
  params: {
    brokerageId: string
    street: string | null | undefined
    zip: string | null | undefined
  },
): Promise<AddressSuppressionReadResult> {
  const none: AddressSuppressionReadResult = {
    suppressed: false, unkeyable: false, pendingMigration: false, unreadable: false,
  }
  const addressKey = mailingAddressSuppressionKey({ street: params.street, zip: params.zip })
  if (!params.brokerageId || !addressKey) return { ...none, unkeyable: true }

  const { data, error } = await client
    .from("contact_suppression_list")
    .select("id, suppression_reason")
    .eq("brokerage_id", params.brokerageId)
    .eq("channel", ADDRESS_SUPPRESSION_CHANNEL)
    .eq(ADDRESS_SUPPRESSION_COLUMN, addressKey)
    .limit(1)

  if (isAddressColumnMissing(error)) {
    console.error(
      `[address-suppression] contact_suppression_list.${ADDRESS_SUPPRESSION_COLUMN} does not exist — migration m503 is not applied. ` +
        "No address-keyed opt-out can exist yet, so mail is not being held on this arm.",
    )
    return { ...none, pendingMigration: true }
  }
  if (error) {
    console.error("[address-suppression] address suppression read refused:", error.message)
    return { ...none, unreadable: true, reason: `Address suppression list unreadable — refusing to send (${error.message})` }
  }

  const row = Array.isArray(data) ? (data[0] as { suppression_reason?: string | null } | undefined) : undefined
  if (!row) return none
  return {
    ...none,
    suppressed: true,
    reason: `Suppressed: ${row.suppression_reason ?? "this mailing address asked to stop receiving mail"}`,
  }
}
