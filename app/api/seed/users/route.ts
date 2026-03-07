import { createClient } from "@supabase/supabase-js"
import { NextResponse } from "next/server"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

export async function POST() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: "Missing Supabase environment variables" }, { status: 500 })
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const TEST_USERS = [
    {
      email: "admin@smartengine.local",
      first_name: "Admin",
      last_name: "User",
      user_type: "admin",
      role: "admin",
      brokerage: null,
    },
    {
      email: "broker@nexus.local",
      first_name: "Broker",
      last_name: "Lead",
      user_type: "broker",
      role: "broker",
      brokerage: "Nexus Realty",
    },
    {
      email: "sarah.agent@nexus.local",
      first_name: "Sarah",
      last_name: "Johnson",
      user_type: "agent",
      role: "agent",
      brokerage: "Nexus Realty",
    },
    {
      email: "michael.agent@nexus.local",
      first_name: "Michael",
      last_name: "Chen",
      user_type: "agent",
      role: "agent",
      brokerage: "Nexus Realty",
    },
    {
      email: "tc@nexus.local",
      first_name: "Taylor",
      last_name: "Coordinator",
      user_type: "tc",
      role: "tc",
      brokerage: null,
    },
    {
      email: "vendor@nexus.local",
      first_name: "Victor",
      last_name: "Vendor",
      user_type: "vendor",
      role: "vendor",
      brokerage: null,
    },
    {
      email: "lender@nexus.local",
      first_name: "Larry",
      last_name: "Lender",
      user_type: "lender",
      role: "lender",
      brokerage: null,
    },
  ]

  const results: { email: string; success: boolean; error?: string }[] = []

  for (const user of TEST_USERS) {
    const passwordHash = Buffer.from(`TestPass123!_${user.email}`).toString("base64")

    const { error } = await supabase.from("users").upsert(
      {
        email: user.email,
        password_hash: passwordHash,
        first_name: user.first_name,
        last_name: user.last_name,
        user_type: user.user_type,
        role: user.role,
        brokerage: user.brokerage,
        is_contact: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "email" },
    )

    if (error?.message?.includes("users") && error?.message?.includes("does not exist")) {
      return NextResponse.json(
        {
          error: "The 'users' table does not exist. Please create it first in Supabase SQL Editor.",
          sql: `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  user_type TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  brokerage TEXT,
  role TEXT,
  created_by UUID,
  is_contact BOOLEAN DEFAULT false,
  contact_type TEXT,
  contact_persona TEXT,
  username TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);`,
        },
        { status: 400 },
      )
    }

    results.push({
      email: user.email,
      success: !error,
      error: error?.message,
    })
  }

  const successCount = results.filter((r) => r.success).length
  return NextResponse.json({
    message: `Seeded ${successCount}/${TEST_USERS.length} test users`,
    results,
  })
}
