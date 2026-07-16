import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { HomeValueForm } from "@/app/components/lead-magnet-forms/HomeValueForm"
import { GenericCaptureForm } from "@/app/components/lead-magnet-forms/GenericCaptureForm"
import type { Metadata } from "next"

interface PageProps {
  params: Promise<{ slug: string }>
}

// ── Server-side: fetch form by slug ──────────────────────────────────────────
async function getFormBySlug(slug: string) {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from("lead_capture_forms")
    .select(
      "id, name, slug, fields, is_active, brokerage_id, agent_id, tcpa_disclosure_text, thank_you_message, redirect_url, landing_content"
    )
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle()

  if (error || !data) return null
  return data
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
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const form = await getFormBySlug(slug)
  if (!form) return { title: "Not Found" }
  const landing = landingOf(form)
  // A page with AI-built copy + a GEO FAQ is meant to be FOUND and cited by AI search — index it.
  // A bare capture form stays noindex (nothing to surface, avoids thin-content pages).
  if (landing) {
    return {
      title: landing.headline || form.name,
      description: (landing.subhead || `Get started — ${form.name}`).slice(0, 300),
      robots: { index: true, follow: true },
    }
  }
  return {
    title: form.name,
    description: `Fill out this form to get started — ${form.name}`,
    robots: { index: false, follow: false },
  }
}

// ── Page component ────────────────────────────────────────────────────────────
export default async function LeadMagnetLandingPage({ params }: PageProps) {
  const { slug } = await params
  const form = await getFormBySlug(slug)

  if (!form) {
    notFound()
  }

  const fields = (form.fields as any[]) ?? []
  const magnetType = detectMagnetType(fields)
  const landing = landingOf(form)

  return (
    <main className="min-h-screen bg-background flex items-start justify-center py-10 px-4">
      {/* GEO / AI-visibility: schema.org FAQPage so AI search can CITE this page, not just index it. */}
      {landing?.faqJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: landing.faqJsonLd }} />
      )}
      <div className="w-full max-w-lg">
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
            />
          ) : (
            <GenericCaptureForm
              formId={form.id}
              brokerageId={form.brokerage_id}
              fields={fields}
              source="landing_page"
              headline={form.name}
              tcpaText={form.tcpa_disclosure_text ?? undefined}
              thankYouMessage={form.thank_you_message ?? undefined}
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
