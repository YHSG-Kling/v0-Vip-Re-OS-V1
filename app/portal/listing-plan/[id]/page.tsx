/**
 * app/portal/listing-plan/[id]
 *
 * THE SELLER-FACING PRE-LISTING LANDING PAGE — the missing half of the drip.
 *
 * WHY THIS FILE EXISTS (orphan doctrine §1.2 — BUILD, no duplicate exists):
 * lib/listing-presentation/prelisting-delivery.ts builds
 * `${NEXT_PUBLIC_APP_URL}/portal/listing-plan/${presentationId}` in TWO places
 * (the gate-2 release proposal's reviewed email, and the announcement email
 * actually sent on release). Next.js resolved neither: app/portal had no
 * `listing-plan` child, so every seller who clicked "Open your listing plan"
 * landed on a 404. The link had a writer and no reader.
 *
 * Neither existing viewer could serve it, so nothing was merged onto:
 *   · app/dashboard/listings/presentations/[id]/page.tsx is the AGENT viewer —
 *     it redirects to /login and renders net_sheet + cma_low/mid/high_value.
 *   · app/portal/[contactId]/listing/page.tsx is the POST-listing seller
 *     dashboard and redirects away when there is no live listing. A pre-listing
 *     prospect has no listing at all.
 *
 * ── ACCESS MODEL ────────────────────────────────────────────────────────────
 * The recipient is a PROSPECT who has not hired the agent yet and generally has
 * no portal login, so this page cannot require a session. It follows the tree's
 * existing unauthenticated, id-addressed pattern (app/buyer-intake/[token],
 * app/showings/feedback/[token]): a server component that resolves the id with
 * the service client and refuses inline when the lookup does not satisfy every
 * gate. The `id` is the presentation UUID the two call sites already mail out;
 * it is treated as an UNTRUSTED BEARER CAPABILITY — shape-validated before it
 * reaches Postgres, never used to widen what is shown, and never trusted to
 * decide WHAT a seller may see (that is decided by the gates + the allowlist
 * below, not by whoever holds the link).
 *
 * ── RELEASE GATE (§4 fail closed) ───────────────────────────────────────────
 * The REAL release signal is listing_presentations.delivery_approved_at, stamped
 * by the single human gate 2 (prelisting-delivery.ts header; deliverDueSections
 * filters on the same column). Until it is stamped "the seller sees nothing".
 * This page holds the same line: an unreleased, missing, errored or abandoned
 * presentation renders NO seller content — a neutral panel, never a partial deck.
 * Every refusal path is neutral on purpose: the panel does not distinguish
 * "no such presentation" from "not released yet", so a guessed id is not an
 * existence oracle.
 *
 * ── WHAT A SELLER MAY SEE, AND WHAT WAS DELIBERATELY EXCLUDED (§5) ──────────
 * The seller sees ONLY the released presentation_sections — the same artifacts
 * the human reviewed at gate 2 — plus the property address and the appointment
 * time, both of which are the seller's own facts.
 *
 * EXCLUDED, and NOT EVEN SELECTED from the row (a column never fetched cannot
 * leak through a stray render):
 *   · net_sheet          — the seller's proceeds math incl. commission. §5:
 *                          "Contacts, lenders and vendors see no financials" and
 *                          "Commission is off agent-facing display" — a fortiori
 *                          off a seller prospect's display.
 *   · cma_low_value / cma_mid_value / cma_high_value / cma_confidence — the
 *     VALUATION OF THE SELLER'S OWN HOME. lib/cma/customer-facing-guard.ts is
 *     already the standing law here ("a SUGGESTED LIST PRICE ... is NEVER shown
 *     to the customer on a CMA / pre-listing presentation"), and its leak regex
 *     names cma_(mid|low|high)_value explicitly. The whole drip is built around
 *     deferring the number: SECTION_SEQUENCE's cma section carries
 *     market_only:true and "Your home's value will be presented at our meeting",
 *     and composePrelistingEmail carries no price at all. Showing the range here
 *     would be a SECOND, laxer vocabulary for the same rule (§6) and would break
 *     the in-person reveal the product is designed around.
 *   · cma_narrative      — not read directly. section-drip.ts already merges it
 *     into the cma section's body as `market_narrative` AFTER scrubbing, so the
 *     scrubbed copy is the one vocabulary (§6). Reading the raw column would be
 *     a second, unscrubbed path to the same text.
 *   · slide_deck / marketing_plan / property_data / packet_document_id /
 *     presentation — internal agent artifacts that never passed the gate-2
 *     seller-safety review that the SECTIONS did. Excluded as unresolved rather
 *     than guessed: they may well contain seller-safe material, but nothing in
 *     the pipeline scrubs them, so per the brief's instruction they are excluded
 *     and the question is recorded here.
 *   · delivery_approved_by / agent_id / appointment_id / notification_sent_at —
 *     internal operational metadata.
 *
 * Defense in depth: every section body is re-run through findSuggestedPriceLeaks
 * (the canonical guard, not a private copy) at render time; a body that leaks is
 * dropped rather than rendered.
 *
 * ── THE VIDEO LANDING PAGE (the owner's open question) ──────────────────────
 * Yes — this route IS the segmented pre-listing video landing page. A section's
 * video is addressed as presentation_sections.render_id →
 * remotion_composition_renders(id, render_status, output_url, thumbnail_url);
 * section-render.ts writes that FK for every section (CMAReel for the cma
 * section, ListingSectionReel for the rest) and section-narration-orchestrator
 * lays the agent's cloned voice/avatar over it. Which of those renders may be
 * SHOWN is decided by evaluateRenderReadiness() from prelisting-delivery.ts —
 * the same function the human's release proposal used to pick the videos they
 * reviewed — so the seller can never be shown a render the reviewer did not see.
 * A section whose render is queued/failed degrades to its on-screen bullets
 * (remotion_composition_renders.input_props.bullets), which section-narration.ts
 * generates seller-safe and price-free.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { evaluateRenderReadiness, type SectionRenderRow } from "@/lib/listing-presentation/prelisting-delivery"
import { findSuggestedPriceLeaks } from "@/lib/cma/customer-facing-guard"
import ListingPlanSegments, { type PlanSegment } from "./listing-plan-segments"

export const dynamic = "force-dynamic"

/** presentation_sections.status CHECK: pending | scheduled | delivered | viewed | failed.
 *  Only a section a human RELEASED and the drip actually DELIVERED is visible;
 *  'scheduled' has not dripped yet and showing it would run ahead of the drip. */
const VISIBLE_SECTION_STATUS = ["delivered", "viewed"] as const
/** presentation_sections.channel CHECK: email | portal | both. An email-only
 *  section is not a portal section. */
const PORTAL_CHANNELS = ["portal", "both"] as const
/** listing_presentations.presentation_type — the buyer branch has its own home
 *  at /portal/[contactId]/journey; this surface is seller-only. */
const NOT_A_SELLER_PLAN = "buyer_consultation"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PageProps {
  params: Promise<{ id: string }>
}

function Unavailable({ note }: { note: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="max-w-sm text-center">
        <h1 className="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
          This listing plan isn&apos;t available
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{note}</p>
      </div>
    </div>
  )
}

const HOLD_COPY = "Your agent is still putting it together. You'll get an email the moment it's ready."

export default async function ListingPlanPage({ params }: PageProps) {
  const { id } = await params

  // The id is visitor-supplied. Shape-check it before it reaches Postgres so a
  // malformed value is a refusal here, not a 22P02 from the driver.
  if (!UUID_RE.test(id)) return <Unavailable note={HOLD_COPY} />

  const supabase = createServiceClient()

  // §3: supabase-js RESOLVES refusals — destructure and READ the error.
  const { data: pres, error: presError } = await supabase
    .from("listing_presentations")
    .select("id, brokerage_id, contact_id, agent_user_id, property_address, state, appointment_at, presentation_type, status, delivery_approved_at")
    .eq("id", id)
    .maybeSingle()

  // FAIL CLOSED: a read we could not complete must refuse, not render.
  if (presError) {
    console.error("[listing-plan] presentation read refused", presError.message)
    return <Unavailable note={HOLD_COPY} />
  }
  if (!pres) return <Unavailable note={HOLD_COPY} />

  // GATE 2 — nothing reaches the seller until a human stamped the release.
  if (!pres.delivery_approved_at) return <Unavailable note={HOLD_COPY} />
  if (pres.presentation_type === NOT_A_SELLER_PLAN) return <Unavailable note={HOLD_COPY} />
  if (pres.status === "abandoned") return <Unavailable note={HOLD_COPY} />

  const { data: sectionRows, error: sectionsError } = await supabase
    .from("presentation_sections")
    .select("id, section_key, section_order, title, body, status, channel, render_id")
    .eq("presentation_id", id)
    .in("status", VISIBLE_SECTION_STATUS as unknown as string[])
    .in("channel", PORTAL_CHANNELS as unknown as string[])
    .order("section_order", { ascending: true })

  if (sectionsError) {
    console.error("[listing-plan] section read refused", sectionsError.message)
    return <Unavailable note={HOLD_COPY} />
  }

  type SectionRow = {
    id: string
    section_key: string
    section_order: number | null
    title: string | null
    body: Record<string, unknown> | null
    status: string | null
    channel: string | null
    render_id: string | null
  }
  const sections = (sectionRows ?? []) as SectionRow[]
  if (sections.length === 0) return <Unavailable note={HOLD_COPY} />

  // Resolve each section's video segment. render_id → remotion_composition_renders.
  const renderIds = sections.map((s) => s.render_id).filter((x): x is string => !!x)
  const renderById = new Map<string, { render_status: string | null; output_url: string | null; thumbnail_url: string | null; input_props: Record<string, unknown> | null }>()
  if (renderIds.length > 0) {
    const { data: renders, error: rendersError } = await supabase
      .from("remotion_composition_renders")
      .select("id, render_status, output_url, thumbnail_url, input_props")
      .in("id", renderIds)
    if (rendersError) {
      // Non-fatal: the plan still reads as text. Never silently swallow it.
      console.error("[listing-plan] render read refused", rendersError.message)
    }
    for (const r of (renders ?? []) as Array<{ id: string; render_status: string | null; output_url: string | null; thumbnail_url: string | null; input_props: Record<string, unknown> | null }>) {
      renderById.set(r.id, { render_status: r.render_status, output_url: r.output_url, thumbnail_url: r.thumbnail_url, input_props: r.input_props })
    }
  }

  // ONE vocabulary for "which renders may be shown" (§6): the same evaluator the
  // human's release proposal used to choose the videos they reviewed.
  const readinessRows: SectionRenderRow[] = sections.map((s) => {
    const r = s.render_id ? renderById.get(s.render_id) : undefined
    return {
      section_key:   s.section_key,
      title:         s.title,
      render_status: r?.render_status ?? null,
      output_url:    r?.output_url ?? null,
      thumbnail_url: r?.thumbnail_url ?? null,
    }
  })
  const readiness = evaluateRenderReadiness(readinessRows)
  const videoBySection = new Map(readiness.videos.map((v) => [v.section_key, v]))

  let leakedBodies = 0
  const segments: PlanSegment[] = sections.map((s) => {
    // Defense in depth — the canonical customer-facing guard, applied again at
    // the last chokepoint. A body that leaks a subject valuation is dropped.
    const leaks = s.body ? findSuggestedPriceLeaks(s.body) : []
    if (leaks.length > 0) {
      leakedBodies++
      console.error(`[listing-plan] section ${s.section_key} body withheld — price leak at ${leaks.join(", ")}`)
    }
    const body = leaks.length === 0 ? (s.body ?? {}) : {}
    const render = s.render_id ? renderById.get(s.render_id) : undefined
    const rawBullets = (render?.input_props as { bullets?: unknown } | null | undefined)?.bullets
    const bullets = Array.isArray(rawBullets)
      ? rawBullets.filter((b): b is string => typeof b === "string").slice(0, 6)
      : []
    const video = videoBySection.get(s.section_key)
    return {
      key:       s.section_key,
      title:     s.title ?? s.section_key,
      note:      typeof body.note === "string" ? body.note : null,
      narrative: typeof body.market_narrative === "string" ? body.market_narrative : null,
      bullets,
      videoUrl:     video?.output_url ?? null,
      thumbnailUrl: video?.thumbnail_url ?? null,
    }
  })

  // Resolve the agent + brokerage for the header (public identity, not financials).
  let agentName: string | null = null
  if (pres.agent_user_id) {
    const { data: u, error: uErr } = await supabase
      .from("users").select("first_name, last_name").eq("id", pres.agent_user_id).maybeSingle()
    if (uErr) console.error("[listing-plan] agent read refused", uErr.message)
    const uu = u as { first_name?: string | null; last_name?: string | null } | null
    agentName = [uu?.first_name, uu?.last_name].filter(Boolean).join(" ").trim() || null
  }
  let brokerageName: string | null = null
  if (pres.brokerage_id) {
    const { data: b, error: bErr } = await supabase
      .from("brokerages").select("name").eq("id", pres.brokerage_id).maybeSingle()
    if (bErr) console.error("[listing-plan] brokerage read refused", bErr.message)
    brokerageName = (b as { name?: string | null } | null)?.name ?? null
  }

  // The seller opening this page IS the read receipt — presentation_sections
  // carries `viewed_at` and a 'viewed' status in its CHECK with no writer
  // anywhere in the tree until now (§1.2: build the missing half). Monotone and
  // idempotent: guarded on status='delivered' so it never regresses a row and an
  // overlapping visit is a no-op. §3: a matching-nothing UPDATE also resolves, so
  // .select() the rows back and read the error rather than assuming.
  const deliveredIds = sections.filter((s) => s.status === "delivered").map((s) => s.id)
  if (deliveredIds.length > 0) {
    const { data: seen, error: seenErr } = await supabase
      .from("presentation_sections")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .in("id", deliveredIds)
      .eq("status", "delivered")
      .select("id")
    if (seenErr) console.error("[listing-plan] view receipt refused", seenErr.message)
    else if ((seen ?? []).length === 0) console.warn("[listing-plan] view receipt matched 0 rows", { presentationId: id })
  }

  const apptLabel = pres.appointment_at
    ? new Date(pres.appointment_at as string).toLocaleString("en-US", {
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : null

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 px-4 py-12 dark:from-slate-950 dark:to-slate-900">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-500">
            Your listing plan
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {pres.property_address ?? "Your home"}
          </h1>
          {(agentName || brokerageName) && (
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Prepared by {[agentName, brokerageName].filter(Boolean).join(" · ")}
            </p>
          )}
          {apptLabel && (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-500">
              We meet {apptLabel}
            </p>
          )}
        </header>

        <ListingPlanSegments segments={segments} />

        <footer className="mt-10 text-center text-xs text-slate-500 dark:text-slate-500">
          <p>
            Your home&apos;s specific numbers are walked through in person at our meeting.
          </p>
          {leakedBodies > 0 && (
            <p className="mt-1">Part of this plan is still being finalized by your agent.</p>
          )}
        </footer>
      </div>
    </div>
  )
}
