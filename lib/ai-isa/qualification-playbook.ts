/**
 * lib/ai-isa/qualification-playbook.ts
 *
 * Lane 74B — owner verbatim (wave 74): "the ai agents need to not be salesy
 * but also try to get them qualified so that they can setup a
 * meeting/showing, get their contact info, what their intent is, property
 * address that they are selling, determine their persona, etc. they can
 * setup followup whether calling them again when they are ready, sending a
 * list of properties that they just told us their criteria for, setting up a
 * time to look up their property value and give them a call back to discuss
 * or did they want to setup an appt for an agent to come out to
 * discuss/no obligation, etc. typical real estate talk unless there is a
 * competitor which is doing this another more inventive way. this goes for
 * the platform ai agents."
 *
 * THE ONE QUALIFICATION PLAYBOOK (CLAUDE.md §6 — one vocabulary per
 * function). Before this file, every customer-facing AI surface hand-rolled
 * its own qualification prose in its own words:
 *   - app/actions/ai-isa/handle-inbound-email.ts's baseSystem bullet list
 *     ("Qualify leads with genuine warmth…", "mark_qualification: when the
 *     lead reveals stronger or weaker buying signals…")
 *   - app/api/widget/message/route.ts's inline template literal ("qualify
 *     their intent (buying or selling), and naturally collect their name,
 *     email, and phone number…")
 *   - lib/voice/reception-brain.ts's buildReceptionPrompt job list ("(1)
 *     learn who is calling… (2) find out what they need… (3) offer to book
 *     an appointment… (5) if they mention selling… offer a real valuation
 *     and capture their property address…")
 *   - app/api/portal/ai-chat/route.ts and app/api/did/custom-llm/route.ts's
 *     servicing rules (no qualification prose, but the SAME follow-up menu
 *     belongs there once a known contact raises new intent mid-conversation)
 * Four spellings of the same six goals, drifting independently every time
 * one surface's prose was tuned and the other three were not. This file is
 * the merge target — every surface below MOUNTS `buildQualificationPrompt`
 * instead of writing its own qualification bullets; the old prose is
 * tombstoned in place (file:line) naming this file as the survivor.
 *
 * ── THE GOALS (never invented per-surface — one list, `QUALIFICATION_GOALS`) ──
 *   1. contact_info    — name + (email OR phone), collected naturally, never
 *                         demanded up front.
 *   2. intent          — buy / sell / both / invest / rent / relocate.
 *   3. persona         — the m589 contact_persona vocabulary (divorce,
 *                         downsize, expired, first_time, foreclosure, fsbo,
 *                         investor, luxury, military, other, probate,
 *                         relocated, senior, upsize) — inferred from what
 *                         they SAY, never guessed from demographics.
 *   4. seller_address   — when intent includes selling: the property address
 *                         they are selling (their OWN home — contacts.address
 *                         / leads.address already carries this; no new column).
 *   5. buyer_criteria   — when intent includes buying/renting: area, price
 *                         range, beds/baths, property type.
 *   6. timeline         — the live CHECK bucket vocabulary ONLY (CLAUDE.md §5:
 *                         "Timeline stays in buckets 1-3 / 3-6 / 6-12, never
 *                         30/60/90"): immediate / 1-3_months / 3-6_months /
 *                         6-12_months / 12+_months / researching.
 *   7. financing_status — for a buyer: cash / pre_approved /
 *                         needs_pre_approval / unknown (contacts.lender_status
 *                         / leads.lender_status — the live CHECK vocabulary).
 *   8. representation   — (lane 77A) whether they are ALREADY working with an
 *                         agent. Every working ISA asks it (Lofty's 'AI: Has
 *                         Agent' tag, Roof AI's "agent representation status",
 *                         CINC/Structurely intake); it decides whether the
 *                         conversation is a hand-off or a courtesy. No live
 *                         column — record_qualification appends it to
 *                         qualification_summary (blind spot published in the
 *                         lane notes).
 *   9. follow_up_preference — (lane 77A) the best channel and time for the
 *                         agent's follow-up, in their words — the hand-off
 *                         detail every competitor captures last ("what's the
 *                         best way for an agent to follow up?").
 *
 * ── THE CONVERSATIONAL RULES (never salesy — the owner's own words) ────────
 * Helpful and curious, not a script being read at someone. One question at a
 * time — never a form disguised as a sentence. Mirror the person's own words
 * back rather than reframing them in sales language. Offer something useful
 * BEFORE asking for something (a real answer, a market fact, an honest "I
 * don't know, let me find out") — value first, ask second. Never manufacture
 * urgency or pressure toward a decision; the follow-up menu below exists
 * exactly so nobody has to be pushed into a same-call yes. Plain, typical
 * real-estate conversation — the tone a good local agent already uses on the
 * phone, not a chatbot script. This block doubles as the
 * fair-housing-safe-phrasing rule for the WRITING prompt (CLAUDE.md §5: fair
 * housing belongs in the writing prompt, not only a post-hoc scan) — capture
 * only what the PERSON states about the property/criteria they want; never
 * characterize a neighborhood, steer toward or away from an area, or infer a
 * demographic fact about them.
 *
 * ── THE FOLLOW-UP MENU (never invented — mirrors the ACTION tools in
 *    lib/ai-isa/customer-context-tools.ts) ───────────────────────────────────
 *   - schedule_callback         — call them back when THEY say they're ready
 *   - send_matching_listings    — the properties matching the criteria they
 *                                 just described
 *   - schedule_home_value_review — record the address and book a discuss-it
 *                                 callback (never a value spoken by the AI)
 *   - book_listing_appointment  — a no-obligation LISTING APPOINTMENT: the
 *                                 model calls find_listing_appointment_slots
 *                                 first, offers real times ≥7 days out off
 *                                 the agent's own connected calendar, and
 *                                 books the one the person picks (wave 75,
 *                                 owner: "the no obligation meeting should be
 *                                 marked as a listing appointment ... the
 *                                 calendar should be hooked up so that the ai
 *                                 agent can find a time and day that works
 *                                 for the person and set up the appt right
 *                                 then and the agent just confirms it")
 *   - request_showing           — see a specific property, meet, or call now
 *   - send_newsletter           — stay in the loop without committing further
 *   - send_market_report        — condition/trend for their area, never a $
 *   - send_explainer_video      — a buying/selling process explainer video
 *   - request_vendor_referral   — a lender intro (pre-approval) or a trusted
 *                                 vendor from the brokerage's own bench (76A)
 *   - capture_referral          — a sphere contact's friend/family referral,
 *                                 onto the existing referrals rail (76A)
 * The model picks ONE that matches what the PERSON asked for — never
 * several at once, never a forced choice. lib/ai-isa/capability-catalogue.ts
 * (lane 75B) is the wider registry these mirror — see its header.
 *
 * ── COMPETITOR AWARENESS (wave 74, "unless there is a competitor which is
 *    doing this another more inventive way") ──────────────────────────────
 * docs/ai-agent-tool-surfaces-2026-09.md §"Qualification playbook" records
 * the 2026 conversational-AI-ISA competitive scan (Structurely, Ylopo, Lofty,
 * Follow Up Boss AI, Roof AI) and which of their more inventive moves this
 * playbook adopted vs. declined, with reasons — this file is where the
 * ADOPTED ones live in the actual prompt, not a second list.
 * Lane 77A re-ran the scan (sources in scratchpad lane77A-notes.md:
 * Structurely/CINC "Alex" qualification engine, Ylopo rAIya, Lofty Sales
 * Agent tag table + qualification process, Roof AI lead-qualification data
 * points, Rechat Lucy, tradeworksai's bot-to-human hand-off protocol,
 * Perspective AI's pre-listing discovery playbook) and adopted three moves:
 *   (a) the REPRESENTATION ask ("already working with an agent?") and the
 *       FOLLOW-UP-PREFERENCE ask, as goals 8 and 9 above;
 *   (b) the HOT / WARM / COLD hand-off rule (`handoffRuleBlock`): right-away
 *       + pre-approved/specific property → the agent calls now (request_
 *       showing / schedule_callback and say so); 1-6 months → book the
 *       appointment or value-review callback; 12+ / researching → newsletter
 *       or market report and let nurture run — never pushed;
 *   (c) the seller NEXT-STEP ask ("a value review call, or an agent coming
 *       out — no obligation?") spoken as a choice, not a close.
 * Declined: Lofty-style scoring tags in the prompt (record_qualification
 * already writes the real columns), and any competitor move that quotes a
 * home value in-conversation (owner ruling stands: the agent speaks the number).
 *
 * ── SURFACE VARIANTS ────────────────────────────────────────────────────────
 * `buildQualificationPrompt` is mounted on EVERY AI-agent surface (tenant and
 * platform), but not every surface talks to a real-estate buyer/seller under
 * a persona:
 *   - isa_email / widget / did_avatar / voice_reception / voice_outbound /
 *     portal — the FULL playbook: goals + conversational rules + follow-up
 *     menu, persona-flavored.
 *   - platform_reception — the PLATFORM's own line answers PROSPECTS ASKING
 *     ABOUT THE SOFTWARE, not a home buyer/seller; mounting the real-estate
 *     goals there would be inventing facts about a caller who is not
 *     discussing a property. This surface gets the CONVERSATIONAL RULES ONLY
 *     (never salesy, one question at a time, value first) — the "this goes
 *     for the platform ai agents" half of the ruling — never the
 *     buyer/seller goal list.
 *   - staff_copilot — the in-app agent copilot never itself talks to a
 *     client; it DRAFTS on staff's behalf (draft_ai_reply). It gets a
 *     COMPACT reference block so a drafted client message follows the same
 *     non-salesy discipline, not the full first-person goal list.
 */

import type { ToolPersona } from "./persona-tool-policy"
import type { BrandPlaybookContext } from "./brand-playbook-context"

export type QualificationSurface =
  | "isa_email"
  | "widget"
  | "portal"
  | "did_avatar"
  | "voice_reception"
  | "voice_outbound"
  | "platform_reception"
  | "staff_copilot"

/** Surfaces that get the FULL real-estate qualification goal list. */
const REAL_ESTATE_SURFACES: readonly QualificationSurface[] = [
  "isa_email", "widget", "portal", "did_avatar", "voice_reception", "voice_outbound",
]

export interface QualificationGoal {
  key: string
  label: string
  detail: string
}

/** ONE list — the seven goals, in the order a natural conversation actually
 *  surfaces them. Every surface reads THIS list; none writes its own. */
export const QUALIFICATION_GOALS: readonly QualificationGoal[] = [
  { key: "contact_info", label: "Contact info", detail: "their name and a way to reach them (email or phone) — collected naturally as the conversation earns it, never demanded up front" },
  { key: "intent", label: "Intent", detail: "are they buying, selling, both, investing, renting, or relocating" },
  { key: "persona", label: "Persona", detail: "what's driving the move — first-time buyer, downsizing, upsizing, relocating, investor, luxury, military, senior, or a situation like divorce, probate, foreclosure, or an expired/FSBO listing — read from what they SAY, never guessed" },
  { key: "seller_address", label: "Property they're selling", detail: "if they mention selling, the address of the home they own and are selling" },
  // Lane 76A — what a working listing agent actually asks a seller BEFORE the
  // appointment (Structurely/Lofty/Noem seller intake: reason for selling,
  // condition/updates, whether it is already listed/FSBO/expired, and whether
  // they need to buy next — the 'both' case). Written by record_qualification.
  { key: "seller_situation", label: "Seller's situation", detail: "if they're selling: why they're moving (in their own words), the home's condition — move-in ready, needs minor updates, or needs major work — whether it's already listed, for-sale-by-owner, or an expired listing, and whether they'll also need to buy their next home" },
  { key: "buyer_criteria", label: "Buyer criteria", detail: "if they're buying or renting: the area, price range (or monthly rent), bedrooms/bathrooms, property type, must-haves, and for a renter the move-in date and pets" },
  { key: "timeline", label: "Timeline", detail: "a realistic window — right away, 1-3 months, 3-6 months, 6-12 months, 12+ months, or still just researching" },
  { key: "financing_status", label: "Financing status", detail: "for a buyer: paying cash, already pre-approved, still needs pre-approval, or not sure yet" },
  // Lane 77A — the two asks every working ISA captures that this list did not.
  { key: "representation", label: "Representation", detail: "whether they're already working with an agent — asked plainly and respected if yes (then help as a courtesy and stop qualifying)" },
  { key: "follow_up_preference", label: "Follow-up preference", detail: "the best way and time for the agent to follow up — call, text or email, and roughly when" },
] as const

/**
 * PURE (lane 78D, blind spot 9): the customer's follow-up preference, in their
 * words, mapped onto the EXISTING `preferred_channel` vocabulary
 * ('phone'|'email'|'sms' — the contact-capture contract in
 * lib/contact-pipeline/contact-capture.ts, a column on BOTH contacts and
 * leads) and a short `preferred_contact_time` phrase (contacts only; read by
 * app/actions/ai-calendar-management.ts). Lives beside the goal it serves so
 * the writer (customer-context-tools.ts record_qualification) and the proof
 * (scripts/qualification-playbook-simulator.ts) share one spelling. A sentence
 * that names no channel yields NO channel — never a guessed default.
 */
export function parseFollowUpPreference(text: string): { channel: "phone" | "email" | "sms" | null; time: string | null } {
  const t = text.toLowerCase()
  const channel: "phone" | "email" | "sms" | null =
    /\b(text|sms|message me)\b/.test(t) ? "sms"
    : /\b(e-?mail)\b/.test(t) ? "email"
    : /\b(call|phone|ring)\b/.test(t) ? "phone"
    : null
  const timeMatch = /\b(mornings?|afternoons?|evenings?|weekends?|weekdays?|after \d{1,2}(?::\d{2})?\s?(?:am|pm)?|before \d{1,2}(?::\d{2})?\s?(?:am|pm)?|lunch(?:time)?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)\b/
  const time = timeMatch.exec(t)?.[1] ?? null
  return { channel, time: time ? time.trim().slice(0, 60) : null }
}

export interface FollowUpOption {
  tool: string
  label: string
  when: string
}

/**
 * ONE menu — mirrors lib/ai-isa/capability-catalogue.ts's CAPABILITY_CATALOGUE
 * (lane 75B; wave 74's own version mirrored lib/ai-isa/customer-context-
 * tools.ts's free tools directly — the catalogue is now the wider registry
 * both this menu and every settings/docs surface read, CLAUDE.md §6). Every
 * `tool` name here MUST be a real, registered tool name — the existing
 * proof (scripts/qualification-playbook-simulator.ts) asserts the menu and
 * the catalogue name IDENTICAL tool sets.
 */
export const QUALIFICATION_FOLLOW_UP_MENU: readonly FollowUpOption[] = [
  { tool: "schedule_callback", label: "Call them back later", when: "they're interested but not ready to talk further right now — ask when a good time to call back is" },
  { tool: "send_matching_listings", label: "Send matching listings", when: "they described buyer/renter criteria — send what matches, and keep sending as new matches come in" },
  { tool: "schedule_home_value_review", label: "Look up their home's value", when: "they mentioned selling or asked what their home is worth — record the address and schedule a callback; the AGENT states the number, never you" },
  { tool: "book_listing_appointment", label: "Book a no-obligation listing appointment", when: "they want an agent to come out and talk it through — find real times at least a week out on the agent's calendar (call find_listing_appointment_slots first), offer 2-3, and book the one they pick; make clear it's no-obligation" },
  { tool: "request_showing", label: "Request a showing / meeting / call now", when: "they want to see a specific property, meet, or talk right away" },
  { tool: "send_newsletter", label: "Send the newsletter", when: "they want to stay in the loop without committing to anything else right now" },
  { tool: "send_market_report", label: "Send a market report for their area", when: "they ask about the market, pricing trends, or whether now is a good time — share the CONDITION and TREND, never a dollar figure" },
  { tool: "send_explainer_video", label: "Send a process explainer video", when: "a first-time buyer or an unsure seller wants to understand the steps before committing to anything" },
  // Lane 76A — the two persona asks the menu did not cover: a buyer who still
  // needs pre-approval (a lender intro from the brokerage's own bench — a lender
  // is a VENDOR CATEGORY, CLAUDE.md §4) or a past client who needs a plumber/
  // contractor/mover, and a sphere contact who mentions a friend/family member
  // who is buying or selling (the referral capture every past-client program is
  // built around).
  { tool: "request_vendor_referral", label: "Connect them with a trusted vendor (lender, inspector, mover, contractor…)", when: "a buyer still needs pre-approval and wants a lender to talk to, or a past client / seller needs a trusted vendor — offer an intro from the brokerage's own bench, never a random name" },
  { tool: "capture_referral", label: "Capture a referral", when: "a past client, friend or sphere contact mentions someone else who is thinking of buying, selling or renting — get the person's name and a way to reach them, with permission, and hand it to the agent" },
] as const

// ─── PER-PERSONA QUESTION GUIDE (lane 76A) ───────────────────────────────────
//
// Owner, wave 76 verbatim: "the persona tools I believe are not realistic as
// far as the questions or info that they would be looking for." The seven
// goals above are the WHAT; this table is the HOW for each persona — the
// questions a working agent actually asks and the things they actually offer,
// distilled from the 2026 competitor scan (lane 76A: Structurely/Aisa Holmes,
// Ylopo rAIya, Lofty Sales Agent tags, CINC AI script goals, Alma/Noem/
// Hyperleap receptionist intake, TalkLuna leasing intake; lane 77A re-scan:
// CINC "Alex"/Structurely qualification engine, Lofty's qualification-process
// + tag table, Roof AI's lead-qualification data points, Rechat Lucy, the
// tradeworksai hand-off protocol, Perspective AI's pre-listing discovery — all
// cited in scratchpad lane77A-notes.md). Every `offers` entry names a
// REGISTERED tool by its exact name (scripts/qualification-playbook-
// simulator.ts holds this table against the capability catalogue), so the
// prompt can never promise a tool that does not exist. `staff`/platform/
// vendor are NOT personas here — a seat gets its tools from
// lib/ai-isa/user-type-tool-policy.ts (lane 77A tombstone below).
export interface PersonaQuestionGuide {
  /** The questions this persona expects, in the order a conversation earns them. */
  asks: readonly string[]
  /** Tool names this persona is realistically OFFERED (subset of the registered tools). */
  offers: readonly string[]
  /** Lane 79B — the INFO the conversation must end with for this persona:
   *  QUALIFICATION_GOALS keys (never a second spelling) — what
   *  record_qualification should hold before the agent takes over. */
  infoNeeded: readonly string[]
  /** Lane 79B — the conversational LADDER (owner: "not salesy but… get them
   *  qualified"): value first, one ask per rung, the offer LAST. Rendered
   *  into the prompt as numbered rungs the model climbs in order, never a
   *  form. Every rung is typical real-estate talk, not a sales script. */
  ladder: readonly string[]
}

/** The owner's five follow-up offers (wave 74/79) — the set every persona's
 *  `offers` must draw at least two from, and the sphere/seller pair must
 *  include the no-number value review. One list; the proof holds it. */
export const OWNER_FOLLOW_UP_OFFERS: readonly string[] = [
  "schedule_callback",           // call them again when they are ready
  "send_matching_listings",      // the list of properties matching the criteria they just gave
  "schedule_home_value_review",  // a time to look up their value and call back — the AI never speaks a number
  "book_listing_appointment",    // an agent coming out to discuss — no obligation
  "request_showing",             // a showing / meeting
] as const

export const PERSONA_QUESTION_GUIDE: Record<ToolPersona, PersonaQuestionGuide> = {
  seller: {
    // The pre-listing discovery a listing agent runs BEFORE the appointment
    // (Perspective AI's 2026 playbook: motivation, timeline, price expectation
    // captured before the meeting so the appointment is a confirmation, not a
    // pitch; Roof AI: "address, timeline, listing situation"; Lofty: 'Intend
    // to Sell' → home evaluation appointment). NEVER a number from us.
    asks: [
      "the address of the home they're selling",
      "what's prompting the move (their words — never assume)",
      "their timeline in a bucket: right away, 1-3, 3-6, 6-12 months, or just researching",
      "the home's condition and any recent updates (move-in ready, minor updates, major work)",
      "whether it's already listed, for-sale-by-owner, an expired listing — or whether they're already working with an agent",
      "what they have in mind on price, in THEIR words only — you never suggest, estimate or react to a number; the agent brings the value to the call",
      "whether they'll also need to buy their next home (then run the buyer questions too)",
      "which next step suits them: a call once the agent has reviewed the home's value, or an agent coming out to talk it through — no obligation, at least a week out",
    ],
    offers: ["schedule_home_value_review", "book_listing_appointment", "send_market_report", "send_explainer_video", "schedule_callback", "request_vendor_referral"],
    infoNeeded: ["contact_info", "intent", "seller_address", "seller_situation", "timeline", "representation", "follow_up_preference"],
    ladder: [
      "Answer what they actually asked first (a market fact, a process answer, or an honest 'let me find out') — value before any question.",
      "Ask what's prompting the move, in their words, and the address of the home (lookup_property_facts can confirm beds/baths/year built — never a value).",
      "Ask the timeline bucket, then the home's condition and whether it's already listed, FSBO or expired.",
      "Ask whether they're already working with an agent — if yes, help as a courtesy and stop qualifying.",
      "Ask if they'll need to buy next (then run the buyer ladder too), and record everything with record_qualification.",
      "Offer ONE next step as a choice, not a close: a call once the agent has reviewed the home's value, or an agent coming out — no obligation, a week or more out. Confirm how and when they'd like the follow-up.",
    ],
  },
  buyer: {
    // The buyer intake every ISA converges on (CINC/Structurely: location,
    // beds/baths, price, financing, agent relationship; inboundrem's six:
    // budget AS A RANGE, financing readiness, timeline, location, PURPOSE —
    // own home vs investment — and contact preference).
    asks: [
      "the area(s) or neighborhoods they're focused on",
      "a price range (a range, not an exact figure — it lowers resistance), bedrooms/bathrooms, property type and must-haves",
      "whether this is a home to live in or an investment (an investment changes the whole conversation — switch to the investor questions)",
      "their timeline bucket",
      "whether they're pre-approved, paying cash, or still need a lender (offer a lender intro from our bench if they need one)",
      "whether they're already working with an agent",
      "whether they also have a home to sell first (then run the seller questions too)",
      "whether there's a specific listing that prompted the conversation, and if they'd like to see it",
      "the best way and time for the agent to follow up",
    ],
    offers: ["send_matching_listings", "get_listing_details", "request_showing", "request_vendor_referral", "send_explainer_video", "send_market_report", "schedule_callback"],
    infoNeeded: ["contact_info", "intent", "buyer_criteria", "timeline", "financing_status", "representation", "follow_up_preference"],
    ladder: [
      "Answer the question that brought them in (a listing's facts via get_listing_details / lookup_property_facts, whether it's still available, what the area's inventory looks like) — value first.",
      "Ask the area(s) and what matters most in the home; then a price RANGE, beds/baths and must-haves — one at a time.",
      "Ask whether it's a home to live in or an investment (an investment switches to the investor ladder), and the timeline bucket.",
      "Ask about financing plainly — pre-approved, cash, or still need a lender (offer a lender intro from our bench, never a random name).",
      "Ask whether they're already working with an agent, and whether they have a home to sell first (then run the seller ladder too). Record with record_qualification.",
      "Offer ONE next step: matching listings as they come in, a showing of the home they asked about, or a callback when they're ready — and the best way/time to follow up.",
    ],
  },
  investor: {
    // Property-only by ruling (wave 68/69): comps/search PREVIEW and matching
    // listings, never an owner's contact details. No explainer video. The buy
    // box is the whole conversation (property type drives the analysis —
    // SFR vs 2-4 unit vs 5+ vs condo/STR vs land — the realestate skill's
    // own property-type split).
    asks: [
      "their buy box: area, price range, property type (single-family, 2-4 unit, 5+ unit, condo, short-term rental, land) and strategy (buy-and-hold, flip, BRRRR, short-term rental)",
      "whether they're financing or paying cash, and how soon they want to place capital",
      "how many deals they're looking to do this year, and whether they already own rentals in the area",
      "whether they'd like matching on-market and off-market opportunities sent as they come up",
      "the best way and time for the agent to follow up",
    ],
    offers: ["send_matching_listings", "get_listing_details", "request_showing", "send_market_report", "search_offmarket_opportunities", "schedule_callback"],
    infoNeeded: ["contact_info", "intent", "buyer_criteria", "timeline", "financing_status", "follow_up_preference"],
    ladder: [
      "Lead with what we can actually show: on-market inventory that fits, and — once they're a contact — the off-market / likely-to-sell matches already cached for their buy box (search_offmarket_opportunities: property facts only, never an owner's contact).",
      "Ask the buy box one piece at a time: area, price range, property type, strategy (buy-and-hold, flip, BRRRR, short-term rental).",
      "Ask how they're funding it (cash, financing, 1031) and how soon they want to place capital — the timeline bucket.",
      "Ask deal volume this year and whether they already hold rentals in the area; record with record_qualification.",
      "Offer ONE next step: matching on-market and off-market opportunities as they come up, a showing/walk-through of one, or a callback — and how they want to be reached.",
    ],
  },
  renter: {
    // TalkLuna/Lofty renter intake, plus the ONE ask that turns a renter into
    // a future buyer — the repo's own rental-graduation lane
    // (lib/lead-pipeline/rental-graduation-sourcer.ts) exists for exactly it.
    asks: [
      "the area they want to rent in",
      "monthly budget, bedrooms, and move-in date",
      "pets and lease length",
      "whether they'd like to tour a specific rental",
      "whether buying is something they'd consider down the road (never pushed — just so the agent can keep them posted)",
    ],
    offers: ["send_matching_listings", "get_listing_details", "request_showing", "schedule_callback"],
    infoNeeded: ["contact_info", "intent", "buyer_criteria", "timeline", "follow_up_preference"],
    ladder: [
      "Answer what they asked about the rental first (facts, availability, whether pets are OK) — value first.",
      "Ask the area, monthly budget and bedrooms, then move-in date — one at a time.",
      "Ask pets and lease length; record with record_qualification.",
      "Mention, never push, that when buying is ever on the table the agent can keep them posted.",
      "Offer ONE next step: matching rentals as they list, a tour of the one they asked about, or a callback when they're ready.",
    ],
  },
  relocation: {
    asks: [
      "where they're moving to and roughly when — and whether a job or employer date is driving it",
      "whether they're buying or renting on arrival, and their price range",
      "commute or other practical constraints THEY raise (never characterize an area for them)",
      "whether they need to sell a home where they are now (then run the seller questions too)",
      "whether a virtual tour or a visit trip is planned, and whether they're already working with an agent on either end",
    ],
    offers: ["send_matching_listings", "send_market_report", "get_listing_details", "request_showing", "request_vendor_referral", "schedule_callback"],
    infoNeeded: ["contact_info", "intent", "buyer_criteria", "seller_address", "timeline", "representation", "follow_up_preference"],
    ladder: [
      "Answer the practical question first — how the market here works, what a budget buys, how a remote purchase or rental typically goes — value first, never a characterization of an area.",
      "Ask where they're moving to and roughly when (a job or employer date often drives it) — the timeline bucket.",
      "Ask whether they'll buy or rent on arrival and their price range; ask only the constraints THEY raise (commute, timing).",
      "Ask whether they need to sell where they are now (then run the seller ladder), and whether they're working with an agent on either end.",
      "Offer ONE next step: matching listings for the move, a market report for the area, a virtual tour / visit-trip showing, or a callback — record with record_qualification.",
    ],
  },
  sphere: {
    // The past-client / lifetime-customer conversation (Rechat Lucy's
    // birthdays + home anniversaries, every referral program's "anyone you
    // know?"). Value first: the equity check-in is the offer, never a pitch.
    asks: [
      "how they've been since closing / their home anniversary",
      "whether they'd like an updated look at their home's equity (the AGENT prepares and speaks the number)",
      "whether they need a trusted vendor — contractor, plumber, mover, lender for a refinance",
      "whether anyone they know is thinking of buying, selling or renting (with permission to pass the name along)",
      "whether they themselves are thinking of a move (then run the seller or buyer questions)",
    ],
    offers: ["schedule_home_value_review", "request_vendor_referral", "capture_referral", "send_market_report", "send_newsletter", "schedule_callback"],
    infoNeeded: ["contact_info", "intent", "follow_up_preference"],
    ladder: [
      "Open with them, not with business: how they've been since closing, the home anniversary — and answer anything they ask.",
      "Offer the equity check-in as a gift, not a pitch: the agent prepares the number and calls (schedule_home_value_review) — never a figure from you.",
      "Ask whether they need a trusted vendor for anything (contractor, plumber, mover, a refinance lender) — an intro from our own bench.",
      "Ask, with permission, whether anyone they know is thinking of buying, selling or renting (capture_referral).",
      "Only if THEY raise it: are they thinking of a move themselves — then run the seller or buyer ladder. Otherwise offer the newsletter or a market update and leave it there.",
    ],
  },
  // TOMBSTONE (lane 77A): the `vendor` guide lane 76A added here is GONE —
  // "vendors are not contact type, they are user type" (owner, wave 77). The
  // vendor SEAT's own asks/tools live in lib/ai-isa/user-type-tool-policy.ts
  // (USER_TYPE_TOOL_POLICY.vendor + seatPromptBlock), mounted by
  // app/api/internal/ai-chat/route.ts for the vendor portal.
}

function personaGuideBlock(persona: ToolPersona | null | undefined): string {
  if (!persona) return ""
  const g = PERSONA_QUESTION_GUIDE[persona]
  if (!g) return ""
  const lines = [`THIS PERSON LOOKS LIKE A ${persona.toUpperCase()} — what they usually need to be asked (one at a time):`]
  for (const a of g.asks) lines.push(`- ${a}`)
  // Lane 79B — the ladder and the info the conversation must end with, as
  // DATA the routed model reads (never prose in a doc alone).
  lines.push("THE LADDER — climb it in order, one rung per turn, value before every ask, the offer last:")
  g.ladder.forEach((rung, i) => lines.push(`${i + 1}. ${rung}`))
  lines.push(`BEFORE THE AGENT TAKES OVER, record_qualification should hold: ${g.infoNeeded.join(", ")}.`)
  lines.push(`Follow-ups that fit this persona: ${g.offers.join(", ")}.`)
  if (persona === "buyer") lines.push("Note: 'buyer' is also the default for an unknown contact — confirm early whether they are buying, selling, or both.")
  return lines.join("\n")
}

// ── PLATFORM PROSPECT (lane 76B — "this goes for the platform ai agents") ──
// The platform's own line/chat talks to a SOFTWARE buyer (a brokerage, team,
// or agent evaluating the OS), so it gets its OWN goal list and its OWN
// three-exit menu — never the real-estate goals above. One list each, read by
// every platform surface (voice reception + the website prospect chat);
// scripts/platform-prospect-funnel-simulator.ts asserts every `tool` named in
// PLATFORM_EXIT_MENU is a registered tool in
// lib/platform/prospect-agent-tools.ts::PLATFORM_PROSPECT_TOOL_NAMES.

export const PLATFORM_QUALIFICATION_GOALS: readonly QualificationGoal[] = [
  { key: "contact_info", label: "Contact info", detail: "their name and a work email (phone is already on the call when they called in) — collected as the conversation earns it, never demanded up front" },
  { key: "brokerage_name", label: "Brokerage / team name", detail: "the business they run or work in" },
  { key: "size_seats", label: "Size", detail: "roughly how many agents / seats — solo, a team, a brokerage, or several offices" },
  // Lane 79B — wave 79 seat ruling: only PRODUCING seats are charged (staff /
  // admin seats are free), so the number that sizes a plan is the producers.
  { key: "producers_count", label: "Producing agents", detail: "of those, how many actually produce (list and sell) — those are the seats that count toward a plan; office staff and admins ride free" },
  { key: "role_title", label: "Their role", detail: "broker-owner, team lead, operations, marketing, or an agent — who decides on software" },
  { key: "current_tools", label: "Current tools", detail: "what they use today for CRM, lead follow-up, marketing, and transactions" },
  { key: "pain", label: "What hurts", detail: "the one thing they wish ran itself — in THEIR words" },
  { key: "timeline", label: "Timeline", detail: "when they want to be up and running — right away, 1-3 months, 3-6 months, 6-12 months, 12+ months, or still researching" },
  { key: "territory", label: "Territory", detail: "the markets / metro areas they work" },
  // Lane 79B — the "what would be most helpful next" ask (the 3-question
  // SaaS qualification pattern: fit, timing, intent) — never a forced choice.
  { key: "preferred_path", label: "Preferred path", detail: "what would be most helpful next — see it live (demo), try it themselves (free trial), start now (paid activation with the setup fee), or a callback when they're ready" },
] as const

/** THE EXITS every platform surface offers once a prospect is engaged — a
 *  live demo on a rep's calendar, the online signup link, a human, or (lane
 *  77B) the subscription started right there when they say yes. */
export const PLATFORM_EXIT_MENU: readonly FollowUpOption[] = [
  { tool: "book_demo_appointment", label: "Book a live demo", when: "they want to see it working — call find_demo_slots first, offer 2-3 real times, then book the one they pick (a rep confirms it and calendar invites go out)" },
  { tool: "send_signup_link", label: "Send the online signup link", when: "they'd rather start the free trial themselves later — text or email them the signup link" },
  { tool: "start_subscription", label: "Start their subscription now", when: "they say YES and want to start right now — confirm their work email, name and business name, fit the plan to their size unless they chose one, then ask which way they want to start and pass it as activation: the 14-day FREE TRIAL (no card, billing set up inside the app later) or ACTIVATE NOW (they complete a secure checkout for the plan plus the plan's one-time setup fee; their access opens when it clears). State the setup fee ONLY as the plan pricing above lists it — if no setup fee is listed, say the plan is quoted without one; never invent an amount and never offer to waive it. The account is created on the spot either way and the sign-in link goes to their email. If the tool says a person is needed — enterprise size, custom pricing, a CRM migration — hand off instead" },
  { tool: "request_human_handoff", label: "Hand off to a person", when: "they want to talk pricing, contracts, migration, or anything you can't answer — a real person follows up (on a call, offer the live transfer first when one is available)" },
  // Lane 79B — the same "call me when I'm ready" every customer persona gets:
  // a prospect who is interested but not ready is scheduled, never chased.
  { tool: "schedule_prospect_callback", label: "Call them back when they're ready", when: "they're interested but not ready to decide today (budget cycle, a partner to consult, a busy season) — ask when a good time is, record it, and the automated follow-up ladder stands down until then" },
] as const

/**
 * Lane 79B — the PLATFORM prospect's realistic question model (same shape as
 * PERSONA_QUESTION_GUIDE so the routed model reads one kind of data on every
 * surface). Sources: the 3-question SaaS qualification pattern (fit / timing
 * / "what would be most helpful next"), the vertical-SaaS brokerage
 * committee (broker-owner, tech director, team lead, ops, CFO), and the
 * wave-79 seat ruling (producing seats are the priced unit). Every `offers`
 * entry is a registered PLATFORM_PROSPECT_TOOL_NAMES tool.
 */
export const PLATFORM_PROSPECT_QUESTION_GUIDE: PersonaQuestionGuide = {
  asks: [
    "what they're trying to solve — the one thing they wish ran itself (their words)",
    "the brokerage / team name and what they run: solo, a team, a brokerage, or several offices",
    "roughly how many agents, and of those how many actually produce (producing seats are what a plan is priced on; staff and admins ride free)",
    "their role — broker-owner, team lead, ops, marketing, or an agent — and who else weighs in on software",
    "what they use today for CRM, lead follow-up, marketing and transactions (and what has to keep working — MLS/IDX, e-sign, transaction management)",
    "when they want to be up and running: right away, 1-3, 3-6, 6-12 months, or still researching",
    "the markets they work",
    "what would be most helpful next — see it live, try it themselves, start now, or a callback when they're ready",
  ],
  offers: ["book_demo_appointment", "send_signup_link", "start_subscription", "schedule_prospect_callback", "request_human_handoff"],
  infoNeeded: ["contact_info", "brokerage_name", "size_seats", "producers_count", "role_title", "current_tools", "pain", "timeline", "preferred_path"],
  ladder: [
    "Answer their actual question first — what the OS does for their situation, honestly, from the product content and the live plan bullets (show_product_demo when they want to SEE it).",
    "Ask what they're trying to solve, then who they are and what they run — name, business, role — and call save_prospect as soon as you learn any of it.",
    "Ask size in two halves: how many agents, and how many of those produce; then what they use today and what must keep working.",
    "Ask the timeline bucket; never manufacture urgency.",
    "Ask what would be most helpful next and offer ONE exit that matches: a live demo on a rep's real calendar, the signup link for a self-serve trial, starting now (trial or paid activation), a callback when they're ready, or a person for pricing/contracts/migration.",
  ],
}

function platformProspectGuideBlock(): string {
  const g = PLATFORM_PROSPECT_QUESTION_GUIDE
  const lines = ["WHAT A PROSPECT USUALLY NEEDS TO BE ASKED (one at a time, as the conversation earns it):"]
  for (const a of g.asks) lines.push(`- ${a}`)
  lines.push("THE LADDER — climb it in order, one rung per turn, value before every ask, the exit last:")
  g.ladder.forEach((rung, i) => lines.push(`${i + 1}. ${rung}`))
  lines.push(`BEFORE A REP TAKES OVER, save_prospect should hold: ${g.infoNeeded.join(", ")}.`)
  return lines.join("\n")
}

function platformGoalsBlock(): string {
  const lines = ["WHAT TO LEARN ABOUT THE PROSPECT, OVER THE COURSE OF THE CONVERSATION (one at a time, as it comes up naturally) — and call save_prospect as soon as you learn any of it:"]
  for (const g of PLATFORM_QUALIFICATION_GOALS) lines.push(`- ${g.label}: ${g.detail}`)
  return lines.join("\n")
}

function platformExitMenuBlock(): string {
  const lines = ["THE EXITS — once you understand what they want, offer the ONE that fits (never several at once, never forced):"]
  for (const f of PLATFORM_EXIT_MENU) lines.push(`- ${f.label} (${f.tool}): ${f.when}`)
  return lines.join("\n")
}

/** PURE — the "never salesy" conversational rules, shared by every surface
 *  that talks to a person (customer-facing or platform-prospect-facing
 *  alike). Doubles as the fair-housing-safe-phrasing rule for the writing
 *  prompt (CLAUDE.md §5). */
function conversationalRulesBlock(): string {
  return [
    "CONVERSATION STYLE — never salesy:",
    "- Be helpful and curious, not a script being read at someone.",
    "- Ask ONE question at a time — never stack several into one message; a form disguised as a sentence is still a form.",
    "- Mirror the person's own words back rather than reframing them in sales language.",
    "- If an answer is vague or conditional (\"it depends on the school district\", \"maybe next year\"), ask ONE gentle follow-up to understand the real constraint rather than recording it as a flat field — a real conversation, not a dropdown.",
    "- Offer something useful BEFORE asking for something — a real answer, a market fact, or an honest \"I don't know, let me find out\" — value first, ask second.",
    "- Never manufacture urgency or pressure toward a decision on this call/message. The follow-up menu exists so nobody has to be pushed into a same-conversation yes.",
    "- Fair housing: capture only what THEY state about the property or criteria they want; never characterize a neighborhood, never steer toward or away from an area, never infer a demographic fact about them.",
    "- Keep it typical real-estate conversation — the tone a good local agent already uses, not a chatbot script.",
  ].join("\n")
}

function goalsBlock(persona: ToolPersona | null | undefined): string {
  const lines = ["WHAT TO LEARN, OVER THE COURSE OF THE CONVERSATION (one at a time, as it comes up naturally):"]
  for (const g of QUALIFICATION_GOALS) {
    // A "buyer" is the UNKNOWN default (persona-tool-policy.ts) and may also be
    // selling ("both" is a live contact_type), so the seller goals are only
    // withheld from personas that are POSITIVELY not selling their own home.
    // (Lane 77A: the `vendor` branches lane 76A added here are gone — a vendor
    // is a seat, never a persona; see PERSONA_QUESTION_GUIDE's tombstone.)
    const notSellingOwnHome = persona === "investor" || persona === "renter"
    if ((g.key === "seller_address" || g.key === "seller_situation") && notSellingOwnHome) continue
    if (g.key === "buyer_criteria" && persona === "seller") continue
    if (g.key === "financing_status" && (persona === "seller" || persona === "sphere")) continue
    // A past client already HAS their agent — the representation ask is for a
    // new lead, never a lifetime customer.
    if (g.key === "representation" && persona === "sphere") continue
    lines.push(`- ${g.label}: ${g.detail}`)
  }
  return lines.join("\n")
}

/** PURE (lane 77A) — the HOT / WARM / COLD hand-off rule, adopted from the
 *  2026 competitor scan's bot-to-human protocol and re-spoken in this
 *  playbook's own never-salesy terms. Real-estate surfaces only. */
function handoffRuleBlock(): string {
  return [
    "WHEN TO HAND OFF (read from what they say, never pushed):",
    "- READY NOW (right away, pre-approved or paying cash, a specific property in mind, or they ask to talk): log it with request_showing or schedule_callback and tell them plainly the agent will reach out shortly — the agent's first message will reference this conversation, so they never repeat themselves.",
    "- A FEW MONTHS OUT (1-6 months): offer the ONE follow-up that fits — a home-value review callback or a no-obligation listing appointment for a seller, matching listings for a buyer/renter — and record what you learned.",
    "- LATER / JUST RESEARCHING (12+ months, 'just looking'): offer to keep them posted (newsletter or a market report for their area), record it, and let the follow-up run — no pressure, no re-asking next time.",
    "- ALREADY WITH AN AGENT: answer what you can as a courtesy, thank them, and stop qualifying.",
  ].join("\n")
}

function followUpMenuBlock(): string {
  const lines = ["FOLLOW-UP MENU — once you understand what they want, offer ONE of these that fits (never several at once, never forced):"]
  for (const f of QUALIFICATION_FOLLOW_UP_MENU) {
    lines.push(`- ${f.label} (${f.tool}): ${f.when}`)
  }
  return lines.join("\n")
}

export interface QualificationKnownFacts {
  hasContactInfo?: boolean
  intent?: string | null
  persona?: string | null
  timeline?: string | null
}

function knownFactsBlock(known: QualificationKnownFacts | undefined): string {
  if (!known) return ""
  const have: string[] = []
  if (known.hasContactInfo) have.push("contact info")
  if (known.intent) have.push(`intent (${known.intent})`)
  if (known.persona) have.push(`persona (${known.persona})`)
  if (known.timeline) have.push(`timeline (${known.timeline})`)
  if (have.length === 0) return ""
  return `ALREADY ON FILE — do not re-ask: ${have.join(", ")}.`
}

export interface BuildQualificationPromptInput {
  /** The tool persona this conversation resolved to (buyer/seller/investor/
   *  renter/relocation/sphere), when known. Null/undefined for a not-yet-
   *  captured or platform/staff surface. Never a user type (lane 77A). */
  persona?: ToolPersona | null
  surface: QualificationSurface
  /** What this conversation already knows, so the prompt does not ask the
   *  model to re-collect it. */
  known?: QualificationKnownFacts
  /**
   * Wave 75 owner ruling: "there should not only be a playbook but the brand
   * settings like brand voice, any other business process, brand knowledge
   * base, etc. needs to be included." The caller resolves this ONCE per
   * request via lib/ai-isa/brand-playbook-context.ts::loadBrandPlaybookContext
   * (brand voice cascade, brand KB, business processes/SOPs, office hours,
   * service areas — or the platform's own brand for `platform_reception`) and
   * passes the result straight through; this function never fetches it itself
   * (buildQualificationPrompt stays PURE). Omitted/null degrades to the
   * qualification rules alone — never a hard failure.
   */
  brand?: BrandPlaybookContext | null
}

/**
 * THE shared builder — every mounting surface calls this instead of writing
 * its own qualification prose. Additive: callers still prepend their own
 * identity/brand-voice/hard-rules blocks; this is the ONE qualification
 * section every one of them shares.
 */
export function buildQualificationPrompt(input: BuildQualificationPromptInput): string {
  const brandBlock = input.brand?.block?.trim() || ""

  if (input.surface === "platform_reception") {
    // "this goes for the platform ai agents" — the conversational discipline
    // applies; the real-estate goal list does not (a platform prospect is not
    // discussing a property). Lane 76B: the platform gets its OWN goals (the
    // software buyer's qualification) and its OWN three-exit menu (demo /
    // signup link / human). Brand here is the PLATFORM's own brand/KB
    // (loadBrandPlaybookContext({brokerageId: null, ...})) — never a tenant's.
    return [brandBlock, conversationalRulesBlock(), platformGoalsBlock(), platformProspectGuideBlock(), platformExitMenuBlock()].filter(Boolean).join("\n\n")
  }
  if (input.surface === "staff_copilot") {
    return [
      brandBlock,
      "WHEN DRAFTING A CLIENT-FACING MESSAGE (draft_ai_reply), follow the shared qualification playbook:",
      conversationalRulesBlock(),
      goalsBlock(input.persona ?? null),
      personaGuideBlock(input.persona ?? null),
      followUpMenuBlock(),
    ].filter(Boolean).join("\n\n")
  }

  const realEstatePersona = REAL_ESTATE_SURFACES.includes(input.surface) ? (input.persona ?? null) : null
  const parts = [
    brandBlock,
    conversationalRulesBlock(),
    goalsBlock(realEstatePersona),
    personaGuideBlock(realEstatePersona),
    followUpMenuBlock(),
    handoffRuleBlock(),
    knownFactsBlock(input.known),
  ].filter(Boolean)
  return parts.join("\n\n")
}
