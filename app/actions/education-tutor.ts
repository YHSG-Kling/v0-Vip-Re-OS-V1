"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { answerTutorQuestion, type TutorAnswer } from "@/lib/education/client-tutor"

/**
 * Client portal education tutor — answer a client's plain-language education question. Contact-scoped (the
 * portal link is the credential, consistent with the other /portal/[contactId] actions). Client-safe,
 * Fair-Housing-guarded, logs the turn for the question→curriculum loop.
 */
export async function askEducationTutor(contactId: string, question: string): Promise<TutorAnswer> {
  if (!contactId || !question?.trim()) return { answer: "Ask me anything about your journey and I'll explain it.", relatedModules: [], held: false }
  const svc = createServiceClient()
  // Guard: the contact must exist (a bad/expired portal link resolves to nothing).
  const { data: contact } = await svc.from("contacts").select("id").eq("id", contactId).maybeSingle()
  if (!contact) return { answer: "I couldn't find your portal — please use the link your agent sent you.", relatedModules: [], held: false }
  return answerTutorQuestion(svc, { contactId, question: question.slice(0, 1000) })
}
