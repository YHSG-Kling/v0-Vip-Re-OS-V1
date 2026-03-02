"use server"

import { createClient } from "@/lib/supabase/server"
import {
  linkCalendarProvider,
  pushCalendarEventToProvider,
  pullCalendarEventsFromProvider,
  listProviderAccounts,
  listSyncLogs,
  type CalendarProviderType,
  type CalendarProviderAccountRow,
  type CalendarSyncLogRow,
} from "@/lib/kernel"

export async function connectCalendarProvider(input: {
  providerType: CalendarProviderType
  providerAccountId: string
}): Promise<{ id: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  return await linkCalendarProvider({
    userId: user.id,
    providerType: input.providerType,
    providerAccountId: input.providerAccountId,
  })
}

export async function syncEventToProvider(
  calendarEventId: string,
  providerAccountId: string,
): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  await pushCalendarEventToProvider({
    userId: user.id,
    calendarEventId,
    providerAccountId,
  })
}

export async function syncFromProvider(providerAccountId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  await pullCalendarEventsFromProvider({
    userId: user.id,
    providerAccountId,
  })
}

export async function fetchMyProviderAccounts(): Promise<CalendarProviderAccountRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  return await listProviderAccounts({ userId: user.id })
}

export async function fetchSyncLogs(providerAccountId: string): Promise<CalendarSyncLogRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  return await listSyncLogs({ userId: user.id, providerAccountId })
}
