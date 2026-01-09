import { createClient } from "@supabase/supabase-js"
import bcrypt from "bcrypt"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[v0] Missing Supabase environment variables. Check your .env file.")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

interface TestUser {
  email: string
  password: string
  first_name: string
  last_name: string
  user_type: string
  role?: string
  brokerage?: string
}

const TEST_USERS: TestUser[] = [
  {
    email: "admin@nexus.local",
    password: "TestAdmin123!",
    first_name: "Admin",
    last_name: "User",
    user_type: "admin",
    role: "admin",
  },
  {
    email: "broker@nexus.local",
    password: "TestBroker123!",
    first_name: "Broker",
    last_name: "Lead",
    user_type: "broker",
    role: "broker",
    brokerage: "Nexus Realty",
  },
  {
    email: "agent1@nexus.local",
    password: "TestAgent123!",
    first_name: "Sarah",
    last_name: "Johnson",
    user_type: "agent",
    role: "agent",
    brokerage: "Nexus Realty",
  },
  {
    email: "agent2@nexus.local",
    password: "TestAgent123!",
    first_name: "Michael",
    last_name: "Chen",
    user_type: "agent",
    role: "agent",
    brokerage: "Nexus Realty",
  },
  {
    email: "tc@nexus.local",
    password: "TestTC123!",
    first_name: "Transaction",
    last_name: "Coordinator",
    user_type: "TC",
    role: "TC",
  },
  {
    email: "vendor@nexus.local",
    password: "TestVendor123!",
    first_name: "Vendor",
    last_name: "Partner",
    user_type: "vendor",
    role: "vendor",
  },
  {
    email: "lender@nexus.local",
    password: "TestLender123!",
    first_name: "Lender",
    last_name: "Pro",
    user_type: "lender",
    role: "lender",
  },
]

async function seedUsers() {
  console.log("[v0] Starting test user seeding...")

  for (const user of TEST_USERS) {
    try {
      const hashedPassword = await bcrypt.hash(user.password, 10)

      const { data, error } = await supabase.from("users").insert({
        email: user.email,
        password_hash: hashedPassword,
        first_name: user.first_name,
        last_name: user.last_name,
        user_type: user.user_type,
        role: user.role || null,
        brokerage: user.brokerage || null,
        is_contact: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      if (error) {
        console.error(`[v0] Error creating user ${user.email}:`, error.message)
      } else {
        console.log(`[v0] Created test user: ${user.email} (${user.user_type})`)
      }
    } catch (err) {
      console.error(`[v0] Failed to seed user ${user.email}:`, err)
    }
  }

  console.log("[v0] Test user seeding complete!")
}

seedUsers()
