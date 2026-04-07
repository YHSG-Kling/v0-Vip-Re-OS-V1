import { NextResponse } from "next/server"
import { getSupabase } from "@/services/supabase"
import { requireAdminMaintenanceAccess } from "@/lib/auth/require-admin-maintenance-access"

export async function GET(request: Request) {
  const auth = await requireAdminMaintenanceAccess(request)
  if (!auth.authorized) return auth.response

  try {
    const supabase = getSupabase()

    const results = {
      contacts: 0,
      users: 0,
      transactions: 0,
      listings: 0,
      agents: 0,
      vendors: 0,
      errors: [] as string[],
    }

    // Check contacts
    try {
      const { data, error } = await supabase.from("contacts").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Contacts table: Table does not exist - run SQL schema script")
        } else {
          results.errors.push(`Contacts table: ${error.message}`)
        }
      } else {
        results.contacts = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Contacts table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check users
    try {
      const { data, error } = await supabase.from("users").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Users table: Table does not exist - run SQL schema script")
        } else {
          results.errors.push(`Users table: ${error.message}`)
        }
      } else {
        results.users = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Users table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check transactions
    try {
      const { data, error } = await supabase.from("transactions").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Transactions table: Table does not exist")
        } else {
          results.errors.push(`Transactions table: ${error.message}`)
        }
      } else {
        results.transactions = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Transactions table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check listings
    try {
      const { data, error } = await supabase.from("listings").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Listings table: Table does not exist")
        } else {
          results.errors.push(`Listings table: ${error.message}`)
        }
      } else {
        results.listings = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Listings table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check agents
    try {
      const { data, error } = await supabase.from("agents").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Agents table: Table does not exist")
        } else {
          results.errors.push(`Agents table: ${error.message}`)
        }
      } else {
        results.agents = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Agents table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check vendors
    try {
      const { data, error } = await supabase.from("vendors").select("count", { count: "exact" }).limit(1)
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Vendors table: Table does not exist")
        } else {
          results.errors.push(`Vendors table: ${error.message}`)
        }
      } else {
        results.vendors = data?.[0]?.count || 0
      }
    } catch (error) {
      results.errors.push(`Vendors table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    return NextResponse.json({
      success: results.errors.length === 0,
      results,
      message:
        results.errors.length === 0
          ? "All tables verified successfully!"
          : `Some tables need setup - ${results.errors.length} issue(s) found`,
      setupRequired: results.errors.length > 0,
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Verification failed",
        details: error instanceof Error ? error.message : "Unknown error",
        message: "Make sure Supabase is connected and run the SQL schema script to create tables",
      },
      { status: 500 },
    )
  }
}
