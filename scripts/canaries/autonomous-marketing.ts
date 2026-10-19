/**
 * scripts/canaries/autonomous-marketing.ts — MARKETING canary (wave 142, lane 142J):
 *   a real lead-magnet idea from the tenant's own evidence · fair-housing blocks PUBLIC copy and never a private
 *   financial line · the booklet (the book survivor) renders REAL multi-page PDF bytes · omnipresence + the forms door
 * through the survivors at HEAD: lib/lead-magnets/suggestions.ts suggestLeadMagnetIdeas (pure: underperformer /
 * audience gap / season from the tenant's magnets, contact mix and farm territories — no copy hard-written),
 * lib/compliance-rules/fair-housing-patterns.ts detectFairHousingViolations + lib/kernel/marketing/
 * real-estate-compliance-gate.ts realEstateComplianceGate (the ONE phrase set every public gate shares),
 * lib/lead-magnets/ai-draft.ts draftFairHousingVerdict (a HIGH hit refuses the draft), lib/marketing/
 * guide-booklet-content.ts guideChaptersFor + lib/documents/client-pdf.ts renderClientPdf (pdf-lib — the booklet
 * the delivery runner ships) and lib/agents/marketing-agent-actions.ts omnipresence_topic_fanout. Owner (wave 142):
 * "fair-housing flags → AI REWRITES with the findings in mind → recheck → human approves"; "do NOT hard-write copy".
 *
 * MEASURED AT HEAD (the 142E hooks): ideation reads the tenant's own book only (no topic bank / competitive /
 * AI-search inputs); the rewrite loop exists for VIDEO only (ai-draft REFUSES on a high hit, social never rewrites);
 * the fan-out carries no asset reference; the book pipeline is the 5-chapter booklet; /api/forms/submit is a second
 * capture door beside captureFormSubmission. No tenant, no client: pure rails + stripped source.
 */
import { LIVE, canary } from "./_harness"
import { hooksFor, strippedRepo } from "./_registry"

export async function run() {
  const c = canary("Autonomous marketing: real idea from evidence → fair-housing gate → approved asset (real PDF) → omnipresence → attribution")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: pure rails + stripped source only — no publish, no send")

  // ── 1 · a REAL idea from the tenant's evidence (pure) ──
  const { suggestLeadMagnetIdeas } = await import("../../lib/lead-magnets/suggestions")
  const ideas = suggestLeadMagnetIdeas({ now: new Date("2026-10-19T12:00:00Z"), magnets: [{ id: "m-weak", name: "Home Value Report", magnetType: "home_value", isActive: true, views30d: 200, submissions30d: 1 }, { id: "m-ok", name: "Buyer Guide", magnetType: "buyer_guide", isActive: true, views30d: 150, submissions30d: 12 }], contactMix: { buyers: 40, sellers: 2 }, territories: ["Canary Heights"] })
  const under = ideas.find((i) => i.kind === "underperformer")
  c.step("IDEATION FROM EVIDENCE: a live magnet with 200 views and 1 submission (0.5 %) is an UNDERPERFORMER idea with its numbers as evidence and a concept a human hands to the AI draft; ≤ 5 ideas, every one keyed (dedupe identity), none a finished piece of copy", !!under && under.magnetId === "m-weak" && under.evidence.views30d === 200 && /0\.5%/.test(under.why) && ideas.length <= 5 && ideas.every((i) => i.key && i.concept.length > 20 && i.why.length > 0), ideas.map((i) => i.kind).join(","))

  // ── 2 · fair housing gates PUBLIC copy; never a private financial line ──
  const { detectFairHousingViolations } = await import("../../lib/compliance-rules/fair-housing-patterns")
  const { realEstateComplianceGate } = await import("../../lib/kernel/marketing/real-estate-compliance-gate")
  const bad = "Perfect starter home for a young family in a safe Christian neighborhood — no kids' noise next door!"
  const good = "Three-bedroom home near parks and transit, open Saturday 1–3. Equal Housing Opportunity."
  const cdaLine = "Net to agent $16,800.00 by direct deposit; brokerage split 30 %; gross commission $24,000.00."
  const hitsBad = detectFairHousingViolations(bad), hitsGood = detectFairHousingViolations(good), hitsCda = detectFairHousingViolations(cdaLine)
  const gateBad = await realEstateComplianceGate({ content: bad, contentType: "ad", brokerageName: "Canary Realty", requireAttribution: false })
  const gateGood = await realEstateComplianceGate({ content: good, contentType: "ad", brokerageName: "Canary Realty", requireAttribution: false })
  c.step("FAIR-HOUSING GATE on public copy: the ad naming family status / religion is BLOCKED with the specific phrase + a compliant rewrite suggestion; the clean ad passes; the same phrase set is the ONE every public gate shares", hitsBad.length > 0 && hitsBad.every((h) => h.phrase && h.fix) && !gateBad.passed && gateBad.blockers.some((b) => /Fair Housing/.test(b)) && hitsGood.length === 0 && gateGood.passed, `${hitsBad.length} phrase(s): ${hitsBad.map((h) => h.phrase).join("; ").slice(0, 80)}`)
  c.step("POSITIVE CONTROL (scope): a private CDA / financial line (net to agent, split, direct deposit) raises NO fair-housing finding — the moderation is for PUBLIC housing marketing, not internal financial records", hitsCda.length === 0, hitsCda.map((h) => h.phrase).join(";") || "0 findings")
  const { draftFairHousingVerdict } = await import("../../lib/lead-magnets/ai-draft")
  const verdict = draftFairHousingVerdict({ name: "Guide", description: bad, headline: "", subhead: "", cta: "", bullets: [], thankYou: "", fields: [], faq: [] } as never)
  c.step("THE LEAD-MAGNET DRAFT is scanned post-hoc on everything a visitor reads and a HIGH-severity hit REFUSES it (ok:false, the phrases named) — as it stands it refuses rather than rewrites (the 142E loop)", !verdict.ok && verdict.flagged.length > 0, `flagged ${verdict.flagged.length}, high ${verdict.high.length}`)

  // ── 3 · the APPROVED ASSET is real: the booklet renders multi-page PDF bytes (the book survivor) ──
  const { guideChaptersFor } = await import("../../lib/marketing/guide-booklet-content")
  const { renderClientPdf, guideBookletSpec } = await import("../../lib/documents/client-pdf")
  const { PDFDocument } = await import("pdf-lib")
  const chapters = guideChaptersFor("seller_guide")
  const bytes = await renderClientPdf(guideBookletSpec({ kind: "seller_guide", title: "The Seller's Playbook", intro: "What actually matters when you list.", chapters, areaLabel: "Canary Heights" }, { brokerageName: "Canary Realty", agentName: "Canary Agent", licenseLine: "Lic #000000 (XX)", primaryColor: "#1D4ED8", showEhoMark: true }, "October 2026"))
  const doc = await PDFDocument.load(bytes)
  c.step(`REAL ASSET: the seller booklet renders ${bytes.length} bytes of genuine PDF (%PDF- header) across ${doc.getPageCount()} pages from ${chapters.length} chapters with the EHO mark — the artifact the delivery runner ships; a status column never stands in for it`, Buffer.from(bytes.slice(0, 5)).toString() === "%PDF-" && doc.getPageCount() >= 2 && chapters.length >= 5 && chapters.every((ch) => ch.heading && ch.body.length > 40), `${doc.getPageCount()} pages`)

  // ── 4 · omnipresence + the forms door (stripped source) ──
  const fanout = strippedRepo("lib/agents/marketing-agent-actions.ts") ?? ""
  const branch = /case\s+["']omnipresence_topic_fanout["']:([\s\S]*?)\n\s*case\s+["']/.exec(fanout)?.[1] ?? ""
  c.step("OMNIPRESENCE exists on the ONE marketing-agent action rail: omnipresence_topic_fanout stages the same topic across newsletter / blog / social / postcard through each channel's own staging (never a direct publish)", branch.length > 0 && /newsletter/i.test(branch) && /blog/i.test(branch) && /social/i.test(branch) && /postcard/i.test(branch), "")
  const submit = strippedRepo("app/api/forms/submit/route.ts") ?? ""
  const magnets = strippedRepo("lib/kernel/lead-magnets.ts") ?? ""
  c.step("ATTRIBUTION survives capture: the lead-magnet kernel carries campaign / ad / creative / utm attribution through captureFormSubmission (landed 141E) and the public forms door reaches the SAME chokepoint (captureContact) — never a raw insert", /\b(campaign_id|ad_id|creative_id|utm_source)\b/.test(magnets) && /captureFormSubmission/.test(magnets) && /captureContact\(/.test(submit) && !/\.from\(\s*["']contacts["']\s*\)\s*\.insert/.test(submit), "")

  // ── WAVE142 HOOK (integrator): 142E — suggestion sources, the rewrite loop, the fan-out asset reference, the book pipeline, the forms-door merge. ──
  for (const h of hooksFor("autonomous-marketing")) {
    const at = h.probe()
    if (!at) { c.hook(h.lane, h.contract, /SUGGESTION SOURCES/.test(h.contract) ? "measured: suggestions.ts reads magnets / contactMix / territories / season only — no topic-bank, competitive or AI-search input" : /REWRITE/.test(h.contract) ? "measured above: the draft REFUSES on a high hit; the rewrite loop exists for video only" : /OMNIPRESENCE/.test(h.contract) ? "measured: the fan-out branch carries no marketing_assets / magnet reference (postcard arm asset_id: null)" : /BOOK/.test(h.contract) ? `measured above: the survivor is the ${chapters.length}-chapter booklet (no research / fact-check / edit / cover stages)` : "measured: /api/forms/submit calls captureContact directly beside captureFormSubmission (two doors)"); continue }
    c.step(`${h.lane} landed (${at}) — wire its export into this canary (WAVE142 HOOK (integrator): ${h.lane}): ${/REWRITE/.test(h.contract) ? "feed the flagged ad through the rewrite loop with the detector stubbed and assert rewrite → recheck → human-approval row, capped, and that a CDA line is never routed into it" : /BOOK/.test(h.contract) ? "run concept → outline → chapters → fact-check → cover → layout with the model lane stubbed and assert real PDF bytes + the magnet row + the approval gate" : "drive the landed export and assert its contract"}`, false, h.contract.slice(0, 120))
  }
  c.blind("No model is called: ideation and the gates are pure; the booklet's chapters are the fixed survivor text (generateGuideChapters, the LLM rewrite, is not driven). The publish / distribution rails (social publisher, campaign publisher) are the social-approval / campaign-center proofs'. No tenant rows, nothing to clean.")
  return c.report([], 0)
}
