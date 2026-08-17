import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { KnowledgeBaseClient } from './knowledge-base-client'
import { getEmbeddingQueueStatus } from '@/app/actions/knowledge/search'
import { HELP_TOPIC_CATEGORIES } from "@/lib/knowledge/help-topic-categories"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Knowledge Base Management | Settings',
  description: 'Manage help articles and AI knowledge base',
}

export default async function KnowledgeBasePage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Check user type - admin/broker/superadmin only
  const { data: userData } = await supabase
    .from('users')
    .select('user_type, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData || !isAdminOrBroker({ user_type: userData.user_type })) {
    redirect('/dashboard')
  }

  // Fetch initial articles
  const { data: articles } = await supabase
    .from('help_topics_kb')
    .select('*')
    .order('updated_at', { ascending: false })

  // THE CATEGORY LIST IS THE DATABASE'S, NOT THIS PAGE'S. This array was
  // hand-written and fed BOTH the filter chips and the create/edit dropdown,
  // while the live CHECK on help_topics_kb.category admits a different set
  // entirely — only 'general' overlapped, so six of the seven options an admin
  // could pick were refused with 23514. Sourced from the one module now.
  const categories = ['all', ...HELP_TOPIC_CATEGORIES]

  // KEEP-ONE: the embedding-queue monitor came from /dashboard/admin/knowledge, a
  // SECOND "Knowledge Base" screen (same nav label, same admin audience). That page
  // was removed; this was the one thing it had that this page did not, so it is
  // ported here rather than lost. Same getEmbeddingQueueStatus source.
  const queueStatus = await getEmbeddingQueueStatus()

  return (
    <KnowledgeBaseClient
      initialArticles={articles || []}
      categories={categories}
      brokerageId={userData.brokerage_id}
      userType={userData.user_type}
      queueStatus={queueStatus}
    />
  )
}
