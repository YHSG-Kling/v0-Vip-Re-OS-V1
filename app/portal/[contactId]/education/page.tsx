import { redirect } from "next/navigation"
import { getAgentContext } from "@/lib/identity"
import { getEducationPlan } from "@/lib/kernel/education"
import { createClient } from "@/lib/supabase/server"

export default async function PortalEducationPage({
  params,
}: {
  params: Promise<{ contactId: string }>
}) {
  const { contactId } = await params

  // ── Kernel OS: identity resolution ──────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")

  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, buyer_stage, contact_persona")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) redirect("/portal")

  const journeyType = contact.buyer_stage?.includes("seller") ? "seller" : "buyer"

  const plan = await getEducationPlan({
    journeyType,
    journeyPhase: "active",
    persona: contact.contact_persona || "general",
    ageSegment: "30-50",
    contactId,
  })

  return (
    <div className="container mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Your Education & Learning</h1>
        <p className="text-gray-600">
          Personalized learning path based on your {journeyType} journey stage
        </p>
      </div>

      <div className="space-y-4">
        {plan.lessons.map((lesson) => (
          <div
            key={lesson.key}
            className="border rounded-lg p-6 hover:bg-gray-50 transition-colors"
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <h3 className="text-lg font-semibold">{lesson.title}</h3>
                <p className="text-gray-600 text-sm mt-1">
                  {lesson.description}
                </p>
              </div>
              <span className="inline-block bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded">
                {lesson.format}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm text-gray-500">
              <span>{lesson.estimatedMinutes} minutes</span>
              {lesson.isGated && (
                <span className="text-amber-600">Gated Lesson</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
