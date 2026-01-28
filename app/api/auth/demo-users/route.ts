import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  try {
    console.log('[DEMO-USERS] Fetching demo users')

    // Get all demo users from public.users table
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('is_demo', true)
      .eq('deleted_at', null) // Exclude deleted users
      .order('user_type', { ascending: true })
      .order('first_name', { ascending: true })

    if (error) {
      console.error('[DEMO-USERS] Query error:', error)
      return NextResponse.json([], { status: 200 })
    }

    console.log(`[DEMO-USERS] Found ${users?.length || 0} demo users`)

    // Return demo users
    return NextResponse.json(users || [], { status: 200 })
  } catch (error) {
    console.error('[DEMO-USERS] Unexpected error:', error)
    return NextResponse.json([], { status: 200 })
  }
}
