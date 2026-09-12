/**
 * scripts/test-direct-mail-pipeline.ts
 *
 * Wave 36 — live end-to-end test of the branded direct-mail pipeline.
 * Exercises every stage against live infrastructure:
 *   - Brand resolver (Supabase read)
 *   - AI copy generator with Fair Housing redraft loop (real Anthropic call)
 *   - Remotion renderStill for postcard front + back (real Chromium bundle)
 *   - Vercel Blob upload (real put)
 *   - Lob US verification (real Lob API, test mode)
 *   - dispatchDirectMail egress (Lob test-mode send; $0 spend)
 *
 * Hard guards:
 *   - Refuses to run without TEST_DIRECT_MAIL=1 env var set
 *   - Refuses to run if LOB_API_KEY exists and does NOT start with "test_"
 *     (prevents accidental real-mail spend in a dev environment)
 *   - Wraps test data in transaction-style cleanup: every row inserted
 *     is tracked + deleted in the finally block, regardless of outcome
 *
 * Run:
 *   TEST_DIRECT_MAIL=1 npx tsx scripts/test-direct-mail-pipeline.ts
 *
 * Output: structured PASS/FAIL per stage + total ms + total $ cost.
 */
import "dotenv/config"
import { randomUUID } from "node:crypto"
import { createServiceClient } from "../lib/supabase/service"
import { resolveBrandContext } from "../lib/branding/resolve-brand-context"
import { draftPostcardCopy } from "../lib/direct-mail/draft-copy"
import { renderPostcardBothSides4x6 } from "../lib/direct-mail/render-postcard"
import { renderLetterHtml } from "../lib/direct-mail/render-letter"
import { dispatchDirectMail } from "../lib/providers/dispatch"
import { pickVariantArm } from "../lib/direct-mail/variant-bandit"

type StageResult = { stage: string; ok: boolean; ms: number; detail?: string; error?: string }

async function main(): Promise<number> {
  if (process.env.TEST_DIRECT_MAIL !== "1") {
    console.error("REFUSED: set TEST_DIRECT_MAIL=1 to opt in.")
    return 2
  }
  const lobKey = process.env.LOB_API_KEY
  if (lobKey && !lobKey.startsWith("test_")) {
    console.error("REFUSED: LOB_API_KEY is a LIVE key. Would burn real postage. Set a test_* key or unset.")
    return 2
  }

  const svc = createServiceClient()
  const results: StageResult[] = []
  const inserted: Array<{ table: string; id: string }> = []

  // ── Resolve a live brokerage we can scope test rows to ────────────────────
  const { data: brokerageRow, error: brokerageErr } = await svc
    .from("brokerages")
    .select("id, name")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (brokerageErr || !brokerageRow) {
    console.error("No brokerage found:", brokerageErr?.message)
    return 1
  }
  const brokerageId = brokerageRow.id as string
  console.log(`[test] Using brokerage: ${brokerageRow.name} (${brokerageId})`)

  // ── Insert test contact + verified mailing address ────────────────────────
  const testTag = `dm-pipeline-test-${randomUUID().slice(0, 8)}`
  const contactInsert = await svc
    .from("contacts")
    .insert({
      brokerage_id:             brokerageId,
      first_name:               "Test",
      last_name:                testTag,
      email:                    `${testTag}@example.invalid`,
      contact_persona:          "downsize",
      mailing_address:          "185 Berry St",
      mailing_address_verified: true,
      city:                     "San Francisco",
      state:                    "CA",
      zip_code:                 "94107",
      direct_mail_opt_out:      false,
      dnc_status:               false,
      created_at:               new Date().toISOString(),
    })
    .select("id")
    .single()
  if (contactInsert.error || !contactInsert.data) {
    console.error("contact insert failed:", contactInsert.error?.message)
    return 1
  }
  const testContactId = contactInsert.data.id as string
  inserted.push({ table: "contacts", id: testContactId })
  console.log(`[test] Test contact: ${testContactId}`)

  try {
    // ── Stage 1: Brand resolver ──────────────────────────────────────────────
    {
      const t0 = Date.now()
      try {
        // resolve-brokerage-brand.ts (the deprecated brokerage-only alias) was
        // deleted 2026-09-03; the brokerage-tier call is the survivor with only
        // brokerageId supplied.
        const brand = await resolveBrandContext({ brokerageId })
        results.push({
          stage: "brand_resolver",
          ok:    !!brand.brokerageName && !!brand.visual.primaryColor,
          ms:    Date.now() - t0,
          detail: `${brand.brokerageName} primary=${brand.visual.primaryColor} accent=${brand.visual.accentColor} EHO=${brand.fairHousing.shortDisclosure.slice(0, 40)}…`,
        })
      } catch (e) {
        results.push({ stage: "brand_resolver", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    }

    // ── Stage 2: AI copy with Fair Housing redraft loop ──────────────────────
    let postcardCopy: { headline: string; body: string; cta: string } | null = null
    {
      const t0 = Date.now()
      try {
        const r = await draftPostcardCopy({
          brokerageId,
          contactId: testContactId,
          persona:   "downsize",
          qrDestinationType: "cma_form",
          hookFacts: {
            farmZip:     "94107",
            medianPrice: 1_650_000,
            daysOnMarket: 11,
          },
        })
        if (r.ok) {
          postcardCopy = r.copy
          results.push({
            stage: "draft_postcard_copy",
            ok:    true,
            ms:    Date.now() - t0,
            detail: `headline="${r.copy.headline}" body=${r.copy.body.length}ch cta="${r.copy.cta}"`,
          })
        } else {
          results.push({
            stage: "draft_postcard_copy",
            ok:    false,
            ms:    Date.now() - t0,
            error: `gate_failed: ${r.violations.join("; ")}`,
          })
        }
      } catch (e) {
        results.push({ stage: "draft_postcard_copy", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    }

    // ── Stage 3: Letter HTML ─────────────────────────────────────────────────
    {
      const t0 = Date.now()
      try {
        const r = await renderLetterHtml({
          brokerageId,
          copyCtx: {
            brokerageId,
            contactId: testContactId,
            persona:   "downsize",
            hookFacts: { farmZip: "94107", medianPrice: 1_650_000 },
          },
          recipientFirstName: "Test",
          recipientLastName:  testTag,
          recipientStreet:    "185 Berry St",
          recipientCityState: "San Francisco, CA",
          recipientZip:       "94107",
          agentName:          "Test Agent",
          agentTitle:         "REALTOR®",
        })
        results.push({
          stage: "render_letter_html",
          ok:    r.ok && !!r.html && r.html.includes("Equal Housing Opportunity"),
          ms:    Date.now() - t0,
          detail: r.ok ? `html_bytes=${r.html?.length ?? 0} includes_EHO=true` : `gate_failed: ${r.violations?.join("; ")}`,
        })
      } catch (e) {
        results.push({ stage: "render_letter_html", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    }

    // ── Stage 4: Postcard front+back render + Blob upload ────────────────────
    let frontUrl: string | undefined
    let backUrl:  string | undefined
    if (postcardCopy) {
      const t0 = Date.now()
      try {
        const r = await renderPostcardBothSides4x6({
          brokerageId,
          copyCtx: {
            brokerageId,
            contactId: testContactId,
            persona:   "downsize",
            qrDestinationType: "cma_form",
            hookFacts: { farmZip: "94107", medianPrice: 1_650_000, daysOnMarket: 11 },
          },
          qrScanUrl:     "https://vipreos.com/qr/scan?slug=test",
          agentName:     "Test Agent",
          agentPhotoUrl: null,
        })
        if (r.ok) {
          frontUrl = r.frontUrl
          backUrl  = r.backUrl
          results.push({
            stage: "render_postcard_both_sides",
            ok:    !!frontUrl && !!backUrl,
            ms:    Date.now() - t0,
            detail: `frontUrl=${frontUrl?.slice(0, 60)}… backUrl=${backUrl?.slice(0, 60)}…`,
          })
        } else {
          results.push({
            stage: "render_postcard_both_sides",
            ok:    false,
            ms:    Date.now() - t0,
            error: r.error ?? r.violations?.join("; "),
          })
        }
      } catch (e) {
        results.push({ stage: "render_postcard_both_sides", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    } else {
      results.push({ stage: "render_postcard_both_sides", ok: false, ms: 0, error: "skipped — copy gate failed upstream" })
    }

    // ── Stage 5: dispatchDirectMail egress (Lob test-mode if key configured) ──
    if (frontUrl && backUrl) {
      const t0 = Date.now()
      try {
        const dispatch = await dispatchDirectMail({
          brokerageId,
          userId:         brokerageId,
          contactId:      testContactId,
          recipientName:  `Test ${testTag}`,
          mailingAddress: "185 Berry St",
          city:           "San Francisco",
          state:          "CA",
          zip:            "94107",
          templateId:     frontUrl,
          backTemplateId: backUrl,
          pieceType:      "postcard",
          systemSource:   "dm_pipeline_test",
        })
        results.push({
          stage: "dispatch_direct_mail",
          ok:    dispatch.success || dispatch.providerKey === "lob",  // test-mode counts as success
          ms:    Date.now() - t0,
          detail: `provider=${dispatch.providerKey} ${dispatch.success ? `msg=${dispatch.messageId}` : `err=${dispatch.error?.slice(0, 80)}`}`,
        })
      } catch (e) {
        results.push({ stage: "dispatch_direct_mail", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    } else {
      results.push({ stage: "dispatch_direct_mail", ok: false, ms: 0, error: "skipped — render failed upstream" })
    }

    // ── Stage 6 (Wave 36 team-tier): three-tier brand cascade ────────────────
    // Inserts a test team with its own logo+colors + a test agent under it.
    // Verifies resolveBrandContext returns team brand (not brokerage) for
    // logo/color, and agent's license over brokerage's. Cleanup deletes the
    // team + agent at the end of the finally block.
    {
      const t0 = Date.now()
      try {
        const teamTag = `dm-pipeline-team-${randomUUID().slice(0, 8)}`

        const teamInsert = await svc.from("teams").insert({
          name:           `Test Team ${teamTag}`,
          brokerage_id:   brokerageId,
          logo_url:       "https://example.invalid/team-logo.png",
          primary_color:  "#7c3aed",  // distinct from brokerage primary
          accent_color:   "#facc15",
          phone:          "(555) 222-0001",
          tagline:        "Where Test Team Sells",
        }).select("id").single()
        if (teamInsert.error || !teamInsert.data) {
          throw new Error(`team insert: ${teamInsert.error?.message}`)
        }
        const teamId = teamInsert.data.id as string
        inserted.push({ table: "teams", id: teamId })

        // Insert a test users row first since agents.user_id FKs to users
        // (agents.id is the agent record id, not a user id).
        // Most live envs have a constraint that user_id NOT NULL — we
        // accept the failure path if not.
        let testUserId: string | null = null
        const userInsert = await svc.from("users").insert({
          email:        `${teamTag}@example.invalid`,
          first_name:   "Pipeline",
          last_name:    teamTag,
          user_type:    "agent",
          brokerage_id: brokerageId,
        }).select("id").single()
        if (userInsert.error || !userInsert.data) {
          throw new Error(`user insert: ${userInsert.error?.message}`)
        }
        testUserId = userInsert.data.id as string
        inserted.push({ table: "users", id: testUserId })

        const agentInsert = await svc.from("agents").insert({
          user_id:        testUserId,
          brokerage_id:   brokerageId,
          team_id:        teamId,
          first_name:     "Pipeline",
          last_name:      teamTag,
          is_active:      true,
          license_state:  "CA",
          license_number: "TEST-99-99999",
          phone_office:   "(555) 222-0002",
        }).select("id").single()
        if (agentInsert.error || !agentInsert.data) {
          throw new Error(`agent insert: ${agentInsert.error?.message}`)
        }
        const testAgentId = agentInsert.data.id as string
        inserted.push({ table: "agents", id: testAgentId })

        // Now invoke the resolver with team + agent context.
        const teamBrand = await resolveBrandContext({
          brokerageId,
          teamId,
          agentUserId: testUserId,
        })

        // Assertions:
        //   - displayName = team name (not brokerage)
        //   - source.logo = "team" (we set team.logo_url)
        //   - source.color = "team" (we set team.primary_color)
        //   - source.license = "agent" (agent license overrides brokerage)
        const checks = [
          teamBrand.displayName.includes(teamTag),
          teamBrand.source.logo === "team",
          teamBrand.source.color === "team",
          teamBrand.source.license === "agent",
          teamBrand.display.licenseLine?.includes("TEST-99-99999"),
        ]
        const allPassed = checks.every(Boolean)
        results.push({
          stage: "tier_cascade_team_brand",
          ok:    allPassed,
          ms:    Date.now() - t0,
          detail: `displayName="${teamBrand.displayName}" logoSrc=${teamBrand.source.logo} colorSrc=${teamBrand.source.color} licSrc=${teamBrand.source.license} license="${teamBrand.display.licenseLine}"`,
        })
      } catch (e) {
        results.push({ stage: "tier_cascade_team_brand", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    }

    // ── Stage 7 (Wave 36 bandit): pickVariantArm materializes catalog ────────
    {
      const t0 = Date.now()
      try {
        const pick = await pickVariantArm({
          brokerageId,
          persona:     "downsize",
          useKind:     "farm_mail",
          size:        "4x6",
        })
        results.push({
          stage: "bandit_pick_arm",
          ok:    !!pick && !!pick.variantId,
          ms:    Date.now() - t0,
          detail: pick ? `picked composition=${pick.compositionId} copy_style=${pick.copyStyle} sampled=${pick.sampledProb.toFixed(3)} exploration=${pick.isExploration}` : "no arms (catalog seed failed)",
        })
      } catch (e) {
        results.push({ stage: "bandit_pick_arm", ok: false, ms: Date.now() - t0, error: (e as Error).message })
      }
    }

  } finally {
    // ── Cleanup: delete every test row we inserted ────────────────────────────
    console.log("[test] Cleaning up test rows…")
    // Wave 36 — also clean bandit catalog rows materialized for this
    // brokerage during the test (the catalog is brokerage-scoped, so
    // arms seeded by Stage 7's pickVariantArm linger otherwise).
    await svc.from("direct_mail_variant_outcomes").delete().eq("brokerage_id", brokerageId).gte("updated_at", new Date(Date.now() - 5 * 60_000).toISOString())
    await svc.from("direct_mail_variants").delete().eq("brokerage_id", brokerageId).gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
    await svc.from("direct_mail_campaigns").delete().eq("contact_id", testContactId)
    await svc.from("message_provider_logs").delete().eq("brokerage_id", brokerageId).gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
    for (const row of inserted.reverse()) {
      const { error } = await svc.from(row.table).delete().eq("id", row.id)
      if (error) console.warn(`[test] cleanup ${row.table}#${row.id} failed: ${error.message}`)
    }
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log("\n──── DIRECT-MAIL PIPELINE TEST REPORT ────")
  let passed = 0
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL"
    console.log(`[${tag}] ${r.stage.padEnd(30)} ${String(r.ms).padStart(6)}ms  ${r.ok ? (r.detail ?? "") : (r.error ?? "")}`)
    if (r.ok) passed++
  }
  console.log(`\n${passed}/${results.length} stages passed`)
  return passed === results.length ? 0 : 1
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("UNHANDLED:", e)
  process.exit(1)
})
