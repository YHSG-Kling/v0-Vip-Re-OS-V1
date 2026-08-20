/**
 * app/api/unsubscribe/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LEGACY EMAIL-FOOTER OPT-OUT. Kept alive, repaired, and honestly labelled.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ACTUALLY WRONG — measured against the live database, in the order the
 * defects bite. The first one is worse than the one this file was opened to fix.
 *
 * 1. THIS ENDPOINT COULD NOT UNSUBSCRIBE ANYONE. NOT ONE PERSON. EVER.
 *
 *    `contacts` carries TWO distinct unique uuid columns, both defaulting to
 *    gen_random_uuid(): the primary key `id`, and a second identifier
 *    `contact_id` (constraint `contacts_contact_id_key`). They are NEVER equal —
 *    verified live: 4 contact rows, 4 non-null `contact_id` values, 0 where
 *    `contact_id = id`.
 *
 *    The link that is actually sent carries `id`.
 *    `lib/kernel/communications/assemble-email.ts:126` builds
 *    `/unsubscribe?contactId=${params.contactId}`, and `params.contactId` comes
 *    from `lib/providers/dispatch.ts:414-419`, which is the same value
 *    `checkSuppression` uses as `.eq('id', …)`. So the footer emits `contacts.id`.
 *
 *    This route looked it up with `.eq('contact_id', contactId)` — the OTHER
 *    column. Every real click therefore missed, returned 404 "Contact not found",
 *    and the person was shown "Something went wrong". A functioning opt-out
 *    mechanism is not optional under CAN-SPAM; there wasn't one.
 *
 * 2. AND IF THE LOOKUP HAD SOMEHOW MATCHED, THE WRITE WOULD HAVE BEEN REFUSED
 *    AND THE REFUSAL SWALLOWED.
 *
 *    The old code passed `contact.contact_id` into `addSuppression({ contactId })`.
 *    `contact_suppression_list.contact_id` is a FOREIGN KEY onto `contacts(id)`
 *    (live: `contact_suppression_list_contact_id_fkey`), so inserting the OTHER
 *    uuid is a foreign-key violation. `addSuppression` returns Promise<void> and
 *    destructures none of its three writes — supabase-js RESOLVES a refusal, so
 *    the violation vanished and the route returned `{ success: true }`. Its
 *    `contacts` update had the same fault in mirror image: `.eq('id', <contact_id>)`
 *    matches zero rows, which supabase-js also reports as success.
 *
 *    So the best case for this endpoint was: tell the person they are
 *    unsubscribed, write nothing, keep emailing them.
 *
 * 3. A LEAD'S FOOTER LINK POINTED AT A TABLE THAT COULD NOT CONTAIN THEM.
 *    When `dispatchEmail` is called with `leadId` and no `contactId`,
 *    dispatch.ts:398 sets `recipientId = params.leadId` and the footer is stamped
 *    with a LEAD id — pointed at a route that only ever queried `contacts`.
 *
 * 4. THE IDOR. Real, and worth stating precisely rather than loosely.
 *
 *    It is NOT an enumeration attack. `contacts.id` defaults to
 *    gen_random_uuid() — 122 bits — so ids cannot be walked. (The four seeded
 *    rows in this database carry hand-written sequential uuids, which is a
 *    seeding artefact, not the production shape.)
 *
 *    It IS an unauthenticated, untenanted, state-changing write whose only
 *    credential is an ENTITY ID — and an entity id is a lookup key, so it is in
 *    dashboard URLs, CSV exports, webhook payloads, logs, and the email footer
 *    itself. The concrete attack needs no guessing at all: FORWARD ONE MARKETING
 *    EMAIL. Whoever receives it holds a permanent working suppression capability
 *    for the original addressee, and the compliance ledger will record the result
 *    as that person's own request. An id also cannot be rotated (rotating it
 *    breaks every FK) and cannot be scoped to one channel or one send.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HARDEN, NOT REMOVE — and why that is not the comfortable answer.
 *
 * The comfortable answer is to delete this shape and serve only the m493 token.
 * It is the wrong answer, for one decisive reason: THE LINK IS ALREADY IN
 * PEOPLE'S INBOXES. `assemble-email.ts` stamps it into the footer of every
 * non-transactional email this product has ever sent, and delivered mail cannot
 * be recalled. Removing the route turns every one of those footers into a 404 —
 * replacing a broken opt-out with an absent one, which is worse both for the
 * person and under CAN-SPAM.
 *
 * Repointing the sender is also not this lane's to do: `assemble-email.ts` is
 * owned elsewhere. The exact change it needs is reported rather than made.
 *
 * So: this route is repaired, given the lead support it never had, rate-limited,
 * made to verify that its writes actually landed, and made to LABEL ITS OWN
 * PROVENANCE. Every suppression it writes carries source `email_footer_unverified`
 * — the ledger says plainly that this request arrived on a path whose credential
 * was an identifier and not a proof of possession. The compliance record should
 * not claim more certainty than the mechanism earned.
 *
 * The m493 token surface (`/unsubscribe/{token}`, app/api/unsubscribe/token) is
 * the shape that does not have any of these properties, and is what new senders
 * should emit.
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { addSuppression, type SuppressionChannel } from "@/lib/kernel/compliance/check-suppression"
import { applyLeadOptOut, type LeadOptOutChannel } from "@/lib/lead-intent/lead-opt-out"
import { checkPublicRateLimit, publicCallerIp } from "@/lib/security/public-rate-limit"

/**
 * The ledger marker for this path. Written to `contact_suppression_list.source`
 * and, through addSuppression, to `contact_consent_events.consent_source`.
 * Greppable: it is how you find every suppression whose only credential was a
 * leakable identifier, on the day the signed/tokenised link replaces this one.
 */
const UNVERIFIED_SOURCE = "email_footer_unverified"

const APPLY_LIMIT = { limit: 10, windowMs: 60_000 }

/** The legacy shape only ever emitted 'email'; 'sms' was already accepted, and
 *  'mail' is admitted now that both suppression writers can express it. */
const ALLOWED: SuppressionChannel[] = ["email", "sms", "mail"]

/** contact_suppression_list.channel vocabulary → the lead row's own spelling. */
const LEAD_CHANNEL: Record<"email" | "sms" | "mail", LeadOptOutChannel> = {
  email: "email",
  sms: "sms",
  mail: "direct_mail",
}

export async function POST(req: NextRequest) {
  try {
    const ip = await publicCallerIp()
    const verdict = checkPublicRateLimit("unsub-legacy", ip, APPLY_LIMIT)
    if (!verdict.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a moment and try again." },
        { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
      )
    }

    const { contactId, channel } = await req.json()

    if (!contactId || !channel) {
      return NextResponse.json({ error: "contactId and channel are required" }, { status: 400 })
    }
    if (typeof contactId !== "string" || !ALLOWED.includes(channel as SuppressionChannel)) {
      return NextResponse.json({ error: "channel must be email, sms or mail" }, { status: 400 })
    }
    const ch = channel as "email" | "sms" | "mail"

    const supabase = createServiceClient()

    // ── RESOLVE THE ID ACROSS THE THREE SPACES IT MAY BE IN ──────────────────
    // Defect 1 above is that this route assumed one and the sender emits another.
    // Rather than swap one guess for another, resolve across all three shapes the
    // footer can actually carry, most likely first. Each read is destructured;
    // a refused read must never be reported as "no such contact", because that
    // sends a real person away believing their link is dead.

    // (a) contacts.id — what assemble-email actually stamps today.
    const { data: byId, error: byIdErr } = await supabase
      .from("contacts")
      .select("id, brokerage_id, email, phone")
      .eq("id", contactId)
      .maybeSingle()
    if (byIdErr) return unreadable("contacts.id", byIdErr.message)

    // (b) contacts.contact_id — the secondary unique uuid this route used to
    //     query. Nothing is known to emit it, but it costs one indexed read and
    //     removes the possibility that some caller elsewhere does.
    let contact = byId as { id: string; brokerage_id: string; email: string | null; phone: string | null } | null
    if (!contact) {
      const { data: bySecondary, error: bySecondaryErr } = await supabase
        .from("contacts")
        .select("id, brokerage_id, email, phone")
        .eq("contact_id", contactId)
        .maybeSingle()
      if (bySecondaryErr) return unreadable("contacts.contact_id", bySecondaryErr.message)
      contact = bySecondary as typeof contact
    }

    if (contact) {
      // NOTE THE VALUE PASSED: `contact.id`, never `contact.contact_id`. That
      // substitution is defect 2 — the FK target is contacts(id), so the other
      // uuid is a foreign-key violation that addSuppression swallows.
      const applied = await addSuppression({
        brokerageId: contact.brokerage_id,
        contactId: contact.id,
        email: ch === "email" ? contact.email : null,
        phone: ch === "sms" ? contact.phone : null,
        channel: ch,
        reason:
          ch === "email"
            ? "Unsubscribed via email footer link"
            : ch === "sms"
              ? "Opted out via unsubscribe page"
              : "Opted out of mail via unsubscribe page",
        source: UNVERIFIED_SOURCE,
      })

      // addSuppression NOW REPORTS. It used to return void, which is why the
      // read-back below had to exist at all. Check the reported result first —
      // it carries the REAL refusal (the FK violation, the zero-row contact
      // update), which a read-back can only ever render as "absent".
      if (!applied.suppressed || applied.contactFlagsUpdated === false) {
        console.error(
          `[/api/unsubscribe] suppression for contact ${contact.id} channel ${ch} was REFUSED:`,
          applied.errors.join(" | ") || "(no error reported)",
        )
        return NextResponse.json(
          { error: "We could not record that right now. Please try again." },
          { status: 503 },
        )
      }

      // The read-back is KEPT as the independent confirmation: the result above
      // is this process's account of its own writes; this is the database's.
      const landed = await suppressionLanded(supabase, contact.brokerage_id, contact.id, ch)
      if (landed !== true) {
        console.error(
          `[/api/unsubscribe] suppression for contact ${contact.id} channel ${ch} ${landed === false ? "was NOT written" : "could not be confirmed"}`,
        )
        return NextResponse.json(
          { error: "We could not record that right now. Please try again." },
          { status: 503 },
        )
      }

      return NextResponse.json({ success: true })
    }

    // (c) leads.id — defect 3. When dispatchEmail is given a leadId and no
    //     contactId, the footer carries a LEAD id, and this route used to point
    //     it at `contacts` where it can never be found. applyLeadOptOut is the
    //     lead-side authority and writes both the flags and the bridge rows.
    const { data: lead, error: leadErr } = await supabase
      .from("leads")
      .select("id, brokerage_id")
      .eq("id", contactId)
      .maybeSingle()
    if (leadErr) return unreadable("leads.id", leadErr.message)

    if (lead) {
      const l = lead as { id: string; brokerage_id: string }
      const result = await applyLeadOptOut({
        brokerageId: l.brokerage_id,
        leadId: l.id,
        channel: LEAD_CHANNEL[ch],
        // The closest honest member of the source union: the request arrived
        // through the footer of a message we sent, not through a session.
        source: ch === "mail" ? "inbound_direct_mail" : "inbound_email",
        rawMessage: `Unsubscribed via ${ch} footer link (unverified identifier path)`,
      })
      if (!result.applied) {
        console.error(`[/api/unsubscribe] lead opt-out refused for ${l.id}:`, result.error)
        return NextResponse.json(
          { error: "We could not record that right now. Please try again." },
          { status: 503 },
        )
      }
      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: "Contact not found" }, { status: 404 })
  } catch (err: any) {
    console.error("[v0] /api/unsubscribe error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/** A refused read is OUR failure, never "we don't know you". 503, so it is retryable. */
function unreadable(where: string, message: string) {
  console.error(`[/api/unsubscribe] ${where} read refused:`, message)
  return NextResponse.json({ error: "We could not look that up right now. Please try again." }, { status: 503 })
}

/**
 * true / false / null — `null` means the check itself was refused, and is kept
 * distinct from `false` on purpose. We report success only on a definite `true`.
 */
async function suppressionLanded(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  contactId: string,
  channel: SuppressionChannel,
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("contact_suppression_list")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .limit(1)
  if (error) {
    console.error("[/api/unsubscribe] suppression read-back refused:", error.message)
    return null
  }
  return Array.isArray(data) && data.length > 0
}
