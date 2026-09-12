#!/usr/bin/env tsx
/**
 * scripts/video-identity-approval-simulator.ts  (npm run test:video-identity-approval)
 *
 * TWO DEFECTS IN THE VIDEO LANE, BOTH ABOUT WRITING THE WRONG THING TO THE
 * RIGHT-LOOKING PLACE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A. THE ID CLASS — `commissionAvatarExplainer` wrote a USERS id into an AGENTS
 *    foreign key.
 *
 *    `ai_video_projects.agent_id` FKs `agents(id)` since m366 — proved by
 *    scripts/schema-fk-map.ts, which is generated from the live constraint graph:
 *
 *        "ai_video_projects": { "agent_id": "agents", "approved_by": "users", … }
 *
 *    `agents.id` and `users.id` are DISJOINT id spaces: no agents row's id is
 *    also a users id. Every caller of commissionAvatarExplainer holds a USERS id
 *    (app/actions/avatar-video.ts passes `resolveCaller().userId` straight
 *    through), and the insert wrote it verbatim — so every teammate-explainer
 *    commission raised 23503 and the lane had never produced a row.
 *
 *    THE SECOND FINDING IT EXPOSED: the READER of that same lane
 *    (getTeammateExplainerReadiness) already resolved correctly through
 *    `resolveAgentIdInBrokerage`. Reader and writer disagreed about what class
 *    the column holds — so even if the FK had let the row through, the surface
 *    that lists "your recent explainers" would never have shown it. The
 *    param's own doc-comment asserted the FK pointed at `users`, which is how the
 *    wrong id got written with a straight face.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * B. THE UNREACHED APPROVAL ROUTE — `app/api/video-scripts/[id]/approve/route.ts`
 *    (and its mirror .../reject) worked, and NOTHING in the tree called either.
 *
 *    They were DUPLICATES of `updateScriptApprovalStatus`
 *    (app/actions/video-generation.ts), which is what the library surface
 *    actually calls. Under the doctrine they are merged onto the survivor and
 *    deleted with a tombstone — and the merge was not cosmetic: the ROLE GATE
 *    lived only on the unreached routes, so the path everybody used let ANY
 *    signed-in member of the brokerage approve a video script, including its
 *    author.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS: restoring `agent_id: params.agentUserId`, dropping the role
 * gate, dropping the approved_at/approved_by stamps, or re-creating either route
 * each turns assertions red.
 *
 * No database. FK map + schema snapshot + source assertions.
 */
import { existsSync, readFileSync } from "node:fs"
import { SCHEMA_FK_MAP } from "./schema-fk-map"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; failures.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(p, "utf8"))

function main(): void {
  // ═══ 1. THE LIVE SCHEMA SETTLES THE ID CLASS ══════════════════════════════
  console.log("\n[1 · the FK map, not an opinion]")
  {
    const fks = (SCHEMA_FK_MAP as Record<string, Record<string, string>>)["ai_video_projects"] ?? {}
    check("ai_video_projects.agent_id FKs `agents` — so a users id is 23503, always",
      fks.agent_id === "agents", String(fks.agent_id))
    check("...and the same table's approved_by/rejected_by FK `users`, which is why\n    'agent_id' cannot be read as 'the person'",
      fks.approved_by === "users" && fks.rejected_by === "users")
    check("agents carries user_id — the ONLY bridge between the two id spaces",
      SCHEMA_SNAPSHOT.agents.includes("user_id"))
  }

  // ═══ 2. THE COMMISSION RESOLVES INSTEAD OF SUBSTITUTING ═══════════════════
  console.log("\n[2 · commissionAvatarExplainer]")
  {
    const ae = code("lib/video/avatar-explainer.ts")
    check("the users id is NO LONGER written straight into agent_id",
      !/agent_id:\s*params\.agentUserId/.test(ae))
    check("...it is resolved through agents.user_id first",
      ae.includes("resolveAgentIdInBrokerage(svc, params.agentUserId, params.brokerageId)"))
    check("...with the ONE shared resolver (lib/kernel/agent-identity), the same one\n    app/actions/video/create-video-project uses for this exact column",
      ae.includes("@/lib/kernel/agent-identity"))
    check("...and the resolved AGENTS id is what the row carries",
      /agent_id:\s*agentRecordId/.test(ae))
    check("no agent profile is a REFUSAL with a sentence — the column is NOT NULL,\n    so a null (or a substituted users id) would just be the FK phrasing it",
      /if \(!agentRecordId\)[\s\S]{0,300}status: "failed"/.test(ae))
    check("...and the refusal happens BEFORE the insert, not as its error handler",
      ae.indexOf("if (!agentRecordId)") < ae.indexOf('from("ai_video_projects").insert(row)'))

    // The doc-comment that authorised the bug.
    const raw = readFileSync("lib/video/avatar-explainer.ts", "utf8")
    check("the param doc no longer claims the FK points at `users` — that sentence is\n    what let the wrong id be written with a straight face",
      !/ai_video_projects\.agent_id FK → users\.id/.test(raw))
    check("...and says out loud that the two id spaces are disjoint",
      /DISJOINT/.test(raw))
  }

  // ═══ 3. THE SECOND FINDING — READER AND WRITER NOW AGREE ══════════════════
  console.log("\n[3 · the reader was already right, which is why nothing looked broken]")
  {
    const action = code("app/actions/avatar-video.ts")
    check("the READER resolves the agents id before filtering ai_video_projects",
      action.includes("resolveAgentIdInBrokerage(supabase, userId, brokerageId)")
        && /\.eq\("agent_id", agentId\)/.test(action))
    check("...so with the writer fixed, a commissioned explainer can actually appear\n    in 'your recent explainers' — reader and writer name the same class",
      !/\.eq\("agent_id", userId\)/.test(action))
    check("the commission's failure is RETURNED to the surface, never swallowed —\n    23503 was surfacing as an error string, which is why this was findable",
      /res\.error \|\| !res\.data[\s\S]{0,200}reason: res\.error\?\.message/.test(code("lib/video/avatar-explainer.ts")))
    check("...and the client surface renders it rather than showing a success toast",
      /if \(!res\.success\)[\s\S]{0,120}setError\(res\.error/.test(code("app/dashboard/videos/create/teammate-explainer-card.tsx")))
  }

  // ═══ 4. THE DUPLICATE APPROVAL ROUTES ARE GONE ════════════════════════════
  console.log("\n[4 · one video-script approval writer, reached by a real surface]")
  {
    check("app/api/video-scripts/[id]/approve/route.ts no longer exists",
      !existsSync("app/api/video-scripts/[id]/approve/route.ts"))
    check("...nor its mirror .../reject/route.ts, which was orphaned identically",
      !existsSync("app/api/video-scripts/[id]/reject/route.ts"))
    check("the collection route survives — the library surface really does fetch it",
      existsSync("app/api/video-scripts/route.ts")
        && code("app/dashboard/videos/library/page.tsx").includes("/api/video-scripts?id="))

    const vg = readFileSync("app/actions/video-generation.ts", "utf8")
    check("the survivor carries a TOMBSTONE naming what was deleted",
      vg.includes("app/api/video-scripts/[id]/approve/route.ts") && vg.includes("TOMBSTONE"))
    check("...and names the surface that reaches the survivor, at file:line",
      /app\/dashboard\/videos\/library\/page\.tsx:\d+/.test(vg))
    check("...and names the OTHER live approval path it deliberately did not collapse",
      vg.includes("applyMarketingAssetApproval") && vg.includes("approval-queue-aggregator.ts:"))
  }

  // ═══ 5. THE MERGE — the gate moved onto the door people use ═══════════════
  console.log("\n[5 · what the unreached routes had that the used path did not]")
  {
    const vg = code("app/actions/video-generation.ts")
    const fn = vg.slice(vg.indexOf("export async function updateScriptApprovalStatus"))
    const body = fn.slice(0, fn.indexOf("\nexport ", 1) > 0 ? fn.indexOf("\nexport ", 1) : fn.length)

    check("THE ROLE GATE now guards the path the library surface calls — it used to\n    exist only on the endpoint nothing pointed at",
      body.includes("isAdminOrBroker("))
    check("...resolving the role from the SESSION's own users row, not an argument",
      /\.from\("users"\)[\s\S]{0,160}\.eq\("id", actorUserId\)/.test(body))
    check("...and an unreadable role REFUSES — supabase-js resolves a refusal, so an\n    unchecked read would look exactly like a broker",
      /callerUserError[\s\S]{0,160}throw new Error/.test(body))

    check("approved_at + approved_by are stamped on an approval",
      /approvalStatus === "approved"[\s\S]{0,200}decision\.approved_at[\s\S]{0,120}decision\.approved_by/.test(body))
    check("rejected_at + rejected_by + rejection_reason are stamped on a rejection —\n    the routes discarded the reason entirely",
      /rejected_at[\s\S]{0,200}rejected_by[\s\S]{0,200}rejection_reason/.test(body))
    check("...and the stamps are CONDITIONAL, so approving does not write a\n    rejected_at and vice versa",
      /else if \(approvalStatus === "rejected"\)/.test(body))

    check("the survivor keeps its session-derived tenant (the routes trusted the URL)",
      /\.eq\("brokerage_id", brokerageId\)/.test(body) && body.includes("requireCaller()"))
    check("...and its lifecycle events", body.includes("SCRIPT_APPROVED") && body.includes("SCRIPT_REJECTED"))

    // PGRST204: every column named must exist, or the whole UPDATE is refused.
    const live = new Set(SCHEMA_SNAPSHOT.video_scripts_library)
    const named = ["approval_status", "compliance_review_notes", "updated_at",
      "approved_at", "approved_by", "rejected_at", "rejected_by", "rejection_reason"]
    const absent = named.filter((c) => !live.has(c))
    check("every column the merged writer names exists on video_scripts_library —\n    an absent one refuses the UPDATE ENTIRELY (PGRST204)",
      absent.length === 0, absent.join(", "))

    const fks = (SCHEMA_FK_MAP as Record<string, Record<string, string>>)["video_scripts_library"] ?? {}
    check("approved_by / rejected_by FK `users`, and actorUserId is a users id —\n    the classes match, so these are not the previous defect repeated",
      fks.approved_by === "users" && fks.rejected_by === "users")
  }

  console.log(`\n${"═".repeat(70)}`)
  console.log(`VIDEO IDENTITY + APPROVAL — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("The explainer files under a real agents id, and one gated writer owns script approval.")
}

main()
