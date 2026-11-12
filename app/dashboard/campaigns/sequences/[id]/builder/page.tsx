import { cache } from "react"
import { redirect, notFound } from "next/navigation"
import { getCampaignSequence, getSequenceSteps } from "@/app/actions/campaign-sequences"
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"
import SequenceStepBuilderClient from "./sequence-builder-client"

const getCampaignSequenceCached = cache((id: string) =>
  getCampaignSequence(id, { includeEnrollments: false })
)

interface Props {
  params: Promise<{ id: string }>
}

export async function generateMetadata({ params }: Props) {
  const { id } = await params
  // Self-healing identity: an agent who reached this page without a brokerage/agents row is
  // PROVISIONED in place rather than bounced to onboarding (the "bounce" class in the live
  // walkthrough). The redirect below now only fires for an account that genuinely cannot
  // self-provision — a pending brokerage invite, or a staff user whose brokerage comes from
  // their org. Idempotent: a no-op for an already-anchored user.
  const ctx = await ensureAgentContextInPlace()
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

  const ctx = await ensureAgentContextInPlace()
  if (!ctx.isAuthenticated) redirect("/login")
  if (!ctx.brokerageId) redirect("/dashboard/onboarding")

  const { sequence, error } = await getCampaignSequenceCached(id)

  if (error || !sequence) notFound()
  if (sequence.brokerage_id !== ctx.brokerageId) notFound()

  // DATA-LOSS DEFECT FIXED (w6s3): this page used to map `getCampaignSequence`'s
  // raw step rows into builder steps INLINE, carrying only the nine common fields.
  // `saveSequenceSteps` writes every field the step palette declares — ad_platform,
  // ad_budget_cents, gift_occasion, esign_recipient, tour_property_ids, video_script,
  // task_title, avm_*, document_*, qr_* … — so a broker who configured any of those,
  // reopened the builder and pressed Save had every one of them written back as null.
  // The inline mapping also coerced an unrecognised `channel` to "email", which the
  // next save would then persist, silently changing the step's channel.
  //
  // Survivor: `app/actions/campaign-sequences.ts:getSequenceSteps` — the same
  // brokerage-gated read, now projecting the palette allow-list so it is the exact
  // inverse of saveSequenceSteps, and refusing (rather than coercing) an invalid
  // channel.
  const { steps: builderSteps, error: stepsError } = await getSequenceSteps(id)
  if (stepsError) {
    // Refuse rather than open the builder on a partial step list: the builder saves
    // the WHOLE step set, so rendering it with steps missing would let the next Save
    // delete the ones that failed to load.
    return (
      <div className="p-6 max-w-2xl">
        <h1 className="text-xl font-semibold mb-2">This sequence can&apos;t be opened for editing</h1>
        <p className="text-sm text-muted-foreground">
          Its steps could not be read: {stepsError}. Editing is blocked so a save cannot overwrite them.
        </p>
      </div>
    )
  }

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
