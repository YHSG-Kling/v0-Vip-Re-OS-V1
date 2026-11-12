/**
 * scripts/canaries/wave146-deliverables.ts — DELIVERABLES canary (wave 146, lane 146J; owner rulings 4 and 10; contract C4 — lane 146F,
 * the signal registered by lane 146D):
 *   RULING 10 / C4 — "The arbiter needs to make sure that any deliverables that were promised from the lead magnet are delivered":
 *     recordPromisedDeliverable / deliverPromised / undeliveredPromisesFor — one request is ONE promise (never duplicate deliveries);
 *     never 'delivered' when the guide / video / report / book is missing or unapproved; an undelivered promise stays visible (and
 *     raises `lead_magnet_promise_undelivered` for the arbiter).
 *   RULING 4 — "Automatic non listing videos need to be staged": generated → playable → rights/branding checked → audience/channel
 *     chosen → approver assigned (C5) → approved → published per policy; the YouTube queue holds ONLY approved public non-personal video.
 *
 * Through the survivors at bf67aa63: lib/video/youtube-publish.ts queueYouTubeAutoPublish + lib/video/public-video.ts classifyPublicVideo
 * (driven in memory — nothing is uploaded), lib/kernel/signal-registry.ts SIGNAL_REGISTRY. C4 binds by the spec's FILE + NAMES and
 * is driven on an in-memory client; outcomes are read by MEANING (what was recorded, what is still undelivered), never by shape.
 *
 * MEASURED AT bf67aa63: lib/lead-magnets/promised-deliverables.ts does not exist; the signal is not registered; no non-listing video
 * staging names an approver from C5.
 */
import { landedModule, setSvc } from "./_harness"
import { listFiles, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { CONTRACTS_146, SIGNAL_PROMISE_UNDELIVERED, bind146, canary146, errText, jsonOf, rowCounts, tableDiff, totalAdded } from "./wave146-harness"

// ── WAVE146 BIND (lane 146F notes, "## Canary requirements") ── not published at the time of writing; C4 binds by the spec's names.

export async function run() {
  const c = canary146("Deliverables: a lead-magnet promise is recorded once, delivered only with an approved asset, and stays visible until it is · the undelivered signal reaches the arbiter · non-listing videos are staged with a C5 approver · the YouTube queue holds only approved public non-personal video")
  const B = "aaaaaaaa-0146-4000-8000-0000000000f1"

  // ── 1 · C4 driven: one request → one promise; missing asset → never delivered, still owed; present + approved → delivered once ──
  const C4 = await bind146(CONTRACTS_146.C4_PROMISES)
  await c.check("146F", "C4 · A PROMISE IS RECORDED ONCE AND NEVER 'DELIVERED' WITHOUT ITS ASSET (ruling 10: 'Capture source campaign/form, promised asset + version, recipient identity, consent basis, delivery mechanism, status, retries, failure, final evidence … Never mark delivered when the guide/video/report/book was missing; one request never produces duplicate deliveries'): recording the same form submission twice leaves ONE promise; delivering a promise whose asset does not exist does NOT mark it delivered and undeliveredPromisesFor still lists it; delivering a promise whose approved asset exists (through the secure portal channel) records it delivered once, and a second delivery attempt delivers nothing more", async () => {
    if (!C4.mod) return { ok: false, evidence: C4.evidence }
    const svc = memSupabase({
      contacts: [{ id: "k-1", contact_id: "kc-1", brokerage_id: B, email: "promise146f@example.test", has_login: true, email_opt_out: false }],
      lead_capture_forms: [
        { id: "lm-ok", brokerage_id: B, name: "First-home guide", status: "published", form_type: "lead_magnet", magnet_type: "buyer_guide", settings: { magnet_type: "buyer_guide" } },
        { id: "lm-missing", brokerage_id: B, name: "Market report", status: "published", form_type: "lead_magnet", magnet_type: "market_report", settings: { magnet_type: "market_report" } },
      ],
      marketing_assets: [{ id: "as-ok", brokerage_id: B, asset_type: "guide", status: "approved", approval_status: "approved", file_url: "https://cdn.example.test/as-ok.pdf", version: 1 }],
      form_submissions: [
        { id: "fs-ok", brokerage_id: B, form_id: "lm-ok", contact_id: "k-1", data: { email: "promise146f@example.test", consent: true }, created_at: "2026-10-29T14:00:00Z" },
        { id: "fs-missing", brokerage_id: B, form_id: "lm-missing", contact_id: "k-1", data: { email: "promise146f@example.test", consent: true }, created_at: "2026-10-29T14:01:00Z" },
      ],
      agent_client_messages: [], agent_action_ledger: [], kernel_events: [], notifications: [], manager_signals: [], approval_items: [], lead_magnet_promises: [], portal_updates: [], activities: [],
    }, { uuidIds: true, stampCreatedAt: true, unique: { lead_magnet_promises: [["submission_id"]] } })
    setSvc(svc)
    const call = async (name: string, ...args: unknown[]) => { try { return { r: await quiet(async () => C4.mod![name](...args)), e: null as string | null } } catch (e) { return { r: null, e: errText(e) } } }
    // The request: the spec's fields (form / submission / recipient / asset) under the names the contract's input carries.
    const promiseOf = (formId: string, submissionId: string, magnetType: string) => ({ brokerageId: B, formId, submissionId, contactId: "k-1", recipient: { kind: "contact", id: "k-1" }, magnetType, campaignId: null, tcpaConsentGiven: true })
    // Delivery seams (recorders — nothing is sent): the asset is PREPARED for the guide and MISSING for the report (the cover note
    // alone, no hosted file); every email / portal write is counted so a second delivery is visible.
    const sends: string[] = [], portal: string[] = [], signals: string[] = []
    const deps = {
      prepare: async (a: { magnetType: string }) => a.magnetType === "market_report"
        ? { deliverable: { subject: "Your report", title: "Market report", body: "Here it is." }, pdfUrl: null, documentId: null, deliverableKind: "copy" as const }
        : { deliverable: { subject: "Your guide", title: "First-home guide", body: "Here it is." }, pdfUrl: "https://cdn.example.test/as-ok.pdf", documentId: "doc-ok", deliverableKind: "booklet" as const },
      sendEmail: async (p: { to: string }) => { sends.push(p.to); return { success: true, providerKey: "sendgrid", messageId: `m-${sends.length}` } },
      pushPortal: async (p: { contactId: string }) => { portal.push(p.contactId); return { pushed: true, id: `pu-${portal.length}` } },
      publishSignal: async (s: { signalType: string; payload?: Record<string, unknown> }) => { signals.push(`${s.signalType}${s.payload?.priority ? `:${String(s.payload.priority)}` : ""}`); return { ok: true } },
      recordActivity: async () => ({ ok: true }),
      finalize: async (a: { text: string }) => ({ ok: true, text: a.text }),
    }
    const t0 = rowCounts(svc.tables)
    const r1 = await call("recordPromisedDeliverable", svc, promiseOf("lm-ok", "fs-ok", "buyer_guide"))
    const d1 = tableDiff(t0, svc.tables)
    const t1 = rowCounts(svc.tables)
    const r2 = await call("recordPromisedDeliverable", svc, promiseOf("lm-ok", "fs-ok", "buyer_guide"))
    const d2 = tableDiff(t1, svc.tables)
    const rMissing = await call("recordPromisedDeliverable", svc, promiseOf("lm-missing", "fs-missing", "market_report"))
    const idOf = (x: { r: unknown }) => { const o = x.r as Record<string, unknown> | null; return (o?.promiseId ?? o?.id ?? (o?.promise as Record<string, unknown> | undefined)?.id ?? null) as string | null }
    const pOk = idOf(r1), pMissing = idOf(rMissing)
    const delMissing = await call("deliverPromised", svc, { brokerageId: B, promiseId: pMissing }, deps)
    const sentForMissing = sends.length + portal.length
    // OVERDUE and still missing → the arbiter's high-priority moment, raised ONCE (lane 146F requirement 3).
    const later = (h: number) => ({ ...deps, now: new Date(Date.now() + h * 3_600_000) })
    await call("deliverPromised", svc, { brokerageId: B, promiseId: pMissing }, later(2))
    await call("deliverPromised", svc, { brokerageId: B, promiseId: pMissing }, later(4))
    const undeliveredSignals = signals.filter((s) => s.startsWith(SIGNAL_PROMISE_UNDELIVERED))
    const delOk = await call("deliverPromised", svc, { brokerageId: B, promiseId: pOk }, deps)
    const sentAfterFirst = sends.length + portal.length
    const delOkAgain = await call("deliverPromised", svc, { brokerageId: B, promiseId: pOk }, deps)
    const owed = await call("undeliveredPromisesFor", svc, { brokerageId: B, contactId: "k-1", recipient: { kind: "contact", id: "k-1" } })
    const owedJson = jsonOf(owed.r)
    const isDelivered = (x: { r: unknown }) => /"(status|state)"\s*:\s*"delivered"|"delivered"\s*:\s*true/.test(jsonOf(x.r))
    const ok = !r1.e && !!pOk && totalAdded(d1) >= 1 && totalAdded(d2) === 0 && !!pMissing && !isDelivered(delMissing) && sentForMissing === 0 && owedJson.includes(String(pMissing)) && undeliveredSignals.length === 1 && /:high$/.test(undeliveredSignals[0] ?? "") && isDelivered(delOk) && sentAfterFirst >= 1 && !owedJson.includes(String(pOk)) && sends.length + portal.length === sentAfterFirst
    return { ok, evidence: `record → ${r1.e ?? `promise ${pOk ?? `∅ (${jsonOf(r1.r).slice(0, 80)})`} (${jsonOf(d1)})`}; same submission again → ${r2.e ?? `wrote ${jsonOf(d2)}`}; missing report → ${delMissing.e ?? (isDelivered(delMissing) ? "MARKED DELIVERED" : `not delivered (${jsonOf(delMissing.r).slice(0, 70)})`)}, sends for it ${sentForMissing}, still owed ${owedJson.includes(String(pMissing))}; overdue ×2 → '${SIGNAL_PROMISE_UNDELIVERED}' raised ${undeliveredSignals.length}× (${undeliveredSignals.join(",") || "never"}); prepared guide → ${delOk.e ?? (isDelivered(delOk) ? "delivered" : `not delivered (${jsonOf(delOk.r).slice(0, 90)})`)} (email ${sends.length}, portal ${portal.length}); second delivery → ${delOkAgain.e ?? `${sends.length + portal.length - sentAfterFirst} more send(s)`}; owed ${owed.e ?? owedJson.slice(0, 90)}` }
  })

  // ── 2 · the undelivered signal is registered and reaches the arbiter (C4: F names it, D owns the registry file) ──
  const reg = await quiet(async () => import("../../lib/kernel/signal-registry")) as unknown as { SIGNAL_REGISTRY: Record<string, { consumers: string[]; disposition: string; what: string }> }
  const spec = reg.SIGNAL_REGISTRY[SIGNAL_PROMISE_UNDELIVERED]
  const emitters = [...listFiles("lib", (f) => /\.ts$/.test(f)), ...listFiles("app", (f) => /\.ts$/.test(f))].filter((f) => (strippedRepo(f) ?? "").includes(SIGNAL_PROMISE_UNDELIVERED) && !/signal-registry\.ts$/.test(f))
  c.rule("146D", `THE '${SIGNAL_PROMISE_UNDELIVERED}' SIGNAL IS REGISTERED AND REACHES THE ARBITER (contract C4: 'lane F also registers the signal … in lib/kernel/signal-registry.ts (D owns the registry file …)'; ruling 10): SIGNAL_REGISTRY carries it with a consumer (or a handled disposition), and code outside the registry names it (an emitter / the arbiter)`,
    !!spec && (spec.consumers.length > 0 || spec.disposition === "handled") && emitters.length > 0, spec ? `registered: consumers ${spec.consumers.join(",") || "none"}, disposition ${spec.disposition}; named in ${emitters.join(", ") || "no code outside the registry"}` : `not in SIGNAL_REGISTRY (lane 146F lists it in notes; lane 146D adds it); named in ${emitters.join(", ") || "no code"}`)

  // ── 3 · RULING 4 (preserve + extend): the YouTube queue holds ONLY approved public non-personal video ──
  const yt = await quiet(async () => import("../../lib/video/youtube-publish")) as unknown as Record<string, any>
  const project = (id: string, over: Record<string, unknown>) => ({ id, brokerage_id: B, agent_id: null, listing_id: null, marketing_campaign_id: null, title: `Market update ${id}`, video_type: "market_update", audience_type: "public", usage_intent: "social", contact_id: null, learning_module_id: null, approval_status: "approved", approved_by: "u-1", approved_at: "2026-10-29T12:00:00Z", status: "completed", compliance_status: "passed", video_url: `https://cdn.example.test/${id}.mp4`, script_content: "Rates eased this month.", video_metadata: {}, ...over })
  const ytSvc = memSupabase({
    ai_video_projects: [project("v-ok", {}), project("v-unapproved", { approval_status: "pending" }), project("v-personal", { contact_id: "k-1" }), project("v-pending-render", { status: "rendering", video_url: null })],
    social_media_accounts: [{ id: "acct-yt", brokerage_id: B, agent_id: null, platform: "youtube", is_active: true }], social_posts: [], brokerage_settings: [], agents: [], distribution_finals: [], marketing_assets: [],
  }, { uuidIds: true })
  const brand = async () => ({})
  const q = async (id: string) => { try { return (await quiet(async () => yt.queueYouTubeAutoPublish(ytSvc, id, { brand }))) as { queued: boolean; reason?: string } } catch (e) { return { queued: false, reason: `threw ${errText(e)}` } } }
  const unapproved = await q("v-unapproved"), personal = await q("v-personal"), pending = await q("v-pending-render")
  // WAVE146 BIND (lane 146F notes, 18:41Z): lib/video/video-staging.ts stageVideoForPublication · approveStagedVideo ·
  // stagedPublicationVerdict · NON_LISTING_PUBLIC_VIDEO_TYPES · LISTING_VIDEO_TYPES. Once staging exists, an approval WITHOUT staging
  // no longer queues a non-listing video (ruling 4) — so the positive control is the staged → approved → queued path (step 4), and
  // at a tree without staging it is the approved row.
  const vs = await quiet(async () => landedModule<Record<string, any>>("../../lib/video/video-staging.ts")) as Record<string, any> | null
  const stagingLanded = !!vs && typeof vs.stageVideoForPublication === "function"
  const okQ = await q("v-ok")
  const queuedRows = () => (ytSvc.tables.social_posts ?? []).filter((p) => p.platform === "youtube")
  const control = stagingLanded ? !okQ.queued && /stag/i.test(String(okQ.reason ?? "")) : okQ.queued
  c.rule("146F", "THE YOUTUBE QUEUE HOLDS ONLY APPROVED PUBLIC NON-PERSONAL VIDEO (ruling 4: 'No unapproved automatic YouTube / social / CTV publishing; the YouTube queue holds only approved public non-personal video'; green, preserve): an unapproved public market update, one addressed to a contact and one still rendering are refused; an approved one queues only through the ruled path — at a tree with video staging an approval that was never STAGED is refused ('not staged'), and the staged → approved video queues in the next step",
    control && !unapproved.queued && !personal.queued && !pending.queued && queuedRows().length === (stagingLanded ? 0 : 1), `approved, ${stagingLanded ? "never staged" : "no staging in the tree"} → ${okQ.queued ? "queued" : okQ.reason}; unapproved → ${unapproved.queued ? "QUEUED" : unapproved.reason}; personal → ${personal.queued ? "QUEUED" : personal.reason}; rendering → ${pending.queued ? "QUEUED" : pending.reason}; youtube posts ${queuedRows().length}`)

  // ── 4 · RULING 4: non-listing video is STAGED (generated → playable → rights/branding → audience/channel → approver → approved → published) ──
  await c.check("146F", "AUTOMATIC NON-LISTING VIDEOS ARE STAGED, AND ONLY THE ASSIGNED APPROVER RELEASES THEM (ruling 4: 'Generated → playable → rights/branding checked → intended audience/channel chosen → approver assigned → approved → published per policy'; ruling 9 / C5: the approver comes from the authority hierarchy): the non-listing and listing public kinds partition the public marketing kinds; staging a finished draft chooses its channels (YouTube + a landing page), puts it to review and bells the assigned approver once; another user's approval is refused and writes nothing; the assigned approver's approval releases it once, and THEN the YouTube queue takes it; a personal video never becomes a public landing page, and listing marketing is not held by staging", async () => {
    if (!stagingLanded) return { ok: false, evidence: "lib/video/video-staging.ts (stageVideoForPublication / approveStagedVideo / stagedPublicationVerdict) not landed — awaiting lane 146F" }
    const pv = await quiet(async () => import("../../lib/video/public-video")) as unknown as { PUBLIC_MARKETING_VIDEO_TYPES: readonly string[] }
    const nonListing = new Set(vs!.NON_LISTING_PUBLIC_VIDEO_TYPES as readonly string[]), listing = new Set(vs!.LISTING_VIDEO_TYPES as readonly string[])
    const partition = [...nonListing].every((t) => !listing.has(t)) && pv.PUBLIC_MARKETING_VIDEO_TYPES.every((t) => nonListing.has(t) || listing.has(t)) && [...nonListing, ...listing].every((t) => pv.PUBLIC_MARKETING_VIDEO_TYPES.includes(t))
    const U = "u-approver-146f"
    ytSvc.tables.ai_video_projects!.push(project("v-draft", { approval_status: "draft", approved_by: null, approved_at: null }))
    ytSvc.tables.notifications = ytSvc.tables.notifications ?? []
    const seamApprover = async () => ({ ok: true, userIds: [U], primaryUserIds: [U], basis: "seam" })
    const st = (await quiet(async () => vs!.stageVideoForPublication(ytSvc, { brokerageId: B, videoId: "v-draft" }, { approverFor: seamApprover, brand: async () => ({ passed: true, violations: [] }) }))) as Record<string, any>
    const row = () => (ytSvc.tables.ai_video_projects ?? []).find((x) => x.id === "v-draft") ?? {}
    const staged = st.ok === true && st.staged === true && ["youtube", "landing_page"].every((ch) => (st.channels ?? []).includes(ch)) && row().approval_status === "pending_review"
    const bells = (ytSvc.tables.notifications ?? []).filter((n) => n.user_id === U).length
    const before = jsonOf(row())
    const wrong = (await quiet(async () => vs!.approveStagedVideo(ytSvc, { brokerageId: B, videoId: "v-draft", approverUserId: "u-someone-else" }, { approverFor: seamApprover, release: async () => ({ ok: true }) }))) as Record<string, unknown>
    const untouched = jsonOf(row()) === before
    let released = 0
    const right = (await quiet(async () => vs!.approveStagedVideo(ytSvc, { brokerageId: B, videoId: "v-draft", approverUserId: U }, { approverFor: seamApprover, release: async () => { released++; return { ok: true } } }))) as Record<string, unknown>
    const queued = await q("v-draft")
    const personalPage = vs!.stagedPublicationVerdict({ id: "v-p", video_type: "agent_intro", contact_id: "k-1", approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn.example.test/v-p.mp4" }, "landing_page") as Record<string, unknown>
    const listingRow = vs!.stagedPublicationVerdict({ id: "v-l", video_type: "just_listed", contact_id: null, audience_type: "public", approval_status: "approved", status: "completed", compliance_status: "passed", video_url: "https://cdn.example.test/v-l.mp4" }, "youtube") as Record<string, unknown>
    const ok = partition && staged && bells === 1 && wrong.ok === false && untouched && right.ok === true && row().approved_by === U && released === 1 && queued.queued && personalPage.ok === false && listingRow.ok === true && listingRow.staged === false
    return { ok, evidence: `kinds partition ${partition}; stage → ${staged ? `staged on ${(st.channels ?? []).join("+")}, ${row().approval_status}` : jsonOf(st).slice(0, 100)}; approver bells ${bells}; another user approves → ${wrong.ok === false ? "refused" : "APPROVED"} (row untouched ${untouched}); assigned approver → ${right.ok === true ? `approved_by ${row().approved_by}, released ${released}×` : jsonOf(right).slice(0, 80)}; then YouTube → ${queued.queued ? "queued" : queued.reason}; personal → landing page ${personalPage.ok === false ? "refused" : "ALLOWED"}; listing row → ${jsonOf(listingRow)}` }
  })

  c.blind("C4 is driven on an in-memory client seeded under the live table names (lead_capture_forms, form_submissions, marketing_assets, contacts); the promise's own store is whatever lane 146F chose and is observed only through C4's own reads (undeliveredPromisesFor) and the rows added — a promise store keyed differently from this seed reads as 'not recorded' and the evidence says so. The asset's existence/approval is seeded as a marketing_assets row; a lane-146F asset resolver that reads another table needs re-seeding from its published requirements. The staging step reads source (the stages + the C5 call in one module), not a driven state machine; lane 146F's test:video-pipeline-truth drives it. Human session doors that schedule an approved social post (lib/kernel/video.ts distributeVideoProject) are out of scope — a person pressing distribute IS the approval.")
  return c.report([], 0)
}
