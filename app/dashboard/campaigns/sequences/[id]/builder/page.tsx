import { cache } from "react"
import { redirect, notFound } from "next/navigation"
import { getCampaignSequence, VALID_STEP_TYPES, type SequenceBuilderStep } from "@/app/actions/campaign-sequences"
import { getAgentContext } from "@/lib/identity"
import SequenceStepBuilderClient from "./sequence-builder-client"

const getCampaignSequenceCached = cache((id: string) =>
  getCampaignSequence(id, { includeEnrollments: false })
)

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { title: "Sequence Builder" }
  }
  const { sequence } = await getCampaignSequenceCached(id)
  if (!sequence || sequence.brokerage_id !== ctx.brokerageId) {
    return { title: "Sequence Builder" }
  }
  return {
    title: `Build: ${sequence.name} | Sequence Builder`,
    description: "Build multi-step campaign sequences.",
  }
}

export default async function SequenceBuilderPage({ params }: Props) {
  const { id } = await params

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const { sequence, steps: rawSteps, error } = await getCampaignSequenceCached(id)

  if (error || !sequence) notFound()
  if (sequence.brokerage_id !== ctx.brokerageId) notFound()

  const builderSteps: SequenceBuilderStep[] = (rawSteps ?? []).map((s) => ({
    id: s.id,
    step_number: s.step_number,
    step_name: s.step_name ?? s.channel ?? "Step",
    step_type: VALID_STEP_TYPES.has(s.channel as SequenceBuilderStep["step_type"])
      ? (s.channel as SequenceBuilderStep["step_type"])
      : "email",
    delay_days: s.delay_days,
    delay_hours: s.delay_hours,
    subject: s.subject ?? null,
    body: s.body ?? "",
    is_active: s.is_active,
  }))

  return (
    <SequenceStepBuilderClient
      sequence={sequence}
      initialSteps={builderSteps}
      brokerageId={ctx.brokerageId}
      userId={ctx.userId}
      role={ctx.role}
    />
  )
}
