import { AISetupAssistant } from '@/components/onboarding/AISetupAssistant'
import { getAgentContext } from '@/lib/identity/get-agent-context'

export const dynamic = 'force-dynamic'

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { agentId, brokerageId } = await getAgentContext()

  return (
    <div className="relative">
      {children}
      <AISetupAssistant
        brokerageId={brokerageId}
        agentId={agentId}
      />
    </div>
  )
}
