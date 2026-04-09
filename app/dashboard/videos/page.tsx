import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export const metadata = {
  title: 'Videos | Dashboard',
  description: 'AI Video Generation and Management',
}

export default async function VideosPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Redirect to create page as the default landing
  redirect('/dashboard/videos/create')
}
