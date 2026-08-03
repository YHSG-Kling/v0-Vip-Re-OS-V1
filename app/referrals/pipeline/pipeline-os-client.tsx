"use client"

import { useRouter } from "next/navigation"
import { ReferralPipelinePanel } from "@/app/dashboard/referrals/components/os"
import { updateReferralStatus, sendReferralThankYou } from "@/app/actions/referrals/referral-actions"
import type { ReferralStatus } from "@/lib/referrals/referral-status"

interface Referral {
  id: string
  referral_name: string
  status: string
  source_contact_id?: string
  source_contact_name?: string
  created_at: string
  value_estimate?: number
}

interface PipelineOsClientProps {
  agentId: string
  brokerageId: string
  referrals: Referral[]
}

export function PipelineOsClient({
  agentId,
  brokerageId,
  referrals,
}: PipelineOsClientProps) {
  const router = useRouter()

  const handleCreateReferral = () => {
    router.push("/referrals?action=create")
  }

  const handleUpdateStatus = async (referralId: string, status: ReferralStatus) => {
    await updateReferralStatus(referralId, status)
    router.refresh()
  }

  const handleSendThankYou = async (referralId: string) => {
    await sendReferralThankYou(referralId)
    router.refresh()
  }

  return (
    <ReferralPipelinePanel
      referrals={referrals}
      onUpdateStatus={handleUpdateStatus}
      onSendThankYou={handleSendThankYou}
      onCreateReferral={handleCreateReferral}
      agentId={agentId}
      brokerageId={brokerageId}
    />
  )
}
