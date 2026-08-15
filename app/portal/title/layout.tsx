import React from "react"
import { createClient } from "@/lib/supabase/server"
import { InternalAIAssistant } from "@/app/components/shared/internal-ai-assistant"

interface Props {
  children: React.ReactNode
}

export default async function TitlePortalRootLayout({ children }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <>
      {children}
      {user && (
        <InternalAIAssistant role="title" userId={user.id} />
      )}
    </>
  )
}
