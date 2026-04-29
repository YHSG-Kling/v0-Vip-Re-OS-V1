"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { useAuth } from "@/lib/auth/client"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"
import { Loader2 } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

export default function NewListingPage() {
  const router = useRouter()
  const { user, userContext, isLoading: authLoading } = useAuth()
  const [teamId, setTeamId] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    if (!user?.id) return
    const supabase = createClient()
    supabase
      .from("agents")
      .select("team_id")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => setTeamId(data?.team_id ?? null))
  }, [user?.id])

  if (authLoading || teamId === undefined) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!user?.id || !userContext?.brokerage_id) {
    router.replace("/login")
    return null
  }

  return (
    <FormWizard
      mode="listing"
      brokerageId={userContext.brokerage_id}
      agentUserId={user.id}
      teamId={teamId}
      open={true}
      onClose={() => router.back()}
    />
  )
}
