#!/usr/bin/env tsx
/**
 * scripts/referral-appreciation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERRER LOVE LOOP (sphere_of_influence) — contacts who refer friends/family get
 * kept updated at each milestone and receive the small appreciation DECIDED BY the
 * agent / team / brokerage. Audit fix: referrals.referred_by was FREE TEXT, so the
 * OS couldn't know WHO to update — new referrals.referrer_contact_id links the
 * referrer as a contact.
 *
 * Layer 1 (pure): composeReferrerUpdate is privacy-tasteful (no $ / addresses /
 *   terms); the appreciation cascade (agent → team → brokerage, most-specific wins,
 *   default DISABLED, value hard-capped — never a cash referral fee).
 * Layer 2 (source): the runner rides the proactive-intelligence cron; proposals are
 *   GATED (agent_client_messages status proposed) + deduped by rationale tag;
 *   gift_sent flips only via the human-record action; UI panel wired on the pipeline.
 * Layer 3 (live, gated): seed an isolated brokerage + agent + referrer/referred
 *   contacts + a referral (contacted) → run → ONE gated update proposed; rerun →
 *   deduped; advance to closed + enable the brokerage setting → run → appreciation
 *   proposed carrying the configured gift; cleanup == 0.
 *
 * Run: npx tsx scripts/referral-appreciation-simulator.ts  (npm run test:referral-appreciation)
 */
import {
  composeReferrerUpdate, resolveAppreciationSetting, composeAppreciationProposal,
  scopesFromSettings, updateTag, appreciationTag, isUpdateStage,
  APPRECIATION_HARD_CAP_CENTS, REFERRAL_UPDATE_STAGES,
} from "../lib/kernel/referral-appreciation"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Referrer love loop verified — privacy-tasteful updates + configured appreciation, all gated")
  console.log(" REFERRAL_APPRECIATION_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Referral appreciation (referrer love loop) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure composers + cascade]")
  const upd = composeReferrerUpdate({ referrerFirstName: "Pat", referredFirstName: "Sam", stage: "under_contract" })
  check("update is warm + names both people", /Pat/.test(upd.body) && /Sam/.test(upd.body) && /milestone/.test(upd.body))
  check("update is PRIVACY-TASTEFUL — no $ amounts, no 'address', keeps details theirs",
    !/\$\d/.test(upd.body) && !/address/i.test(upd.body) && /privacy/i.test(upd.body))
  check("all four stages compose", REFERRAL_UPDATE_STAGES.every((s) => composeReferrerUpdate({ stage: s }).body.length > 40))
  check("isUpdateStage: received/lost are NOT update stages", !isUpdateStage("received") && !isUpdateStage("lost") && isUpdateStage("closed"))

  check("cascade: NOTHING configured → disabled (nothing proposes unbidden)",
    resolveAppreciationSetting({}).enabled === false)
  check("cascade: brokerage default applies when no agent/team override",
    (() => { const s = resolveAppreciationSetting({ brokerage: { enabled: true, maxValueCents: 4000, kind: "flowers" } }); return s.enabled && s.maxValueCents === 4000 && s.kind === "flowers" })())
  check("cascade: AGENT override outranks team + brokerage (most-specific wins)",
    (() => { const s = resolveAppreciationSetting({ brokerage: { enabled: true, maxValueCents: 4000 }, team: { enabled: true, maxValueCents: 6000 }, agent: { enabled: true, maxValueCents: 2500, kind: "coffee + card" } }); return s.maxValueCents === 2500 && s.kind === "coffee + card" })())
  check("value HARD-CAPPED (never a cash referral fee)",
    resolveAppreciationSetting({ brokerage: { enabled: true, maxValueCents: 9_999_999 } }).maxValueCents === APPRECIATION_HARD_CAP_CENTS)
  const prop = composeAppreciationProposal({ referrerFirstName: "Pat", referredFirstName: "Sam", setting: { enabled: true, maxValueCents: 5000, kind: "gift card", note: null } })
  check("appreciation proposal names the configured gift + the license-law caution",
    /gift card/.test(prop.body) && /\$50/.test(prop.body) && /not a referral fee/i.test(prop.body))
  check("scopesFromSettings reads brokerage default + byTeam/byAgent overrides",
    (() => { const sc = scopesFromSettings({ referral_appreciation: { enabled: true, byTeam: { t1: { maxValueCents: 1 } }, byAgent: { a1: { maxValueCents: 2 } } } }, "a1", "t1"); return !!sc.brokerage && (sc.team as any)?.maxValueCents === 1 && (sc.agent as any)?.maxValueCents === 2 })())
  check("dedupe tags are per (referral, stage) / per referral",
    updateTag("r1", "closed") === "[referral-update:r1:closed]" && appreciationTag("r1") === "[referral-appreciation:r1]")

  console.log("\n[Layer 2 · wiring]")
  const cronSrc = readFileSync(join(process.cwd(), "app/api/cron/proactive-intelligence/route.ts"), "utf8")
  check("runner rides the proactive-intelligence cron (best-effort)", /runReferralAppreciation\(/.test(cronSrc))
  const libSrc = readFileSync(join(process.cwd(), "lib/kernel/referral-appreciation.ts"), "utf8")
  check("proposals are GATED (status proposed on the sphere rail) + tag-deduped",
    /status: "proposed"/.test(libSrc) && /agent_kind: "sphere_of_influence"/.test(libSrc) && /ilike\("rationale"/.test(libSrc))
  const actSrc = readFileSync(join(process.cwd(), "app/actions/referrals/referral-appreciation.ts"), "utf8")
  check("gift_sent flips only via the human record action; setting write is role-scoped",
    /recordReferralGiftSentAction/.test(actSrc) && /Only a broker\/admin sets the brokerage default/.test(actSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/referrals/pipeline/page.tsx"), "utf8")
  check("appreciation panel wired on the referral pipeline", /ReferralAppreciationPanel/.test(pageSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live loop]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runReferralAppreciation } = await import("../lib/kernel/referral-appreciation")
  const svc = createServiceClient()
  const TAG = `RefLove${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live loop]")
  try {
    // Isolated tenant so we never touch a real brokerage's settings.
    const { data: brk } = await svc.from("brokerages").insert({ name: `${TAG} Brokerage` }).select("id").single()
    const brokerageId = (brk as any).id
    cleanup.push({ table: "brokerages", id: brokerageId })
    const userId = crypto.randomUUID()
    await svc.from("users").insert({ id: userId, email: `${TAG}@probe.local`.toLowerCase(), first_name: TAG, last_name: "Agent", user_type: "agent", brokerage_id: brokerageId, is_contact: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    cleanup.push({ table: "users", id: userId })
    const { data: agent } = await svc.from("agents").insert({ user_id: userId, brokerage_id: brokerageId, is_active: true, onboarding_status: "not_started" }).select("id").single()
    cleanup.push({ table: "agents", id: (agent as any).id })

    const { data: referrer } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: `${TAG}Ref`, last_name: "Referrer", contact_type: "buyer" }).select("id").single()
    cleanup.push({ table: "contacts", id: (referrer as any).id })
    const { data: referred } = await svc.from("contacts").insert({ brokerage_id: brokerageId, first_name: `${TAG}Friend`, last_name: "Referred", contact_type: "buyer" }).select("id").single()
    cleanup.push({ table: "contacts", id: (referred as any).id })

    const { data: ref, error: rErr } = await svc.from("referrals").insert({
      brokerage_id: brokerageId, agent_id: (agent as any).id, referring_agent_id: (agent as any).id,
      referrer_contact_id: (referrer as any).id, referred_contact_id: (referred as any).id,
      referral_name: `${TAG} Friend`, status: "contacted", referred_by: `${TAG}Ref Referrer`,
    }).select("id").single()
    if (rErr) { check("seed referral", false, rErr.message); report(); return }
    const referralId = (ref as any).id
    cleanup.push({ table: "referrals", id: referralId })

    // Run 1 — a gated milestone update for 'contacted'.
    const r1 = await runReferralAppreciation(brokerageId, svc)
    check("run: ONE gated referrer update proposed at 'contacted'", r1.updatesProposed === 1 && r1.appreciationsProposed === 0, JSON.stringify(r1))
    const { data: msg } = await svc.from("agent_client_messages").select("id, status, rationale, recipient_contact_id")
      .ilike("rationale", `${updateTag(referralId, "contacted")}%`).maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("proposal is GATED + addressed to the REFERRER", (msg as any)?.status === "proposed" && (msg as any)?.recipient_contact_id === (referrer as any).id)

    // Run 2 — same stage dedupes.
    const r2 = await runReferralAppreciation(brokerageId, svc)
    check("rerun at the same stage is DEDUPED", r2.updatesProposed === 0 && r2.skippedDuplicate >= 1, JSON.stringify(r2))

    // Enable the brokerage appreciation + close the referral → update + configured gift.
    await svc.from("brokerage_settings").insert({ brokerage_id: brokerageId, settings: { referral_appreciation: { enabled: true, maxValueCents: 5000, kind: "gift card" } } })
    const { data: bs } = await svc.from("brokerage_settings").select("id").eq("brokerage_id", brokerageId).single()
    cleanup.push({ table: "brokerage_settings", id: (bs as any).id })
    await svc.from("referrals").update({ status: "closed" }).eq("id", referralId)

    const r3 = await runReferralAppreciation(brokerageId, svc)
    check("on CLOSE: milestone update + the CONFIGURED appreciation both proposed",
      r3.updatesProposed === 1 && r3.appreciationsProposed === 1, JSON.stringify(r3))
    const { data: gift } = await svc.from("agent_client_messages").select("id, body").ilike("rationale", `${appreciationTag(referralId)}%`).maybeSingle()
    if (gift) cleanup.push({ table: "agent_client_messages", id: (gift as any).id })
    const { data: closeMsg } = await svc.from("agent_client_messages").select("id").ilike("rationale", `${updateTag(referralId, "closed")}%`).maybeSingle()
    if (closeMsg) cleanup.push({ table: "agent_client_messages", id: (closeMsg as any).id })
    check("appreciation carries the configured gift ($50 gift card) + fee caution",
      /gift card/.test((gift as any)?.body ?? "") && /\$50/.test((gift as any)?.body ?? "") && /not a referral fee/i.test((gift as any)?.body ?? ""))

    // gift_sent flips → next run proposes no second appreciation.
    await svc.from("referrals").update({ gift_sent: true, gift_sent_at: new Date().toISOString() }).eq("id", referralId)
    const r4 = await runReferralAppreciation(brokerageId, svc)
    check("gift recorded → no further appreciation (updates also deduped)", r4.appreciationsProposed === 0 && r4.updatesProposed === 0, JSON.stringify(r4))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("brokerages").select("id", { count: "exact", head: true }).eq("name", `${TAG} Brokerage`)
    const { count: mCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).ilike("rationale", `%${TAG}%`)
    check("cleanup verified — 0 seeded rows remain", (count ?? 0) === 0 && (mCount ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
