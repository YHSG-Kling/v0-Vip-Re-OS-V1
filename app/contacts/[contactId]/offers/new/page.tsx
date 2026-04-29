"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { createClient } from "@/lib/supabase/client"
import { FormWizard } from "@/app/components/form-wizard/FormWizard"
import type { Contact } from "@/lib/domain/types"

export default function OfferCreatePage() {
  const router = useRouter()
  const params = useParams<{ contactId: string }>()
  const [contact, setContact] = useState<Contact | null>(null)
  const [ctx, setCtx] = useState<{ brokerageId: string; agentUserId: string; teamId?: string | null } | null>(null)

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.replace("/login"); return }

      const [{ data: userData }, { data: agentRow }, { data: contactData }] = await Promise.all([
        supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle(),
        supabase.from("agents").select("id, team_id").eq("user_id", user.id).maybeSingle(),
        supabase.from("contacts").select("*").eq("id", params.contactId).maybeSingle(),
      ])

      if (!userData?.brokerage_id) { router.replace("/dashboard"); return }
      if (contactData) setContact(contactData as unknown as Contact)
      setCtx({ brokerageId: userData.brokerage_id, agentUserId: user.id, teamId: agentRow?.team_id ?? null })
    }
    load()
  }, [params.contactId, router])

  if (!ctx) return null

  return (
    <FormWizard
      mode="offer"
      contact={contact ?? undefined}
      brokerageId={ctx.brokerageId}
      agentUserId={ctx.agentUserId}
      teamId={ctx.teamId}
      open={true}
      onClose={() => router.back()}
    />
  )
}
