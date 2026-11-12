#!/usr/bin/env tsx
/**
 * scripts/visitor-identify-loop-simulator.ts  (npm run test:visitor-identify-loop)
 *
 * THE IDENTIFIED TILE COULD ONLY EVER SHOW ZERO.
 *
 * `website_visitors.identified_at` had exactly ONE writer in the whole tree —
 * `app/api/track/identify/route.ts` — and that route had ZERO callers. Not a
 * fetch, not a template literal, not a cron registry line, not a config entry,
 * and no database caller either (checked live on `hrvaqgvukzxfskkcrwbt`: zero
 * edge functions, and no pg_proc body anywhere naming an `/api/` path).
 *
 * The READER, meanwhile, was already shipped and prominent.
 * `app/dashboard/admin/visitor-tracking/page.tsx` renders `identified_at` three
 * times — the Identified stat tile, the per-row Identified/Anonymous badge and
 * the Identified-at column — underneath page copy promising that
 * "identification only occurs when a visitor is matched to an existing lead or
 * contact". So the promise was real, the endpoint that keeps it was real, and
 * nothing connected them: every brokerage saw Identified = 0 forever, and the
 * surface said nothing about why.
 *
 * No duplicate identifier exists anywhere in the tree, so CLAUDE.md §1's answer
 * is the second one — BUILD the missing half, do not delete the endpoint. The
 * caller now lives in the installer snippet that already carries the session id.
 *
 * WHAT THIS PROOF HOLDS, and why each half can rot without it:
 *
 *   · THE WIRE ITSELF. Only the pasted snippet can ever call this endpoint, so
 *     the wire is a STRING inside a template literal in a page component. A
 *     scanner that blanks strings would see nothing here at all — this file
 *     therefore strips COMMENTS and never strings, and a control below proves
 *     that distinction is live rather than assumed.
 *
 *   · THE PREFLIGHT SHAPE. The call is cross-origin from the installer's own
 *     domain. `sendBeacon` with a text/plain Blob and `fetch` with mode
 *     'no-cors' and a bare string body are both CORS "simple requests" and need
 *     no OPTIONS handler. The moment somebody "tidies" that into a normal JSON
 *     fetch with a Content-Type header, the browser preflights, the endpoint has
 *     no OPTIONS handler, and the loop goes silently dead again — looking
 *     perfectly correct in review. That is precisely how it got here.
 *
 *   · THE TENANT. This is an UNAUTHENTICATED endpoint on the service client. It
 *     used to take `brokerageId` as a request FIELD, which is the IDOR shape
 *     CLAUDE.md §4 names. `session_id` is UNIQUE on website_visitors
 *     (`uq_website_visitors_session`, read live), so the session row itself is
 *     the only tenant authority this call may use.
 *
 *   · THE FILTER GRAMMAR. The matcher used to build `.or()` grammar by string
 *     concatenation from that same unauthenticated body — `email.eq.${email}` —
 *     so a comma in the value rewrote the filter list against contacts and
 *     leads, on a service client.
 *
 * NEGATIVE CONTROLS: removing the identify call from the snippet, giving that
 * call a JSON Content-Type, restoring a body-supplied brokerageId, restoring a
 * concatenated `.or()` filter, or dropping the `.select()` off the stamping
 * UPDATE each turns an assertion red.
 *
 * No database at runtime. Source assertions + the generated schema snapshot.
 */
import { existsSync, readFileSync } from "node:fs"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { stripComments } from "./strip-comments"

let pass = 0
let fail = 0
const failures: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) {
    pass++
    console.log(`  ✓ ${n}`)
  } else {
    fail++
    failures.push(n)
    console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`)
  }
}

const ROUTE = "app/api/track/identify/route.ts"
const PIXEL = "app/api/track/pixel/route.ts"
const SURFACE = "app/dashboard/admin/visitor-tracking/page.tsx"

/** Comments stripped, strings KEPT — the wire lives inside a template literal. */
function code(file: string): string {
  return existsSync(file) ? stripComments(readFileSync(file, "utf8")) : ""
}

// ── The detectors, named once so the controls can exercise the same code ──────

/** A call site for the identify endpoint, in any quoting. */
const addressesIdentify = (src: string) => src.includes("/api/track/identify")

/** A write of identified_at, as an object key in an insert/update payload. */
const stampsIdentifiedAt = (src: string) => /identified_at\s*:/.test(src)

/** PostgREST filter grammar assembled from an interpolated value. */
const buildsOrFilter = (src: string) => /\.or\(/.test(src) || /\$\{[^}]*\}`\s*\)/.test(src)

/** A JSON Content-Type on the identify call — the thing that forces a preflight. */
const forcesPreflight = (src: string) => /application\/json/i.test(src)

function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" VISITOR IDENTIFY LOOP — the writer, the wire and the tile agree")
  console.log("══════════════════════════════════════════════════════════════════════\n")

  // ── POSITIVE CONTROLS ──────────────────────────────────────────────────────
  // A broken detector and a clean tree both report zero. Each finder below is
  // shown recognising the exact defect it was written for, and refusing the
  // shape it must not accuse.
  console.log("── positive controls (the finders still see what they look for) ──")
  check(
    "CONTROL wire-finder SEES an identify call inside a template literal",
    addressesIdentify("const s = `<script>fetch(o+'/api/track/identify')</script>`"),
  )
  check(
    "CONTROL wire-finder does NOT see a call in a COMMENT (a tombstone is not a call site)",
    !addressesIdentify(stripComments("// see app/api/track/identify/route.ts\nconst x = 1")),
  )
  check(
    "CONTROL stamp-finder SEES an identified_at write",
    stampsIdentifiedAt("const p = { identified_at: now }"),
  )
  check(
    "CONTROL stamp-finder does NOT see a mere READ of the column",
    !stampsIdentifiedAt(".is('identified_at', null)"),
  )
  check(
    "CONTROL or-filter finder SEES the concatenated grammar it exists to refuse",
    buildsOrFilter("filters.push(`email.eq.${email}`); q.or(filters.join(','))"),
  )
  check(
    "CONTROL or-filter finder does NOT accuse a plain .eq() predicate",
    !buildsOrFilter("q.eq('email', email).eq('brokerage_id', brokerageId)"),
  )
  check(
    "CONTROL preflight-finder SEES a JSON content type",
    forcesPreflight("headers:{'Content-Type':'application/json'}"),
  )

  // ── 1. Both halves of the loop exist ───────────────────────────────────────
  console.log("\n── the loop ──")
  const route = code(ROUTE)
  const surface = code(SURFACE)

  check(`${ROUTE} exists and exports POST`, /export\s+async\s+function\s+POST/.test(route), ROUTE)
  check(`${SURFACE} exists`, surface.length > 0, SURFACE)

  check(
    "THE WIRE: the installer snippet addresses /api/track/identify —\n    this endpoint has no other possible caller, so this assertion IS the loop",
    addressesIdentify(surface),
  )

  check(
    "the snippet reaches it by BEACON (sendBeacon) with a no-cors fetch fallback —\n    both are CORS simple requests, so no OPTIONS handler is owed",
    /sendBeacon/.test(surface) && /no-cors/.test(surface),
  )

  check(
    "the snippet sets NO JSON Content-Type — that header alone would preflight the\n    call, get no OPTIONS answer, and silently kill the loop again",
    !forcesPreflight(surface),
  )

  check(
    "the snippet sends the SESSION id, which is what ties the call to a visitor row",
    /sessionId\s*:/.test(surface),
  )

  // ── 2. The reader is still there ───────────────────────────────────────────
  console.log("\n── the reader the wire exists to make true ──")
  const reads = (surface.match(/identified_at/g) ?? []).length
  check(
    "the Identified surface still reads identified_at (tile, badge, column)",
    reads >= 3,
    `${reads} reading(s)`,
  )

  // ── 3. One writer, and it is the route ─────────────────────────────────────
  console.log("\n── one writer ──")
  check("the identify route is the thing that stamps identified_at", stampsIdentifiedAt(route))
  check(
    "the pixel route only READS identified_at (it must never stamp it)",
    !stampsIdentifiedAt(code(PIXEL)),
  )

  // ── 4. The tenant comes from the row, never the body (§4) ──────────────────
  console.log("\n── tenancy ──")
  check(
    "brokerageId is NOT taken from the request body — an unauthenticated service-client\n    endpoint that trusts a body-supplied tenant is the IDOR shape §4 names",
    !/body\??\.\s*brokerageId/.test(route) && !/brokerageId\s*[,}]/.test(route.split("const supabase")[0] ?? ""),
  )
  check(
    "the tenant is READ OFF the visitor row the unique session_id resolves",
    /\.eq\(\s*['"]session_id['"]/.test(route) && /visitor\.brokerage_id/.test(route),
  )

  // ── 5. No filter grammar built from an untrusted value ─────────────────────
  console.log("\n── filter grammar ──")
  check(
    "the matcher uses plain .eq() predicates, not concatenated .or() grammar",
    !buildsOrFilter(route),
  )

  // ── 6. The write is counted, not assumed (§3) ──────────────────────────────
  console.log("\n── the write is read back ──")
  check(
    "the stamping UPDATE destructures its error",
    /const\s*\{\s*data:[^}]*error:\s*updateError\s*\}/.test(route),
  )
  check(
    "the stamping UPDATE is .select()ed and ZERO ROWS is treated as a failure —\n    an UPDATE matching nothing resolves identically to one that worked",
    /\.select\(/.test(route) && /length\s*===\s*0/.test(route),
  )

  // ── 7. Every column named exists (PGRST204) ────────────────────────────────
  console.log("\n── the columns the write names ──")
  const live = new Set(SCHEMA_SNAPSHOT.website_visitors ?? [])
  const named = ["identified_at", "contact_id", "lead_id", "brokerage_id", "session_id"]
  const absent = named.filter((c) => !live.has(c))
  check(
    "every column this loop names exists on website_visitors —\n    an absent one refuses the whole UPDATE (PGRST204), not just that field",
    absent.length === 0,
    absent.join(", "),
  )

  // ── 8. THE EDGE GATE LETS THE ANONYMOUS VISITOR THROUGH ────────────────────
  //
  // The single most expensive thing found on this loop, because it is invisible
  // from both ends. `/api/track` sat in PROTECTED_ROUTES, so proxy.ts redirected
  // every anonymous hit to /login — an <img> that quietly never loads and a
  // beacon that is quietly discarded. A previous wave had already fixed the
  // snippet's URL (relative → absolute) and the loop still recorded nothing,
  // because the absolute URL landed on this gate instead.
  console.log("\n── the edge gate ──")
  const authConstants = code("app/constants/auth.ts")
  const publicList = authConstants.split("export const PROTECTED_ROUTES")[0] ?? ""
  const protectedList = authConstants.split("export const PROTECTED_ROUTES")[1] ?? ""
  check(
    "/api/track is PUBLIC — the visitor firing it is a stranger on someone else's\n    website and can never carry a session",
    /['"]\/api\/track['"]/.test(publicList),
  )
  check(
    "/api/track is NOT also in PROTECTED_ROUTES — proxy.ts:158 prefix-matches, so one\n    entry there redirects every anonymous hit to /login and the loop dies silently",
    !/['"]\/api\/track['"]/.test(protectedList),
  )
  check(
    "CONTROL the gate finder SEES a protected prefix (it is not matching nothing)",
    /['"]\/api\/admin['"]/.test(protectedList),
  )

  // ── 9. The lifecycle event is a real member ────────────────────────────────
  const events = code("lib/kernel/events.ts")
  check(
    "KernelEvent.WEBSITE_VISITOR_IDENTIFIED is a declared member",
    /WEBSITE_VISITOR_IDENTIFIED\s*=/.test(events),
  )

  console.log(`\n${"═".repeat(70)}`)
  console.log(`VISITOR IDENTIFY LOOP — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("The snippet identifies, the route stamps, and the Identified tile can move.")
}

main()
