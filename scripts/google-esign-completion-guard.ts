#!/usr/bin/env tsx
/**
 * scripts/google-esign-completion-guard.ts   (npm run test:google-esign-completion)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lane 89E (wave 89) — lane 88C's open item 2 closed: Google eSignature has no API and no
 * webhook; the completion signal is Google's EMAIL (esignature-noreply@google.com) to the
 * requester — the agent's connected Gmail, which app/api/webhooks/inbound-mail already reads.
 * Detection rides that door; the mailbox owner is told to file the executed PDF through the
 * signed-copy upload door ("mark signed"); Google's sender never becomes a lead.
 *
 * Proven on the REAL code (no DB, no network; scripts/in-memory-supabase.ts at the client edge):
 *   A · detectGoogleEsignMail: Google's sender + a completion subject → completed; requested /
 *       declined / other subjects classified; a spoofed subject from ANOTHER sender → null; the
 *       document name is lifted from quotes or "for …".
 *   B · noticeGoogleEsignCompletion: a completed mail → ONE high-priority bell to the mailbox owner
 *       (in the credential's tenant) that names the document and the upload door; a refused insert
 *       is RETURNED; no mailbox owner → refused; a non-completion mail writes nothing.
 *   C · the inbound-mail route detects BEFORE the offer lookout, tells the owner, lets an attached
 *       executed PDF ride the existing deal-doc lookout, and STOPS Google's sender before the
 *       portal-lead intake and the unknown-sender identification (which would spend enrichment on
 *       a noreply). Ordering is proven by position in the stripped source, with a positive control.
 * Run: npx tsx scripts/google-esign-completion-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    if (spec === "server-only") return { url: `data:text/javascript,${encodeURIComponent("export{}")}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

const BRK = "11111111-1111-4111-8111-111111111111"
const AGENT_USER = "u1000000-0000-4000-8000-000000000001"

async function main() {
  const G = await import("../lib/esign/google-esign-completion")

  console.log("\n[A · detectGoogleEsignMail — Google's sender decides, the subject classifies]")
  const done = G.detectGoogleEsignMail({ fromEmail: "esignature-noreply@google.com", subject: "eSignature request for \"Listing Agreement — 12 Oak St\" is complete" })
  ok("a completion mail from Google's sender → completed, document named from the quotes", done?.kind === "completed" && done?.documentName === "Listing Agreement — 12 Oak St", JSON.stringify(done))
  ok("sender matched case-insensitively with surrounding whitespace", G.detectGoogleEsignMail({ fromEmail: "  ESignature-NoReply@Google.com ", subject: "Your document has been signed" })?.kind === "completed")
  ok("a request mail → requested", G.detectGoogleEsignMail({ fromEmail: G.GOOGLE_ESIGN_SENDER, subject: "eSignature request for Offer Packet" })?.kind === "requested")
  ok("a declined mail → declined", G.detectGoogleEsignMail({ fromEmail: G.GOOGLE_ESIGN_SENDER, subject: "Jane Doe declined to sign Offer Packet" })?.kind === "declined")
  ok("an unrecognised subject → other (never guessed as completed)", G.detectGoogleEsignMail({ fromEmail: G.GOOGLE_ESIGN_SENDER, subject: "Reminder" })?.kind === "other")
  ok("\"for …\" names the document when there are no quotes", G.detectGoogleEsignMail({ fromEmail: G.GOOGLE_ESIGN_SENDER, subject: "eSignature completed for Buyer Broker Agreement" })?.documentName === "Buyer Broker Agreement")
  ok("POSITIVE CONTROL: the same completion subject from ANOTHER sender is NOT Google (null) — a spoof cannot ring the bell",
    G.detectGoogleEsignMail({ fromEmail: "someone@example.com", subject: "eSignature request is complete" }) === null
    && G.detectGoogleEsignMail({ fromEmail: null, subject: "complete" }) === null)

  console.log("\n[B · noticeGoogleEsignCompletion — the bell to the mailbox owner]")
  const svc = memSupabase({ notifications: [] })
  const n = await G.noticeGoogleEsignCompletion(svc, { brokerageId: BRK, mailboxUserId: AGENT_USER, mail: done!, pdfAttached: false })
  const bell = svc.tables.notifications[0]
  ok("ONE bell, to the mailbox owner, in the credential's tenant, high priority, type google_esign_completed",
    n.ok && n.notified && svc.tables.notifications.length === 1 && bell?.user_id === AGENT_USER && bell?.brokerage_id === BRK && bell?.priority === "high" && bell?.type === "google_esign_completed", JSON.stringify(n))
  ok("…names the document and the upload door (the \"mark signed\" flow the compliance gate runs behind)",
    /Listing Agreement — 12 Oak St/.test(bell?.title ?? "") && /Upload signed copy/.test(bell?.body ?? "") && /compliance gate/.test(bell?.body ?? ""))
  const withPdf = memSupabase({ notifications: [] })
  await G.noticeGoogleEsignCompletion(withPdf, { brokerageId: BRK, mailboxUserId: AGENT_USER, mail: done!, pdfAttached: true })
  ok("an attached executed PDF is said in the bell (Google attached it)", /attached the executed PDF/.test(withPdf.tables.notifications[0]?.body ?? ""))
  const quiet = memSupabase({ notifications: [] })
  const req = await G.noticeGoogleEsignCompletion(quiet, { brokerageId: BRK, mailboxUserId: AGENT_USER, mail: { kind: "requested", documentName: null }, pdfAttached: false })
  ok("a non-completion Google mail writes NOTHING (ok, not notified)", req.ok && !req.notified && quiet.tables.notifications.length === 0)
  const noOwner = await G.noticeGoogleEsignCompletion(quiet, { brokerageId: BRK, mailboxUserId: null, mail: done!, pdfAttached: false })
  ok("no mailbox owner → refused by name (nobody to tell), nothing written", !noOwner.ok && /no user/.test(noOwner.error ?? "") && quiet.tables.notifications.length === 0)
  const refused = memSupabase({ notifications: [] }, { refuse: { notifications: "permission denied for table notifications" } })
  const r = await G.noticeGoogleEsignCompletion(refused, { brokerageId: BRK, mailboxUserId: AGENT_USER, mail: done!, pdfAttached: false })
  ok("a REFUSED insert is returned as the error, never swallowed (CLAUDE.md §3)", !r.ok && /refused/.test(r.error ?? "") && /permission denied/.test(r.error ?? ""), JSON.stringify(r))

  console.log("\n[C · the inbound-mail door: detect → tell → let the PDF ride the lookout → STOP before lead intake]")
  const route = code("app/api/webhooks/inbound-mail/route.ts")
  const iDetect = route.indexOf("detectGoogleEsignMail(")
  const iNotice = route.indexOf("noticeGoogleEsignCompletion(")
  const iOffer = route.indexOf("tryIngestInboundOffer(")
  const iDealDoc = route.indexOf("routeInboundDealDoc(")
  const iStop = route.search(/if \(googleEsign\) \{\s*results\.push\(\{ email_from: email\.fromEmail, uploads: 0 \}\)\s*continue\s*\}/)
  const iPortal = route.indexOf("parsePortalLeadEmail(")
  const iUnknown = route.indexOf("identifyAndRouteUnknownSender(")
  ok("detection and the notice run BEFORE the offer lookout", iDetect > 0 && iNotice > iDetect && iOffer > iNotice, `${iDetect}/${iNotice}/${iOffer}`)
  ok("an attached PDF still reaches the existing deal-doc lookout (detection does not skip it)", iDealDoc > iNotice && iStop > iDealDoc, `${iDealDoc}/${iStop}`)
  ok("Google's sender STOPS before the portal-lead intake and the unknown-sender identification (never enriched as a lead)", iStop > 0 && iPortal > iStop && iUnknown > iStop, `${iStop}/${iPortal}/${iUnknown}`)
  ok("the notice's refusal is READ and logged by name", /Google eSignature completion notice NOT delivered/.test(route))
  ok("POSITIVE CONTROL: a route specimen WITHOUT the stop guard is recognised as letting Google's sender fall through",
    "const x = 1\nidentifyAndRouteUnknownSender()".search(/if \(googleEsign\) \{\s*results\.push/) < 0)

  console.log("\n[registration]")
  const dom = MAINTENANCE_DOMAINS["google_esign_completion"]
  ok("MAINTENANCE_DOMAINS.google_esign_completion is owned (deal_coordinator) with compliance_officer + ai_isa co-owners named in prose",
    dom?.manager === "deal_coordinator" && ["compliance_officer", "ai_isa"].every((c) => (dom?.coOwners ?? []).includes(c as never)) && /compliance_officer/.test(dom?.what ?? "") && /ai_isa/.test(dom?.what ?? ""))
  ok("its proof is this script's npm target", dom?.proof === "test:google-esign-completion")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  console.log(fail === 0 ? " ✅ GOOGLE_ESIGN_COMPLETION_PASS — Google's completion mail closes the return leg on the mailbox door; its sender is never a lead" : " ❌ GOOGLE_ESIGN_COMPLETION_FAIL")
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
