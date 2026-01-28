import { createClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: NextRequest) {
  try {
    // Validate environment
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      console.error('[LOGIN] Missing NEXT_PUBLIC_SUPABASE_URL')
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      )
    }

    const { email, password } = await request.json()

    // Validate inputs
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    console.log(`[LOGIN] Attempting login for: ${email}`)

    // Query public.users table for user with matching email
    const { data: users, error: queryError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .limit(1)

    if (queryError) {
      console.error('[LOGIN] Database query error:', queryError)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    if (!users || users.length === 0) {
      console.warn(`[LOGIN] User not found: ${email}`)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    const user = users[0]

    // Verify user exists and is not deleted
    if (user.deleted_at) {
      console.warn(`[LOGIN] User account deleted: ${email}`)
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 401 }
      )
    }

    // For demo users (is_demo=true), accept any password
    // For real users, password verification would happen here (Phase 2)
    if (!user.is_demo && user.password_hash) {
      // PHASE 2: Implement bcrypt password verification
      // const isValidPassword = await bcrypt.compare(password, user.password_hash)
      // if (!isValidPassword) {
      //   return NextResponse.json(
      //     { error: 'Invalid email or password' },
      //     { status: 401 }
      //   )
      // }

      // Phase 1: Log warning that real user password is not verified
      console.warn(`[LOGIN] Real user login without password verification: ${email}`)
    }

    // Verify user has valid email
    if (!user.email) {
      console.error('[LOGIN] User has no email')
      return NextResponse.json(
        { error: 'User account error' },
        { status: 500 }
      )
    }

    console.log(`[LOGIN] Successful login: ${email} (${user.user_type})`)

    // Return user data matching our User interface
    return NextResponse.json(
      {
        id: user.id,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        user_type: user.user_type,
        role: user.role,
        phone: user.phone,
        brokerage: user.brokerage,
        is_contact: user.is_contact,
        username: user.username,
        is_demo: user.is_demo || false,
      },
      { status: 200 }
    )
  } catch (error) {
    console.error('[LOGIN] Unexpected error:', error)
    return NextResponse.json(
      { error: 'An error occurred during login' },
      { status: 500 }
    )
  }
}
