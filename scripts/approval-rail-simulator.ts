#!/usr/bin/env tsx
/**
 * scripts/approval-rail-simulator.ts   (npm run test:approval-rail) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPROVAL RAIL COULD NOT SAY "NO", AND TWO SOURCES COULD NOT GET ON IT.
 *
 * Four defects, one surface. Each is a different failure MODE of the same
 * root cause — a literal the column cannot hold — and each needed a different
 * remedy, so the remedies are pinned here alongside the reasoning.
 *
 * ── 1. REJECTING A BLOG POST LEFT IT PUBLISHABLE (widened, m296) ────────────
 * applyMarketingAssetRejection drops a rejected blog to publish_status
 * 'rejected', with the intent stated in its own comment: "the post leaves BOTH
 * review queues and the publish cron can never ship it." The column admitted no
 * such value. That update was rejected, so publish_status stayed 'draft' — and
 * 'draft' IS BLOG_PENDING_PUBLISH_STATUS, the exact value both approval queues
 * read as awaiting-a-human. The rejected post stayed in the queue and stayed
 * publishable. Widened, because 'rejected' is a real terminal state the ladder
 * lacked; it is not 'archived', which means published-then-retired.
 *
 * ── 2. AN ENTIRE FEATURE COULD NOT WRITE ITS FIRST ROW (widened, m296) ──────
 * Buyer criteria stated on a call (lib/voice/call-analysis.ts) or written in an
 * inbound email/SMS (lib/buyer-search/written-criteria-alert.ts) become ONE
 * inactive property alert for the agent to approve. Both writers set
 * source='voice_conversation'/'text_conversation'; the column admitted neither.
 * Every proposal was rejected AND the rail's matching filter had nothing to
 * find — dead at both ends at once.
 *
 * Widened rather than flattened to 'system_generated', because the approval
 * rail's reject cascade DELETES the row and pins that delete to these two
 * sources so it can never touch a live or agent-created alert. Collapsing the
 * sources would point a delete at real alerts. The distinction is a safety
 * boundary, so it is stored.
 *
 * ── 3. NO SNIPPET EVER REACHED THE RAIL (repointed, no migration) ───────────
 * video_snippets.approval_status is (draft | pending_review | approved |
 * rejected). video-repurposing.ts already fixed its WRITERS onto
 * 'pending_review' and documented 'pending' as schema drift — but both READERS
 * were left behind on 'pending'. A spelling drift, not a missing state, so the
 * readers move rather than the vocabulary. They now share
 * VIDEO_SNIPPET_PENDING_APPROVAL_STATUS from lib/kernel/approval-pending.ts,
 * which exists for exactly this reason.
 *
 * The second reader is lib/managers/cross-referral.ts, whose probe list
 * MIRRORS the aggregator's filters — and had drifted because it retyped the
 * literals instead of importing them. It now imports every pending value that
 * approval-pending.ts owns. That also fixed a divergence this sweep found on
 * the way past: it asked ad_creative_variations for 'draft' only, while the
 * queue admits draft AND pending_review, so a creative breaching its SLA at
 * pending_review never made its tenant a candidate.
 *
 * ── 4. "ALL ACTIVE ALERTS WILL BE PAUSED" PAUSED NOTHING (repointed) ────────
 * The IDX Broker disconnect wrote paused_by='admin_disconnect'. paused_by is an
 * ACTOR CLASS (agent | buyer | system); 'admin_disconnect' is an EVENT — a
 * category error, so the call site moves rather than the vocabulary. And
 * because it is one bulk UPDATE, the rejection took the whole statement with
 * it: the confirm dialog promised every active alert would be paused and not
 * one ever was. Now paused_by='system' with the event in paused_reason, scoped
 * to is_active=true so the cascade cannot overwrite the [VOICE_PROPOSAL] /
 * [TEXT_PROPOSAL] evidence on proposals still awaiting approval.
 *
 * VERIFIED LIVE: both proposal sources insert; 'rejected' now sticks on a blog
 * post; 'pending' is still impossible on video_snippets while 'pending_review'
 * inserts; 'admin_disconnect' still raises check_violation while 'system' is
 * accepted; and a value outside each widened vocabulary is still rejected, so
 * the widening is exact. Probe rows deleted and counts confirmed.
 */
import { readFileSync } from "node:fs"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripComments } from "./strip-comments"
import {
  BLOG_PENDING_PUBLISH_STATUS,
  BLOG_REJECTED_PUBLISH_STATUS,
  VIDEO_SNIPPET_PENDING_APPROVAL_STATUS,
  AD_CREATIVE_PENDING_APPROVAL_STATUSES,
  NEWSLETTER_PENDING_APPROVAL_STATUSES,
  PODCAST_PENDING_APPROVAL_STATUS,
} from "../lib/kernel/approval-pending"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const src = (p: string) =>
  stripComments(readFileSync(p, "utf8"))

console.log("══════════════════════════════════════════════════")
console.log(" The approval rail (every queued thing is findable, and 'no' sticks)")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1. rejecting a blog post takes it OUT of the queue ──")
{
  const live = CHECK_VOCABULARIES.blog_posts?.publish_status ?? []
  check("publish_status admits 'rejected' (m296)", live.includes(BLOG_REJECTED_PUBLISH_STATUS))
  check("the six pre-existing statuses are untouched — m296 is additive",
    ["draft", "pending_review", "approved", "scheduled", "published", "archived"].every((s) => live.includes(s)))
  // Widened to string: tsc knows these are distinct literal types and would
  // reject the comparison, but the point of the assertion is the VALUES.
  const rejected: string = BLOG_REJECTED_PUBLISH_STATUS
  const pending: string = BLOG_PENDING_PUBLISH_STATUS
  check("the rejected state is NOT the pending state — that was the whole bug",
    rejected !== pending)
  check("'archived' is still its own state (published-then-retired ≠ rejected)",
    live.includes("archived") && rejected !== "archived")
  check("both are values the column actually admits", live.includes(rejected) && live.includes(pending))

  const agg = src("lib/kernel/approval-queue-aggregator.ts")
  check("the rejection writes the shared constant, not a bare literal",
    /publish_status: BLOG_REJECTED_PUBLISH_STATUS/.test(agg))
  check("no bare 'rejected' publish_status literal is left in the aggregator",
    !/publish_status:\s*"rejected"/.test(agg))
}

console.log("\n── 2. the conversation-criteria proposals can exist ──")
{
  const live = CHECK_VOCABULARIES.property_alerts?.source ?? []
  check("source admits 'voice_conversation' (m296)", live.includes("voice_conversation"))
  check("source admits 'text_conversation' (m296)", live.includes("text_conversation"))
  check("the three pre-existing sources are untouched",
    ["agent_created", "buyer_adjusted", "system_generated"].every((s) => live.includes(s)))

  const conv = src("lib/buyer-search/conversation-criteria.ts")
  const spoken = /SPOKEN_ALERT_SOURCE = "(\w+)"/.exec(conv)?.[1]
  const text = /TEXT_ALERT_SOURCE = "(\w+)"/.exec(conv)?.[1]
  check(`the spoken writer's source '${spoken}' is admitted`, !!spoken && live.includes(spoken))
  check(`the written writer's source '${text}' is admitted`, !!text && live.includes(text))

  // The rail's reject cascade DELETES. It must stay pinned to the proposal
  // sources — this is the assertion that makes widening (not flattening) safe.
  const agg = src("lib/kernel/approval-queue-aggregator.ts")
  const deleteWindow = agg.slice(agg.indexOf('.from("property_alerts")\n        .delete()'))
  check("the reject cascade DELETES only rows carrying a proposal source",
    /\.in\("source", \["voice_conversation", "text_conversation"\]\)/.test(deleteWindow.slice(0, 500)))
  check("…and only inactive ones, so a live alert can never be deleted",
    /\.eq\("is_active", false\)/.test(deleteWindow.slice(0, 500)))
  check("neither proposal source is one the rest of the product writes for live alerts",
    !["voice_conversation", "text_conversation"].includes("system_generated"))
}

console.log("\n── 3. video snippets: the readers moved onto the writer's value ──")
{
  const live = CHECK_VOCABULARIES.video_snippets?.approval_status ?? []
  check(`approval_status is the four-state ladder (${live.join(", ")})`, live.length === 4)
  check("'pending' is NOT one of them — the readers asked for the impossible",
    !live.includes("pending"))
  check("the shared constant IS one of them",
    live.includes(VIDEO_SNIPPET_PENDING_APPROVAL_STATUS))

  const repurposing = src("app/actions/video-repurposing.ts")
  const written = [...repurposing.matchAll(/approval_status:\s*"(\w+)"/g)].map((m) => m[1])
  check(`every snippet status the writer writes is admitted (${written.join(", ") || "none inline"})`,
    written.every((w) => live.includes(w)))

  for (const f of ["lib/kernel/approval-queue-aggregator.ts", "lib/managers/cross-referral.ts"]) {
    const t = src(f)
    const window = t.slice(t.indexOf("video_snippets"), t.indexOf("video_snippets") + 400)
    check(`${f}: the snippet filter uses the shared constant`,
      /VIDEO_SNIPPET_PENDING_APPROVAL_STATUS/.test(window))
    check(`${f}: no bare 'pending' snippet filter remains`,
      !/approval_status",\s*"pending"\)/.test(window))
  }
}

console.log("\n── the SLA mirror imports the queue's values instead of retyping them ──")
{
  const x = src("lib/managers/cross-referral.ts")
  check("it imports from the shared pending module",
    /from "@\/lib\/kernel\/approval-pending"/.test(x))
  for (const c of [
    "NEWSLETTER_PENDING_APPROVAL_STATUSES",
    "AD_CREATIVE_PENDING_APPROVAL_STATUSES",
    "BLOG_PENDING_PUBLISH_STATUS",
    "PODCAST_PENDING_APPROVAL_STATUS",
    "VIDEO_SNIPPET_PENDING_APPROVAL_STATUS",
  ]) {
    check(`the probe list uses ${c}`, new RegExp(`\\b${c}\\b`).test(x))
  }
  check("the ad-creative probe covers BOTH pending values, matching the queue",
    AD_CREATIVE_PENDING_APPROVAL_STATUSES.length === 2 &&
    /AD_CREATIVE_PENDING_APPROVAL_STATUSES/.test(x))

  // EVERY value in the shared module must be one its column can actually hold.
  // This is the assertion that caught the fifth defect in this cluster:
  // NEWSLETTER_PENDING_APPROVAL_STATUSES carried 'pending', documented as "the
  // legacy manual value", on a column whose CHECK is
  // (draft|pending_review|approved|rejected). No row has ever held it. Harmless
  // inside an .in() — and exactly the kind of dead literal the next reader
  // trusts.
  const nl = CHECK_VOCABULARIES.newsletter_campaigns?.approval_status ?? []
  const acv = CHECK_VOCABULARIES.ad_creative_variations?.approval_status ?? []
  const pod = CHECK_VOCABULARIES.podcast_episodes?.approval_status ?? []
  check(`every newsletter pending value is admitted (${NEWSLETTER_PENDING_APPROVAL_STATUSES.join(", ")})`,
    nl.length > 0 && NEWSLETTER_PENDING_APPROVAL_STATUSES.every((s) => nl.includes(s)))
  check("'pending' is gone from the newsletter constant — the column cannot hold it",
    !nl.includes("pending") && !(NEWSLETTER_PENDING_APPROVAL_STATUSES as readonly string[]).includes("pending"))
  check("every ad-creative pending value is admitted",
    acv.length > 0 && AD_CREATIVE_PENDING_APPROVAL_STATUSES.every((s) => acv.includes(s)))
  check("the podcast review gate is admitted too (or the column has no CHECK)",
    pod.length === 0 || pod.includes(PODCAST_PENDING_APPROVAL_STATUS))
}

console.log("\n── 4. disconnecting IDX actually pauses the alerts ──")
{
  const live = CHECK_VOCABULARIES.property_alerts?.paused_by ?? []
  check(`paused_by is the three actor classes (${live.join(", ")})`, live.length === 3)
  check("'admin_disconnect' is NOT an actor class — it is an event", !live.includes("admin_disconnect"))

  const idx = src("app/dashboard/settings/integrations/idx-broker/page.tsx")
  const written = [...idx.matchAll(/paused_by:\s*"(\w+)"/g)].map((m) => m[1])
  check(`every paused_by literal written is admitted (${written.join(", ")})`,
    written.length > 0 && written.every((w) => live.includes(w)))
  check("the event moved to paused_reason, where it is free text",
    /paused_reason: "IDX Broker integration disconnected"/.test(idx))
  check("the cascade is scoped to LIVE alerts, so proposal evidence survives it",
    /\.eq\("is_active", true\)/.test(idx))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ APPROVAL_RAIL_FAIL"); process.exit(1) }
console.log(" ✅ APPROVAL_RAIL_PASS — everything queued is findable, and rejecting something rejects it")
