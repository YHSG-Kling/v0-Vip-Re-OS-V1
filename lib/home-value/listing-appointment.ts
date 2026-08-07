// lib/home-value/listing-appointment.ts
//
// THE 7-DAY RULE — one definition, no second copy anywhere.
//
// The owner's ruling names TWO different meetings and they are NOT the same booking:
//
//   1. "the ability to schedule an appointment to EVALUATE their property"
//      — the walk-through. The agent stands in the house and looks at it. Booked from
//        the result page right after the form. Its lead time is the existing 48 hours
//        (app/actions/home-value.ts::getAvailableAgentSlots): a seller who just asked
//        "what's my home worth" wants somebody there SOON, and making them wait a week
//        for a walk-through is how the lead goes cold. That constant is not this one.
//
//   2. "both the email and the portal will be given a way to schedule a LISTING
//      appointment AS WELL which needs to be atleast 7 days out"
//      — the presentation meeting where the agent asks for the listing. THIS is what
//        the number below governs, and only this.
//
// WHY SEVEN, stated so nobody "optimises" it away as an arbitrary delay:
// the pre-listing seller drip (lib/listing-presentation/section-drip.ts) schedules the
// listing presentation's SEVEN sections evenly across the window between now and
// `appointmentAt - buffer`. That window IS the seven days. Book the meeting for
// Thursday and the drip has to fire the whole sequence into two days, which is not a
// drip — it is a blast, and the seller walks into the meeting having skimmed none of
// it. The lead time is the runway the sequence needs to do its job.
//
// SELLER-SAFETY BOUNDARY, kept explicit: that drip is deliberately PRICE-WITHHELD —
// it sells the market and the team and defers the home's number to the meeting. The
// home-value report this lane sends is the opposite by design: it shows this seller
// THEIR OWN estimated value, because that is the thing they asked for. Neither
// discipline belongs in the other, and nothing in this module carries a price.

/**
 * A listing appointment must be booked at least this many days from now.
 * The ONE definition of the rule — server enforcement, offered slots, portal copy
 * and email copy all read it from here so a UI can never show a time the server
 * will refuse.
 */
export const LISTING_APPOINTMENT_MIN_LEAD_DAYS = 7

/**
 * The earliest instant a listing appointment may start. Pure — `now` is injectable so
 * the server, the slot generator and any test all agree on the same boundary.
 */
export function earliestListingAppointmentAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + LISTING_APPOINTMENT_MIN_LEAD_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * What the seller is told when a posted time is inside the window. A client can post
 * any timestamp it likes; the server refuses with this and offers no alternative it
 * would also refuse.
 */
export const LISTING_APPOINTMENT_TOO_SOON_ERROR =
  `A listing appointment has to be at least ${LISTING_APPOINTMENT_MIN_LEAD_DAYS} days out — ` +
  `that lead time is what lets your agent prepare your listing plan properly. ` +
  `Please pick a later time.`
