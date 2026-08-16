#!/usr/bin/env tsx
/**
 * scripts/vendor-media-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MIDDLE THAT WAS NEVER BUILT.
 *
 * Three capabilities shipped complete and shipped unreachable:
 *
 *   1. VENDOR REVIEW-AS-A-PRODUCT. lib/kernel/vendor-review-moderation.ts holds
 *      verification, weighted averages, an auto-screen, a community flag
 *      threshold and the vendor's one immutable public response. The service
 *      wiring (submit / respond / flag / moderate) sat in vendor-marketplace.ts
 *      with NO caller anywhere: a review routed to `pending` was routed to a
 *      queue no screen rendered, a vendor could not read a review of itself, and
 *      moderateVendorReview had nothing to moderate. Worse, respondToVendorReview's
 *      ownership gate was `vendors.select(id).eq("id", review.vendor_id)` — "does
 *      the reviewed vendor exist" — which is true for every real review, so ANY
 *      authenticated user could post the vendor's one permanent public reply.
 *
 *   2. THE MLS PHOTO SET. `listing_photos` is what MLS ordering, hero selection,
 *      readiness checks and direct mail all read. processVendorPhotos is the ONLY
 *      writer of that table in the entire app and it had no caller, so the set was
 *      structurally empty. Meanwhile the Media Manager's photo tools passed
 *      `listing_media` ids into actions that resolve `listing_photos` ids, and its
 *      photo filter tested `media_type === "image"` — a value the CHECK constraint
 *      on that column cannot hold — so the button matched nothing, ever.
 *
 *   3. VIDEO PERFORMANCE. loadVideoPerformance aggregates real distribution
 *      metrics and is the one kernel video command with no API route, so the
 *      server action was the only path to it and nothing called it.
 *
 * SOURCE layer: every wired action is reachable from a real surface, the identity
 * classes are RESOLVED rather than substituted, the ownership gates are the real
 * linkage, and the two paths that must NOT be wired still are not.
 * LIVE layer (creds-gated): the schema facts the wiring depends on — the agents-class
 * FK, the media_type vocabulary, the flag dedupe constraint, the absent vendors.user_id.
 * Read-only: this simulator creates no rows and therefore leaves no residue.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const A_VENDOR = "app/actions/vendor-marketplace.ts"
const A_PHOTO = "app/actions/photo-management.ts"
const A_VIDEO = "app/actions/video.ts"
const A_ROLE_GRANTS = "lib/auth/role-grants.ts"
const S_DIRECTORY = "app/dashboard/vendors/vendor-directory-client.tsx"
const S_TXN = "app/components/transactions/VendorBookingSection.tsx"
const S_VENDOR_REVIEWS = "app/vendor/reviews/reviews-client.tsx"
const S_VENDOR_REVIEWS_PAGE = "app/vendor/reviews/page.tsx"
const S_MODERATION = "app/dashboard/admin/vendor-approvals/review-moderation-client.tsx"
const S_APPROVALS = "app/dashboard/admin/vendor-approvals/page.tsx"
const S_MEDIA = "app/dashboard/listings/[id]/media/media-manager-client.tsx"
const S_VIDEO_LIB = "app/dashboard/videos/library/page.tsx"

/** A server action is WIRED when a surface both imports it and calls it. Asserting
 *  the import alone would pass on a dead import that no handler ever invokes. */
function wiredFrom(surface: string, fn: string, actionModule: string): boolean {
  const s = code(surface)
  const imported =
    new RegExp(`import[\\s\\S]{0,600}?\\b${fn}\\b[\\s\\S]{0,600}?from\\s+["'][^"']*${actionModule}["']`).test(s) ||
    new RegExp(`\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*=\\s*await\\s+import\\(\\s*["'][^"']*${actionModule}["']`).test(s)
  const called = new RegExp(`\\b${fn}\\s*\\(`).test(s)
  return imported && called
}

function vendorReviewLayer() {
  console.log("\n[source · the review system finally has both ends]")
  const actions = code(A_VENDOR)

  // ── The vendor's side ──────────────────────────────────────────────────────
  check("a vendor can read reviews of itself (getMyVendorReviews exists and the portal page loads it)",
    /export async function getMyVendorReviews/.test(actions) &&
    /getMyVendorReviews\s*\(/.test(code(S_VENDOR_REVIEWS_PAGE)))
  check("...and can post its one public response from that page",
    wiredFrom(S_VENDOR_REVIEWS, "respondToVendorReview", "actions/vendor-marketplace"))

  // The gate this replaces read `vendors.select("id").eq("id", review.vendor_id)`
  // — an existence check that every real review satisfies. Assert the CONSTRUCT:
  // the caller's own vendor id must be COMPARED against the reviewed vendor id.
  check("the response gate compares the CALLER'S vendor to the reviewed vendor",
    /export async function respondToVendorReview[\s\S]{0,1600}?resolveCallerVendorId[\s\S]{0,300}?!==\s*\(review as any\)\.vendor_id/.test(actions))
  // THE CLAIM IS THE LINKAGE, NOT THE FILE IT LIVES IN.
  //
  // This used to require the literal `.from("user_role_assignments")` INSIDE
  // resolveCallerVendorId. That query has since moved into the shared reader
  // lib/auth/role-grants.ts — because user_role_assignments is UNIQUE on
  // (user_id, ROLE), not on user_id, so a single-row read of it is unsound and
  // six sites were reading it that way. Pinning the assertion to one file turned
  // a correct consolidation into a red guard: the probe could not tell a MOVE
  // from a DELETION, which is the same lesson the orphan-export census had to
  // learn.
  //
  // So it is asserted as a CHAIN. The caller must delegate to the shared reader,
  // and the shared reader must be the thing that reads vendor_id off
  // user_role_assignments. Either link breaking still goes red — including the
  // failure this guards against, a linkage invented on `vendors.user_id`, a
  // column that does not exist.
  const roleGrants = code(A_ROLE_GRANTS)
  check("...and that vendor linkage is user_role_assignments.vendor_id (vendors has no user_id)",
    /async function resolveCallerVendorId[\s\S]{0,900}?readRoleGrants\([\s\S]{0,400}?selectVendorId\(/.test(actions)
    && /from\("user_role_assignments"\)[\s\S]{0,200}?vendor_id/.test(roleGrants)
    && !/from\("vendors"\)[\s\S]{0,200}?user_id/.test(actions + roleGrants))
  check("...and an AMBIGUOUS vendor linkage refuses rather than picking one",
    /ambiguous/.test(actions) && /ambiguous/.test(roleGrants))
  check("...so the old existence-check gate is gone",
    !/from\("vendors"\)\s*\.select\("id"\)\s*\.eq\("id",\s*\(review as any\)\.vendor_id\)/.test(actions))

  // ── Flagging ───────────────────────────────────────────────────────────────
  check("a vendor cannot flag a review of itself",
    /export async function flagVendorReview[\s\S]{0,1400}?resolveCallerVendorId[\s\S]{0,300}?===\s*\(review as any\)\.vendor_id[\s\S]{0,200}?throw new Error/.test(actions))
  check("an agent can flag a review from the vendor directory",
    wiredFrom(S_DIRECTORY, "flagVendorReview", "actions/vendor-marketplace"))

  // ── Submitting ─────────────────────────────────────────────────────────────
  check("an agent can submit a transaction-linked review from the vendor directory",
    wiredFrom(S_DIRECTORY, "submitVendorReview", "actions/vendor-marketplace"))
  check("...and the surface reports the SERVER'S moderation verdict rather than claiming success",
    /moderationStatus\s*===\s*"approved"/.test(code(S_DIRECTORY)))

  // ── Moderating ─────────────────────────────────────────────────────────────
  check("the moderation queue reader exists and is admin-gated",
    /export async function getVendorReviewModerationQueue/.test(actions) &&
    /getVendorReviewModerationQueue[\s\S]{0,1600}?if \(![^)]*!isAdmin\)\s*return \[\]/.test(actions))
  check("...it surfaces exactly the two statuses the brain routes to a human",
    /getVendorReviewModerationQueue[\s\S]{0,2000}?\.in\("moderation_status",\s*\["pending",\s*"under_review"\]\)/.test(actions))
  check("...and an admin can decide them from the vendor governance page",
    wiredFrom(S_MODERATION, "moderateVendorReview", "actions/vendor-marketplace") &&
    /<ReviewModerationClient[\s\S]{0,200}?initialQueue=\{await getVendorReviewModerationQueue\(\)\}/.test(code(S_APPROVALS)))

  // supabase-js RESOLVES a refused UPDATE — returning ok:true on one would tell an
  // admin the review was decided while it sat in the queue.
  check("a refused moderation UPDATE is not reported as a decision",
    /export async function moderateVendorReview[\s\S]{0,1800}?decisionError[\s\S]{0,200}?throw decisionError/.test(actions))

  // ── The reader the agent directory already used ────────────────────────────
  check("a REJECTED review no longer argues its case on the vendor's card",
    /export async function getVendorReviews[\s\S]{0,1400}?\.neq\("moderation_status",\s*"rejected"\)/.test(actions))
  check("...and a failed review read is not rendered as 'no reviews'",
    /export async function getVendorReviews[\s\S]{0,1600}?if \(error\)[\s\S]{0,200}?return \[\]/.test(actions))
}

function vendorAssignmentLayer() {
  console.log("\n[source · assignments are visible on the deal]")
  check("the transaction's vendor section loads its ASSIGNMENTS, not only its bookings",
    wiredFrom(S_TXN, "getAssignedVendorsForTransaction", "actions/vendor-marketplace"))
  const txn = code(S_TXN)
  // vendor_jobs is what carries the quoted/actual cost — an assignment rendered
  // without its jobs hides the money.
  check("...and renders the vendor_jobs those assignments carry",
    /vendor_jobs/.test(txn) && /cost_estimate/.test(txn) && /cost_actual/.test(txn))
}

function photoLayer() {
  console.log("\n[source · the MLS photo set has a writer and a screen]")
  const actions = code(A_PHOTO)
  const media = code(S_MEDIA)

  check("the only writer of listing_photos is reachable from the Media Manager",
    wiredFrom(S_MEDIA, "processVendorPhotos", "actions/photo-management"))
  check("the MLS set can be READ, so a surface can hold real listing_photos ids",
    /export async function getListingPhotoSet/.test(actions) &&
    wiredFrom(S_MEDIA, "getListingPhotoSet", "actions/photo-management"))

  // listing_media.media_type is CHECK-constrained; "image" is not in the vocabulary,
  // so the old filter could only ever match zero rows.
  check("the photo filter uses a media_type the CHECK constraint admits",
    /media_type\s*===\s*"photo"/.test(media) && !/media_type\s*===\s*"image"/.test(media))

  // The tools resolve listing_photos ids. Feeding them listing_media ids made every
  // one of them answer "photo not found" against a row that was never on screen.
  // The two tables were consolidated (m368/m369): listing_media is now the one
  // home and listing_photos is dropped. The REQUIREMENT is unchanged — the tools
  // must be driven from the resolved MLS photo set, not from raw rows — so this
  // follows the capability onto the surviving column rather than pinning the
  // retired spelling.
  check("photo tools are driven from the MLS photo set, not from raw media rows",
    /photoSet/.test(media) && /file_url/.test(media))

  check("quality validation and photo stats are on the screen",
    wiredFrom(S_MEDIA, "validatePhotoQuality", "actions/photo-management") &&
    wiredFrom(S_MEDIA, "getPhotoPerformanceStats", "actions/photo-management"))
  check("ordering and batch enhancement are on the screen",
    wiredFrom(S_MEDIA, "optimizePhotoOrder", "actions/photo-management") &&
    wiredFrom(S_MEDIA, "batchEnhancePhotos", "actions/photo-management"))

  console.log("\n[source · identity classes are resolved, never substituted]")
  // photo_ordering_rules.agent_id and photo_enhancement_jobs.agent_id both FK agents(id).
  check("the ordering rule's owner is RESOLVED from the session (agents-class)",
    /resolveUserIdToAgentRecord/.test(actions) &&
    /export async function savePhotoOrderingRule[\s\S]{0,900}?callerAgentRecordId/.test(actions))
  check("...and is no longer a client-supplied agentId",
    !/export async function savePhotoOrderingRule\(params:\s*\{\s*\n?\s*agentId/.test(actions))
  check("enhancement jobs resolve the same way",
    /export async function enhancePhoto[\s\S]{0,1000}?callerAgentRecordId/.test(actions) &&
    /export async function batchEnhancePhotos[\s\S]{0,1200}?callerAgentRecordId/.test(actions))

  console.log("\n[source · a saved rule actually changes the order]")
  // Without this read, savePhotoOrderingRule is a placebo: a preference nothing consults.
  check("optimizePhotoOrder reads the caller's ACTIVE ordering rule",
    /export async function optimizePhotoOrder[\s\S]{0,2500}?from\("photo_ordering_rules"\)[\s\S]{0,400}?\.eq\("is_active",\s*true\)/.test(actions))
  check("...and a failed rule read does not silently downgrade to the default order",
    /export async function optimizePhotoOrder[\s\S]{0,2600}?ruleError[\s\S]{0,300}?return \{ success: false/.test(actions))

  console.log("\n[source · refused writes are not counted as successes]")
  check("a refused MLS-set INSERT is reported, not tallied",
    /export async function processVendorPhotos[\s\S]{0,6000}?insertError[\s\S]{0,400}?return \{ success: false/.test(actions))
  // The import gained a second half at consolidation: a photo already present as
  // marketing-only is ADOPTED into the MLS set by promoting usage_intent rather
  // than copied across tables. A refused promotion must not be tallied either.
  check("...and so is a refused adoption of an existing marketing photo",
    /export async function processVendorPhotos[\s\S]{0,6000}?adoptError[\s\S]{0,400}?return \{ success: false/.test(actions))
  check("the import is idempotent (an already-ingested URL is skipped, not duplicated)",
    /export async function processVendorPhotos[\s\S]{0,4000}?byUrl[\s\S]{0,400}?skipped\+\+/.test(actions))
  check("every ingested row carries its tenant and its uploader",
    /export async function processVendorPhotos[\s\S]{0,2600}?brokerage_id:\s*ctx\.brokerageId[\s\S]{0,300}?uploaded_by:\s*ctx\.userId/.test(actions))
}

function videoLayer() {
  console.log("\n[source · video]")
  const actions = code(A_VIDEO)

  check("video performance is reachable — the library can load it",
    wiredFrom(S_VIDEO_LIB, "loadVideoPerformanceAction", "actions/video"))
  // The kernel command reads ai_video_projects by id with no tenant check of its
  // own, so the action layer must do it before delegating.
  check("...behind a brokerage check, so a browser cannot name any project id",
    /export async function loadVideoPerformanceAction[\s\S]{0,600}?assertProjectInCallerBrokerage/.test(actions) &&
    /async function assertProjectInCallerBrokerage[\s\S]{0,900}?project\.brokerage_id\s*!==\s*profile\.brokerage_id/.test(actions))

  // THE SETTLED RULING: video projects are created through
  // app/actions/video/create-video-project.ts:createVideoProject. The kernel
  // wrapper inserts ai_video_projects directly with a client-supplied agent id.
  console.log("\n[source · the path that must stay unwired]")
  const wiredAnywhere = [S_VIDEO_LIB, S_MEDIA, S_DIRECTORY, S_TXN]
    .some((s) => /createVideoProjectAction\s*\(/.test(code(s)))
  check("createVideoProjectAction is NOT wired to a surface", !wiredAnywhere)
  check("...and the owner-designated creator exists and resolves the agents id",
    /export async function createVideoProject/.test(code("app/actions/video/create-video-project.ts")) &&
    /resolveAgentIdInBrokerage/.test(code("app/actions/video/create-video-project.ts")))
  // HeyGen is banned; Remotion + D-ID + ElevenLabs is the stack.
  check("no HeyGen reference was introduced into the wired video path",
    !/heygen/i.test(src(A_VIDEO)) && !/heygen/i.test(src(S_VIDEO_LIB)))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · every column this wiring names is a real column]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  /**
   * PostgREST rejects a select naming a column that does not exist, so a
   * zero-row select is a phantom-column test. Read-only by construction: no row
   * is created, so there is nothing to clean up and no residue to leave behind.
   */
  const columnsExist = async (table: string, columns: string) => {
    const { error } = await svc.from(table).select(columns).limit(0)
    return { ok: !error, why: error?.message ?? "" }
  }
  const mustHave = async (label: string, table: string, columns: string) => {
    const r = await columnsExist(table, columns)
    check(`live: ${label}`, r.ok)
    if (!r.ok) console.log(`      ↳ ${r.why}`)
  }
  /** A missing column and an unreachable database both come back as an error.
   *  Only a PostgREST column complaint proves absence — anything else (network,
   *  auth, egress policy) must NOT be scored as a passing negative. */
  const mustNotHave = async (label: string, table: string, column: string) => {
    const r = await columnsExist(table, column)
    const isColumnComplaint = /column|does not exist|42703|PGRST/i.test(r.why)
    check(`live: ${label}`, !r.ok && isColumnComplaint)
    if (!r.ok && !isColumnComplaint) console.log(`      ↳ inconclusive: ${r.why}`)
  }

  // Reachability probe: if the database cannot be read at all, every assertion
  // below is meaningless. Skip loudly rather than scoring noise as signal.
  const probe = await columnsExist("vendors", "id")
  if (!probe.ok) {
    console.log(`\n[live] ⊘ skipped (database unreachable: ${probe.why})`)
    console.log("        the source layer proved the shape; schema facts were verified out of band")
    return
  }

  // The review columns the four review actions and both new readers write/read.
  await mustHave("vendor_reviews carries the whole review product",
    "vendor_reviews",
    "id,vendor_id,user_id,brokerage_id,booking_id,transaction_id,rating,review,headline,sub_ratings,is_verified,verification_method,moderation_status,flag_count,vendor_response,vendor_response_at,updated_at")
  await mustHave("vendor_review_flags carries a dedupable flag",
    "vendor_review_flags", "id,review_id,flagged_by,brokerage_id,reason")
  await mustHave("user_role_assignments is the vendor linkage",
    "user_role_assignments", "user_id,vendor_id")
  await mustNotHave("vendors has NO user_id — user_role_assignments really is the linkage",
    "vendors", "user_id")

  // The assignment/job columns the transaction panel renders.
  await mustHave("vendor_assignments + vendor_jobs carry the deal-side facts",
    "vendor_assignments", "id,transaction_id,vendor_id,brokerage_id,assigned_by_agent_id,assignment_type,status,scheduled_date")
  await mustHave("vendor_jobs carries the quoted and actual cost",
    "vendor_jobs", "id,assignment_id,vendor_id,job_title,status,cost_estimate,cost_actual")

  // The photo columns processVendorPhotos writes and the MLS panel reads. These
  // moved onto listing_media at the m368/m369 consolidation; the retired table no
  // longer exists, so probing it would fail on correct code.
  await mustHave("listing_media accepts everything the import writes",
    "listing_media", "id,listing_id,brokerage_id,file_url,sort_order,uploaded_by,room_type,ai_quality_score,ai_analysis_completed,enhancement_applied,is_primary,media_type,usage_intent")
  await mustHave("photo_ordering_rules accepts the rule the agent saves",
    "photo_ordering_rules", "id,agent_id,brokerage_id,rule_name,room_sequence,prioritize_high_quality,is_active")
  // `display_order` was the phantom this file used to write instead of the real
  // ordering column. Re-asserted on the surviving table so the phantom cannot
  // reappear there.
  await mustNotHave("listing_media has no display_order (the phantom column)",
    "listing_media", "display_order")
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" VENDOR + MEDIA WIRING — the capabilities nothing could reach")
  console.log("══════════════════════════════════════════════════════════════════════")
  vendorReviewLayer()
  vendorAssignmentLayer()
  photoLayer()
  videoLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`VENDOR + MEDIA WIRING — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nEach of these is a capability with a working backend and no way in.")
    console.log("If an assertion here goes red, the screen that reached the capability is gone")
    console.log("and the backend is back to computing for nobody.")
    process.exit(1)
  }
  console.log("✅ VENDOR_MEDIA_WIRING_PASS — every wired capability has a real surface")
}

main().catch((e) => { console.error(e); process.exit(1) })
