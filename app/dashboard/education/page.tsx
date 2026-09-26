import { createClient } from "@/lib/supabase/server"
import { EducationLibrary } from "@/app/components/features/education/EducationLibrary"
import { EducationEditor } from "@/app/components/features/education/EducationEditor"
import { ProgressDashboard } from "@/app/components/features/education/ProgressDashboard"
import { ClientLearningPanel } from "./client-learning-panel"
import { redirect } from "next/navigation"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = "force-dynamic"

export default async function EducationPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user?.id ?? "")
    .maybeSingle()

  if (!profile?.brokerage_id || profile.user_type !== "admin") {
    redirect("/dashboard")
  }

  // Options for the Client Learning panel. Both reads are pinned to the caller's
  // brokerage and both destructure `error` — an RLS refusal must not be rendered
  // as "you have no lessons" / "you have no clients", because those two sentences
  // are what a broker would act on.
  const [modulesRes, contactsRes] = await Promise.all([
    supabase
      .from("learning_modules")
      .select("id, title, status, estimated_minutes")
      .eq("brokerage_id", profile.brokerage_id)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("contacts")
      .select("id, first_name, last_name, email")
      .eq("brokerage_id", profile.brokerage_id)
      .order("created_at", { ascending: false })
      .limit(200),
  ])

  const loadError =
    modulesRes.error?.message ?? contactsRes.error?.message ?? null

  const modules = ((modulesRes.data ?? []) as any[]).map((m) => ({
    id: m.id as string,
    title: (m.title as string) ?? "Untitled lesson",
    status: (m.status as string) ?? "published",
    estimated_minutes: (m.estimated_minutes as number | null) ?? null,
  }))

  const contacts = ((contactsRes.data ?? []) as any[]).map((c) => ({
    id: c.id as string,
    name:
      [c.first_name, c.last_name].filter(Boolean).join(" ").trim() ||
      (c.email as string | null) ||
      "Unnamed contact",
    email: (c.email as string | null) ?? null,
  }))

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold mb-2">Education Management</h1>
        <p className="text-gray-600">Create, manage, and track educational resources for your brokerage</p>
      </div>

      <ProgressDashboard brokerageId={profile.brokerage_id} />

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Could not load your lessons or clients: {loadError}. Client Learning is hidden rather than shown empty.
        </div>
      ) : (
        <ClientLearningPanel modules={modules} contacts={contacts} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <EducationEditor brokerageId={profile.brokerage_id} />
        </div>
        <div>
          <EducationLibrary brokerageId={profile.brokerage_id} />
        </div>
      </div>
    </div>
  )
}
