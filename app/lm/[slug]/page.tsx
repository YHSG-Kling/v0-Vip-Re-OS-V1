import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { HomeValueForm } from "@/app/components/lead-magnet-forms/HomeValueForm"
import { GenericCaptureForm } from "@/app/components/lead-magnet-forms/GenericCaptureForm"
import { parseLeadMagnetAttribution } from "@/lib/lead-magnets/attribution"
import type { Metadata } from "next"

type SearchParams = Record<string, string | string[] | undefined>

interface PageProps {
  params: Promise<{ slug: string }>
  searchParams?: Promise<SearchParams>
}

// ── Server-side: fetch form by slug ──────────────────────────────────────────
// Wave 141 (lane 141E): the row is read by slug alone and the ACTIVE rule is applied in code — the
// public page serves active forms only (as before); a tenant member previewing a DRAFT (?preview=1,
// proven below to belong to their own brokerage) sees the inactive row. Submissions on an inactive
// form are refused by the kernel regardless (captureFormSubmission checks is_active) — the preview
// shows the page, never captures through it.
async function getFormBySlug(slug: string, opts: { includeInactive?: boolean } = {}) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("lead_capture_forms")
    .select(
      "id, name, slug, fields, is_active, brokerage_id, agent_id, tcpa_disclosure_text, thank_you_message, redirect_url, landing_content"
    )
    .eq("slug", slug)
    .maybeSingle()

  if (error || !data) return null
  if (!data.is_active && !opts.includeInactive) return null
  return data
}

/** A draft is previewable ONLY by a member of the brokerage that owns it — the session's tenant, never a
 *  query parameter (CLAUDE.md §4). Anyone else gets the public answer: not found. */
async function viewerMayPreview(formBrokerageId: string): Promise<boolean> {
  try {
    const { getAgentContext } = await import("@/lib/identity/get-agent-context")
    const ctx = await getAgentContext()
    return !!ctx.brokerageId && ctx.brokerageId === formBrokerageId
  } catch {
    return false
  }
}

type LandingContent = import("@/lib/marketing/lead-magnet-copy").LandingContent

/** Narrow the persisted jsonb to the LandingContent we render (defensive — old rows have none). */
function landingOf(form: { landing_content?: unknown }): LandingContent | null {
  const lc = form.landing_content as Partial<LandingContent> | null | undefined
  if (!lc || typeof lc !== "object" || !lc.headline) return null
  return {
    headline:   String(lc.headline),
    subhead:    String(lc.subhead ?? ""),
    cta:        String(lc.cta ?? ""),
    bullets:    Array.isArray(lc.bullets) ? lc.bullets.map(String) : [],
    topics:     Array.isArray(lc.topics) ? lc.topics.map(String) : [],
    faq:        Array.isArray(lc.faq) ? lc.faq.filter((f): f is { question: string; answer: string } => !!f && typeof f === "object" && "question" in f && "answer" in f) : [],
    faqJsonLd:  lc.faqJsonLd ? String(lc.faqJsonLd) : null,
    fromTopics: !!lc.fromTopics,
    generatedAt: String(lc.generatedAt ?? ""),
    videoUrl:   typeof lc.videoUrl === "string" ? lc.videoUrl : null,
  }
}

// ── Detect magnet type from fields ───────────────────────────────────────────
function detectMagnetType(
  fields: Array<{ name: string; label: string; type: string; required: boolean }>
): "home_valuation" | "generic" {
  const names = fields.map((f) => f.name)
  if (names.includes("property_address")) return "home_valuation"
  return "generic"
}

// ── Metadata ──────────────────────────────────────────────────────────────────

/**
 * The newest COMPLETED LeadMagnetCard render for this form — read at render
 * time (no schema change): the producer (lib/kernel/lead-magnets.ts
 * enqueueLeadMagnetCard, fired from publishLeadMagnet) queues the 1200×630
 * still keyed on the magnet's identity; this reader picks up whichever finished
 * last. {error} is READ — a refused read returns null and the openGraph block
 * is simply omitted (never a placeholder image).
 */
async function getLeadMagnetCardUrl(formId: string, brokerageId: string): Promise<string | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("remotion_composition_renders")
    .select("output_url")
    .eq("brokerage_id", brokerageId)
    .eq("entity_type", "lead_capture_form")
    .eq("entity_id", formId)
    .eq("composition_id", "LeadMagnetCard")
    .eq("render_status", "succeeded")
    .not("output_url", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return (data as { output_url?: string | null } | null)?.output_url ?? null
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const form = await getFormBySlug(slug)
  if (!form) return { title: "Not Found", robots: { index: false, follow: false } }
  const landing = landingOf(form)
  // A page with AI-built copy + a GEO FAQ is meant to be FOUND and cited by AI search — index it.
  // A bare capture form stays noindex (nothing to surface, avoids thin-content pages).
  //
  // ONE PREDICATE, TWO ENFORCEMENT POINTS: `landing` (real landing_content) is
  // the same condition that gates the card producer's headline/subhead contract
  // (enqueueLeadMagnetCard refuses without them) — so the no-landing branch
  // below skips the card lookup entirely: nothing can have rendered, and the
  // page is noindex anyway.
  if (landing) {
    const cardUrl = await getLeadMagnetCardUrl(form.id, form.brokerage_id)
    return {
      title: landing.headline || form.name,
      description: (landing.subhead || `Get started — ${form.name}`).slice(0, 300),
      robots: { index: true, follow: true },
      // When no completed card exists, the openGraph block is omitted entirely —
      // no placeholder image is ever claimed.
      ...(cardUrl ? { openGraph: { images: [cardUrl] } } : {}),
    }
  }
  return {
    title: form.name,
    description: `Fill out this form to get started — ${form.name}`,
    robots: { index: false, follow: false },
  }
}

// ── Page component ────────────────────────────────────────────────────────────
export default async function LeadMagnetLandingPage({ params, searchParams }: PageProps) {
  const { slug } = await params
  const sp: SearchParams = (await searchParams) ?? {}
  const wantsPreview = sp.preview === "1"

  // The public read first; the draft read only for a proven tenant member.
  let form = await getFormBySlug(slug)
  let isDraftPreview = false
  if (!form && wantsPreview) {
    const draft = await getFormBySlug(slug, { includeInactive: true })
    if (draft && (await viewerMayPreview(draft.brokerage_id))) {
      form = draft
      isDraftPreview = !draft.is_active
    }
  }

  if (!form) {
    notFound()
  }

  const fields = (form.fields as any[]) ?? []
  const magnetType = detectMagnetType(fields)
  const landing = landingOf(form)
  // ATTRIBUTION (wave 141): the ad / QR / utm parameters the URL carried, sanitized here, posted with the
  // submission, VERIFIED by the kernel against this magnet's own tenant before anything is stamped.
  const attribution = parseLeadMagnetAttribution(sp)

  return (
    <main className="min-h-screen bg-background flex items-start justify-center py-10 px-4">
      {/* GEO / AI-visibility: schema.org FAQPage so AI search can CITE this page, not just index it. */}
      {landing?.faqJsonLd && !isDraftPreview && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: landing.faqJsonLd }} />
      )}
      <div className="w-full max-w-lg">
        {isDraftPreview && (
          <div role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900">
            Draft preview — this page is not public yet and does not accept submissions until you publish it.
          </div>
        )}
        {/* AI-built hero (headline + subhead + value bullets), grounded in real demand topics. */}
        {landing && (
          <header className="mb-6 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">{landing.headline}</h1>
            {landing.subhead && <p className="mt-2 text-muted-foreground">{landing.subhead}</p>}
            {/* Auto-rendered avatar presentation (playbook installs) — the agent
                explains, in their own cloned voice, why the visitor should care. */}
            {landing.videoUrl && (
              <video
                controls
                playsInline
                preload="metadata"
                className="mt-4 w-full rounded-xl border shadow-sm"
                src={landing.videoUrl}
              />
            )}
            {landing.bullets.length > 0 && (
              <ul className="mt-4 space-y-1 text-left text-sm text-muted-foreground inline-block">
                {landing.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2"><span aria-hidden className="text-primary">✓</span>{b}</li>
                ))}
              </ul>
            )}
          </header>
        )}

        {/* Card shell */}
        <div className="bg-card border rounded-2xl shadow-sm p-8">
          {magnetType === "home_valuation" ? (
            <HomeValueForm
              formId={form.id}
              brokerageId={form.brokerage_id}
              source="landing_page"
              tcpaText={form.tcpa_disclosure_text ?? undefined}
              thankYouMessage={form.thank_you_message ?? undefined}
              ctaText={landing?.cta || undefined}
              attribution={attribution}
            />
          ) : (
            <GenericCaptureForm
              formId={form.id}
              brokerageId={form.brokerage_id}
              fields={fields}
              source="landing_page"
              headline={form.name}
              ctaText={landing?.cta || undefined}
              tcpaText={form.tcpa_disclosure_text ?? undefined}
              thankYouMessage={form.thank_you_message ?? undefined}
              attribution={attribution}
            />
          )}
        </div>

        {/* Visible FAQ — reinforces the JSON-LD for AI search + answers the real questions on-page. */}
        {landing && landing.faq.length > 0 && (
          <section className="mt-8" aria-label="Frequently asked questions">
            <h2 className="text-lg font-semibold mb-3">Frequently asked</h2>
            <dl className="space-y-4">
              {landing.faq.map((f, i) => (
                <div key={i} className="border-b pb-3 last:border-0">
                  <dt className="font-medium text-sm">{f.question}</dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{f.answer}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {/* Footer attribution */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          Powered by Kernel OS
        </p>
      </div>
    </main>
  )
}
