import { redirect, notFound } from "next/navigation"
import { getCampaignSequence, getSequenceSteps } from "@/app/actions/campaign-sequences"
import { getAgentContext } from "@/lib/identity"
import SequenceStepBuilderClient from "./sequence-builder-client"

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  const { sequence } = await getCampaignSequence(id)
  return {
    title: sequence ? `Build: ${sequence.name} | Sequence Builder` : "Sequence Builder",
    description: "Build multi-step campaign sequences with drag-and-drop step management.",
  }
}

export default async function SequenceBuilderPage({ params }: Props) {
  const { id } = await params

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const [{ sequence, error }, { steps: builderSteps }] = await Promise.all([
    getCampaignSequence(id),
    getSequenceSteps(id),
  ])

  if (error || !sequence) notFound()
  if (sequence.brokerage_id !== ctx.brokerageId) notFound()

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
