'use client'

import { AISetupAssistant } from '@/app/components/onboarding/AISetupAssistant'
import { useEffect, useState } from 'react'
import { getAssistantChat } from '@/app/actions/onboarding/assistant'

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const [agentOnboardingId, setAgentOnboardingId] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState('license')
  const [assistantOpen, setAssistantOpen] = useState(false)

  // Fetch agent onboarding context from page data
  useEffect(() => {
    const getOnboardingContext = async () => {
      try {
        // This would be passed from the page via searchParams or context
        // For now, we'll detect from URL
        const pathname = window.location.pathname
        const match = pathname.match(/\/onboarding\/([^/]+)/)
        if (match) {
          setCurrentStep(match[1] || 'overview')
        }

        // Fetch onboarding ID from localStorage or context
        const storedId = localStorage.getItem('agentOnboardingId')
        if (storedId) {
          setAgentOnboardingId(storedId)
          // Check if there's existing chat
          const chat = await getAssistantChat(storedId)
          if (chat?.messages && chat.messages.length > 0) {
            setAssistantOpen(true)
          }
        }
      } catch (error) {
        console.error('[v0] Error fetching onboarding context:', error)
      }
    }

    getOnboardingContext()
  }, [])

  // For now, use a placeholder ID - in production this would come from auth/context
  const effectiveOnboardingId = agentOnboardingId || 'default-onboarding'

  return (
    <div className="relative">
      {children}
      <AISetupAssistant
        agentOnboardingId={effectiveOnboardingId}
        currentStep={currentStep}
        isOpen={assistantOpen}
        onOpenChange={setAssistantOpen}
      />
    </div>
  )
}
