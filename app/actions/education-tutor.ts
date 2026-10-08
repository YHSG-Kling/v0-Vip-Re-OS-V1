"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { answerTutorQuestion, type TutorAnswer } from "@/lib/education/client-tutor"

/**
 * Client portal education tutor — answer a client's plain-language education question. Contact-scoped AND
 * session-gated (requireContactAccess — the same gate the /portal/[contactId] surface passes). Client-safe,
 * Fair-Housing-guarded, logs the turn for the question→curriculum loop.
 */
export async function askEducationTutor(contactId: string, question: string): Promise<TutorAnswer> {
  if (!contactId || !question?.trim()) return { answer: "Ask me anything about your journey and I'll explain it.", relatedModules: [], held: false }
  // Wave 139 (139G, P1): "the portal link is the credential" was not true of THIS door — a "use server"
  // export is callable with no session at all, so any contact id bought a model answer (platform-paid AI)
  // grounded in that contact's journey. /portal is session-gated by the proxy, so the gate the portal
  // already passes is the one the action now requires (self, accepted invitee, or the brokerage's staff).
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { answer: "I couldn't find your portal — please use the link your agent sent you.", relatedModules: [], held: false }
  const svc = createServiceClient()
  // Guard: the contact must exist (a bad/expired portal link resolves to nothing).
  const { data: contact } = await svc.from("contacts").select("id").eq("id", contactId).maybeSingle()
  if (!contact) return { answer: "I couldn't find your portal — please use the link your agent sent you.", relatedModules: [], held: false }
  return answerTutorQuestion(svc, { contactId, question: question.slice(0, 1000) })
}
