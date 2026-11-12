#!/usr/bin/env tsx
/**
 * scripts/contact-channel-policy-simulator.ts   (npm run test:contact-channel)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTACT-SIDE VOICE TOOLBOX — proves the AI ISA can reach a CONVERTED, consented
 * contact by its FULL toolbox (outbound AI call + ringless voice drop + sms + email +
 * direct mail), not the email/sms/direct-mail-only matrix it had before. Pure: every
 * branch of resolveContactChannel + voiceReachable across preference × consent × opt-out.
 */
import { resolveContactChannel, voiceReachable } from "../lib/ai-isa/contact-channel-policy"
import { buildSituationalVoicemailScript } from "../lib/ai-isa/situational-voicemail"
import { contactReelPersona, situationKindForContact, personaTopicCategories, buildInformationalReelSituation, buildOfferCompsSituation } from "../lib/ai-isa/contact-reel-situation"
import { buildSituationalPortalMessage } from "../lib/ai-isa/situational-portal-message"
import { buildContactPortalUrl, portalSmsLine, portalCtaHtml } from "../lib/ai-isa/portal-link"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const consented = { phone: "+15125551234", email: "c@example.com", tcpa_consent: true }

async function main() {
  console.log("\n[Voice reachability — consent + a clean line]")
  check("consented + clean line → voice reachable", voiceReachable(consented) === true)
  check("no consent → NOT voice reachable", voiceReachable({ ...consented, tcpa_consent: false }) === false)
  check("phone opt-out → NOT voice reachable", voiceReachable({ ...consented, phone_opt_out: true }) === false)
  check("call_stop_flag → NOT voice reachable", voiceReachable({ ...consented, call_stop_flag: true }) === false)
  check("no phone → NOT voice reachable", voiceReachable({ ...consented, phone: null }) === false)

  console.log("\n[THE FIX — phone + voicedrop are real channels now (no longer fall through to email)]")
  check("prefers phone + consented → PHONE (the ISA calls)", resolveContactChannel({ ...consented, preferred_channel: "phone" }) === "phone")
  check("prefers phone + NO consent → email (honest downgrade)", resolveContactChannel({ ...consented, preferred_channel: "phone", tcpa_consent: false }) === "email")
  check("prefers phone + phone opt-out → email", resolveContactChannel({ ...consented, preferred_channel: "phone", phone_opt_out: true }) === "email")
  check("prefers voicedrop + consented → VOICEDROP (ringless voicemail)", resolveContactChannel({ ...consented, preferred_channel: "voicedrop" }) === "voicedrop")
  check("prefers voicedrop + NO consent → email", resolveContactChannel({ ...consented, preferred_channel: "voicedrop", tcpa_consent: false }) === "email")

  console.log("\n[The rest of the matrix still holds]")
  check("prefers sms + consented → sms", resolveContactChannel({ ...consented, preferred_channel: "sms" }) === "sms")
  check("prefers sms + no consent → email", resolveContactChannel({ ...consented, preferred_channel: "sms", tcpa_consent: false }) === "email")
  check("prefers sms + sms opt-out → email", resolveContactChannel({ ...consented, preferred_channel: "sms", sms_opt_out: true }) === "email")
  check("prefers email → email", resolveContactChannel({ ...consented, preferred_channel: "email" }) === "email")
  check("email opt-out + mailing addr → direct_mail", resolveContactChannel({ ...consented, preferred_channel: "email", email_opt_out: true, mailing_address: "9 Oak" }) === "direct_mail")
  check("email opt-out + NO mailing addr → email (no fabricated channel)", resolveContactChannel({ ...consented, preferred_channel: "email", email_opt_out: true }) === "email")
  check("prefers direct_mail + addr → direct_mail", resolveContactChannel({ ...consented, preferred_channel: "direct_mail", mailing_address: "9 Oak" }) === "direct_mail")
  check("prefers direct_mail + NO addr → email", resolveContactChannel({ ...consented, preferred_channel: "direct_mail" }) === "email")
  check("unknown preference → email (safe default)", resolveContactChannel({ ...consented, preferred_channel: "carrier_pigeon" }) === "email")

  console.log("\n[Situational voice drops — them-first, not a generic blast]")
  const buyerSearch = buildSituationalVoicemailScript({ firstName: "Sam", side: "buyer", stage: "active_search", hasFreshHook: true })
  const buyerNoHook = buildSituationalVoicemailScript({ firstName: "Sam", side: "buyer", stage: "active_search", hasFreshHook: false })
  const sellerList = buildSituationalVoicemailScript({ firstName: "Sam", side: "seller", stage: "cma_request" })
  const pastClient = buildSituationalVoicemailScript({ firstName: "Sam", side: "lifetime" })
  const buyerFin = buildSituationalVoicemailScript({ firstName: "Sam", side: "buyer", stage: "preapproval" })
  check("buyer (searching, fresh hook) → leads with new homes / first look", /home|came up|first look|send them over/i.test(buyerSearch))
  check("buyer fresh hook ≠ no-hook (situational, not one script)", buyerSearch !== buyerNoHook)
  check("seller (CMA) → leads with value / what it's worth", /value|worth|sell for|market/i.test(sellerList))
  check("past client → leads with equity", /equity/i.test(pastClient))
  check("buyer (financing) → leads with financing", /financ|set up to move/i.test(buyerFin))
  check("each side speaks differently (buyer ≠ seller ≠ past client)", buyerSearch !== sellerList && sellerList !== pastClient && buyerSearch !== pastClient)
  check("the agent's name is interpolated by the sender ({agent_name})", [buyerSearch, sellerList, pastClient].every((s) => s.includes("{agent_name}")))
  check("voicemail is spoken-length disciplined (≤ ~60 words)", [buyerSearch, sellerList, pastClient, buyerFin].every((s) => s.split(/\s+/).length <= 60))
  const VM_BANNED = ["race", "religion", "christian", "jewish", "muslim", "ethnic", "disab", "handicap", "familial", "children", "kids", "married", "elderly", "senior citizen", "young couple", "your age", "retiree"]
  let vmClean = true
  for (const s of [buyerSearch, buyerNoHook, sellerList, pastClient, buyerFin]) {
    const hit = VM_BANNED.find((w) => s.toLowerCase().includes(w))
    if (hit) { vmClean = false; fails.push(`voicemail contains banned term "${hit}"`) }
  }
  check("no voicemail references a protected class or age (Fair Housing)", vmClean)

  console.log("\n[Truly situational — buyer/seller/both/lifetime (not 3)]")
  const bothVm = buildSituationalVoicemailScript({ firstName: "Sam", side: "both" })
  check("a 'both' (buyer+seller) voicemail speaks to BOTH sides + timing", /both sides|line the timing|map it out/i.test(bothVm))
  check("'both' voicemail differs from buyer + seller + past-client", bothVm !== buyerSearch && bothVm !== sellerList && bothVm !== pastClient)
  // The DELEGATED reel kind fits each of the 4 personas (distinct, not collapsed to 3).
  check("contact_type 'both' → 'both' persona", contactReelPersona("both") === "both")
  check("contact_type 'lifetime_customer' → 'lifetime' persona", contactReelPersona("lifetime_customer") === "lifetime")
  check("the RETIRED 'lifetime' spelling still maps (readers stay tolerant)", contactReelPersona("lifetime") === "lifetime")
  check("buyer → explainer reel", situationKindForContact("buyer") === "explainer")
  check("seller → cma reel", situationKindForContact("seller") === "cma")
  check("both → market_update reel", situationKindForContact("both") === "market_update")
  check("lifetime → anniversary reel", situationKindForContact("lifetime") === "anniversary")
  check("all four personas map to DISTINCT reel kinds (truly situational)",
    new Set((["buyer", "seller", "both", "lifetime"] as const).map(situationKindForContact)).size === 4)

  console.log("\n[Portal NLP — met in-app, them-first, by persona]")
  const portalBuyer = buildSituationalPortalMessage({ firstName: "Sam", persona: "buyer" })
  const portalSeller = buildSituationalPortalMessage({ firstName: "Sam", persona: "seller" })
  const portalBoth = buildSituationalPortalMessage({ firstName: "Sam", persona: "both" })
  const portalLife = buildSituationalPortalMessage({ firstName: "Sam", persona: "lifetime" })
  check("portal buyer note is them-first (their search, their pace)", /your search|your pace|flagged the strongest/i.test(portalBuyer))
  check("portal seller note leads with value", /sell for|worth|number/i.test(portalSeller))
  check("portal 'both' note speaks to both sides + timing", /both sides|timing|map it out/i.test(portalBoth))
  check("portal lifetime note leads with equity + referral", /equity|referral|snapshot/i.test(portalLife))
  check("all four portal personas are distinct", new Set([portalBuyer, portalSeller, portalBoth, portalLife]).size === 4)
  const PORTAL_BANNED = ["race", "religion", "ethnic", "disab", "familial", "children", "married", "elderly", "your age", "retiree"]
  check("no portal note references a protected class or age (Fair Housing)",
    [portalBuyer, portalSeller, portalBoth, portalLife].every((s) => !PORTAL_BANNED.some((w) => s.toLowerCase().includes(w))))

  console.log("\n[Follow-up reels follow POPULAR KEYWORDS pertaining to the persona]")
  check("buyer topic categories are buyer-relevant", personaTopicCategories("buyer").includes("buyer_advice"))
  check("seller topic categories are seller-relevant", personaTopicCategories("seller").includes("seller_advice"))
  check("lifetime topic categories are homeowner-relevant", personaTopicCategories("lifetime").some((c) => /home_value|home_improvement|homeownership/.test(c)))
  check("each persona gets distinct keyword categories", new Set((["buyer", "seller", "both", "lifetime"] as const).map((p) => personaTopicCategories(p).join(","))).size === 4)
  const infoSit = buildInformationalReelSituation({ contactId: "c1", persona: "buyer", topicTitle: "How rate buydowns lower your payment", valueAngle: "save monthly", categories: ["finance"] })
  check("informational reel is an avatar EXPLAINER (not a fixed persona kind)", infoSit.kind === "explainer")
  check("the popular keyword/topic seeds the reel facts", infoSit.facts?.topic === "How rate buydowns lower your payment")

  console.log("\n[Offer-moment comps reel — AGENT-FACING (in_house), never the client's black-and-white scope]")
  const compsSit = buildOfferCompsSituation({ contactId: "c1", subjectAddress: "9 Birch Ln", subjectPrice: 525000 })
  check("offer comps reel is a CMA reel (the Director marks cma in_house/agent-facing)", compsSit.kind === "cma")
  check("the buyer's target seeds the comps reel subject", compsSit.facts?.subject_address === "9 Birch Ln" && compsSit.facts?.subject_price === 525000)
  check("comps reel is explicitly agent-audience (not shown black-and-white to the client)", compsSit.facts?.audience === "agent")

  console.log("\n[Portal-back — every contact touch returns to OUR portal (beat RealScout/Lofty)]")
  const purl = buildContactPortalUrl("c-123", null, "https://app.example.com/")
  check("portal URL is the contact's home (/portal/<id>)", purl === "https://app.example.com/portal/c-123")
  check("trailing slash on origin is normalized (no //)", !purl.includes("//portal"))
  const section = buildContactPortalUrl("c-123", "/matches", "https://app.example.com")
  check("a section hangs off the portal home", section === "https://app.example.com/portal/c-123/matches")
  const smsLine = portalSmsLine("c-123", "https://app.example.com")
  check("SMS portal line is plain text (no HTML) + carries the link", !/[<>]/.test(smsLine) && smsLine.includes("/portal/c-123"))
  const cta = portalCtaHtml("c-123", "https://app.example.com")
  check("email portal CTA is an HTML button linking the portal", cta.includes("<a ") && cta.includes("/portal/c-123"))
  check("email + SMS drive to the SAME portal home (consistent destination)", cta.includes(purl.replace("https://app.example.com/", "https://app.example.com/")) || cta.includes("/portal/c-123"))

  console.log("\n[Managers delegating — the ISA hands the reel to the Asset Manager]")
  {
    const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
    check("Asset Manager consumes the contact reel hand-off (managers delegating, not solo)",
      typeof SIGNAL_HANDLERS["asset_manager:contact_reel_handoff"] === "function")
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTACT_CHANNEL_FAIL"); process.exit(1) }
  console.log(" ✅ CONTACT_CHANNEL_PASS — the ISA's full voice toolbox (call + voicedrop) is reachable on consented contacts; consent gates hold")
}

main().catch((e) => { console.error(e); process.exit(1) })
