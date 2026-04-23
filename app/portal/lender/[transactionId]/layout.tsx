import React from "react"
import { createClient } from "@/lib/supabase/server"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"

interface Props {
  children: React.ReactNode
  params: Promise<{ transactionId: string }>
}

export default async function LenderPortalLayout({ children }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <>
      {children}
      {user && (
        <InternalAIAssistant role="lender" userId={user.id} />
      )}
    </>
  )
}
