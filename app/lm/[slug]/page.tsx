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
      "id, name, slug, fields, is_active, brokerage_id, agent_id, tcpa_disclosure_text, thank_you_message, redirect_url"
    )
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle()

  if (error || !data) return null
  return data
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

  return (
    <main className="min-h-screen bg-background flex items-start justify-center py-10 px-4">
      <div className="w-full max-w-lg">
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

        {/* Footer attribution */}
        <p className="text-center text-xs text-muted-foreground mt-6">
          Powered by Kernel OS
        </p>
      </div>
    </main>
  )
}
