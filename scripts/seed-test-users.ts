import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[seed] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

// Service role client — bypasses RLS, required for auth.admin.*
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Canonical test users ─────────────────────────────────────────────────────
// user_type must be one of: broker | admin | agent | vendor | lender | TC | compliance_officer | contact
// role must be a canonical role: broker | admin | agent | vendor | lender | tc | compliance_officer | contact

interface SeedUser {
  email: string
  password: string
  first_name: string
  last_name: string
  user_type: string      // public.users CHECK constraint value
  canonical_role: string // canonical role for user_role_assignments
  needs_brokerage: boolean
}

const TEST_USERS: SeedUser[] = [
  {
    email: 'admin@nexus.local',
    password: 'TestAdmin123!',
    first_name: 'Admin',
    last_name: 'User',
    user_type: 'admin',
    canonical_role: 'admin',
    needs_brokerage: true,
  },
  {
    email: 'broker@nexus.local',
    password: 'TestBroker123!',
    first_name: 'Broker',
    last_name: 'Lead',
    user_type: 'broker',
    canonical_role: 'broker',
    needs_brokerage: true,
  },
  {
    email: 'agent1@nexus.local',
    password: 'TestAgent123!',
    first_name: 'Sarah',
    last_name: 'Johnson',
    user_type: 'agent',
    canonical_role: 'agent',
    needs_brokerage: true,
  },
  {
    email: 'agent2@nexus.local',
    password: 'TestAgent123!',
    first_name: 'Michael',
    last_name: 'Chen',
    user_type: 'agent',
    canonical_role: 'agent',
    needs_brokerage: true,
  },
  {
    email: 'tc@nexus.local',
    password: 'TestTC123!',
    first_name: 'Transaction',
    last_name: 'Coordinator',
    user_type: 'TC',          // must match CHECK constraint exactly
    canonical_role: 'tc',    // canonical role used in role assignments + auth metadata
    needs_brokerage: true,
  },
  {
    email: 'vendor@nexus.local',
    password: 'TestVendor123!',
    first_name: 'Vendor',
    last_name: 'Partner',
    user_type: 'vendor',
    canonical_role: 'vendor',
    needs_brokerage: false,
  },
  {
    email: 'lender@nexus.local',
    password: 'TestLender123!',
    first_name: 'Lender',
    last_name: 'Pro',
    user_type: 'lender',
    canonical_role: 'lender',
    needs_brokerage: false,
  },
  {
    email: 'compliance@nexus.local',
    password: 'TestCompliance123!',
    first_name: 'Compliance',
    last_name: 'Officer',
    user_type: 'compliance_officer',
    canonical_role: 'compliance_officer',
    needs_brokerage: true,
  },
]

async function seedUsers() {
  console.log('[seed] Starting test user seeding...')

  // ── Step 1: Ensure brokerage exists ────────────────────────────────────────
  let brokerageId: string | null = null

  const { data: existingBrokerage } = await supabase
    .from('brokerages')
    .select('id')
    .eq('name', 'Nexus Realty')
    .maybeSingle()

  if (existingBrokerage) {
    brokerageId = existingBrokerage.id
    console.log(`[seed] Using existing brokerage: ${brokerageId}`)
  } else {
    const { data: newBrokerage, error: brokerageError } = await supabase
      .from('brokerages')
      .insert({ name: 'Nexus Realty', slug: 'nexus-realty' })
      .select('id')
      .single()

    if (brokerageError) {
      console.error('[seed] Failed to create brokerage:', brokerageError.message)
      // Non-fatal — continue without brokerage
    } else {
      brokerageId = newBrokerage.id
      console.log(`[seed] Created brokerage: ${brokerageId}`)
    }
  }

  // ── Step 2: Create each user ────────────────────────────────────────────────
  for (const user of TEST_USERS) {
    try {
      const assignedBrokerageId = user.needs_brokerage ? brokerageId : null

      // 2a. Create auth.users row with user_metadata
      // auth.admin.createUser() is idempotent — if email exists, it returns an error we can skip
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,       // skip email confirmation for test users
        user_metadata: {
          user_type: user.canonical_role,    // useAuth reads user_metadata.user_type first
          first_name: user.first_name,
          last_name: user.last_name,
        },
      })

      if (authError) {
        if (authError.message.includes('already been registered') || authError.message.includes('already exists')) {
          console.log(`[seed] Auth user already exists: ${user.email} — skipping auth creation`)
          // Still try to upsert public.users and role assignment below
          // Get existing auth user id
          const { data: { users: existingUsers } } = await supabase.auth.admin.listUsers()
          const existingAuthUser = existingUsers.find(u => u.email === user.email)
          if (!existingAuthUser) {
            console.error(`[seed] Could not find existing auth user for ${user.email}`)
            continue
          }

          // Upsert public.users
          await supabase.from('users').upsert({
            id: existingAuthUser.id,
            email: user.email,
            user_type: user.user_type,
            first_name: user.first_name,
            last_name: user.last_name,
            brokerage_id: assignedBrokerageId,
            is_contact: false,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' })

          // Upsert role assignment
          await supabase.from('user_role_assignments').upsert({
            user_id: existingAuthUser.id,
            role: user.canonical_role,
            brokerage_id: assignedBrokerageId,
          }, { onConflict: 'user_id,role' })

          console.log(`[seed] Updated existing user: ${user.email} (${user.canonical_role})`)
          continue
        }
        console.error(`[seed] Auth error for ${user.email}:`, authError.message)
        continue
      }

      const authUserId = authData.user.id

      // 2b. Upsert public.users — id MUST match auth.users.id for RLS
      const { error: publicUserError } = await supabase.from('users').upsert({
        id: authUserId,            // ← critical: matches auth.uid()
        email: user.email,
        user_type: user.user_type, // CHECK constraint: broker|admin|agent|vendor|lender|TC|compliance_officer|contact
        first_name: user.first_name,
        last_name: user.last_name,
        brokerage_id: assignedBrokerageId,
        is_contact: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })

      if (publicUserError) {
        console.error(`[seed] public.users error for ${user.email}:`, publicUserError.message)
        continue
      }

      // 2c. Insert role assignment
      const { error: assignmentError } = await supabase.from('user_role_assignments').upsert({
        user_id: authUserId,
        role: user.canonical_role,
        brokerage_id: assignedBrokerageId,
      }, { onConflict: 'user_id,role' })

      if (assignmentError) {
        console.error(`[seed] role assignment error for ${user.email}:`, assignmentError.message)
        // Non-fatal — user can still log in, role will fall back to user_metadata
      }

      console.log(`[seed] Created: ${user.email} | role: ${user.canonical_role} | brokerage: ${assignedBrokerageId ?? 'none'}`)

    } catch (err) {
      console.error(`[seed] Unexpected error for ${user.email}:`, err)
    }
  }

  console.log('[seed] Test user seeding complete.')
  console.log('')
  console.log('[seed] Test credentials:')
  for (const u of TEST_USERS) {
    console.log(`  ${u.canonical_role.padEnd(20)} ${u.email.padEnd(30)} ${u.password}`)
  }
}

seedUsers()
