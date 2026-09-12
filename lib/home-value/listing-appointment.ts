// lib/home-value/listing-appointment.ts
//
// THE 7-DAY RULE — one definition, no second copy anywhere.
//
// ONE MEETING, NOT TWO. The owner's ruling: "the 7 day floor is only for listing
// appointments (also called home value appointments)". The appointment a home-value
// seller books IS the listing appointment — the sit-down where the agent walks the
// property, presents the pricing strategy and the marketing plan, and asks for the
// listing. There is no second, earlier "walk-through evaluation" booking in this lane:
// this module used to argue for one with a 48-hour lead, and that split is retired.
// The home-value lane offers exactly one appointment and it carries the constant below.
//
// SCOPE OF THE FLOOR, stated so it does not spread. "ONLY for listing appointments."
// Showings, closings, buyer consultations and every other calendar_events.event_type
// have their own lead times and none of them read this constant. Grep before adding a
// caller: if the thing being booked is not the listing/home-value appointment, this is
// the wrong module.
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
