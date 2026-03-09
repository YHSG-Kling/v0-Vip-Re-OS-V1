import { AISetupAssistant } from '@/components/onboarding/AISetupAssistant'
import { createClient } from '@/lib/supabase/server'
import { getAgentContext } from '@/lib/identity/get-agent-context'

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
