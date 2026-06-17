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
      const { count, error } = await supabase.from("contacts").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Contacts table: Table does not exist - run SQL schema script")
        } else {
          results.errors.push(`Contacts table: ${error.message}`)
        }
      } else {
        results.contacts = count || 0
      }
    } catch (error) {
      results.errors.push(`Contacts table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check users
    try {
      const { count, error } = await supabase.from("users").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Users table: Table does not exist - run SQL schema script")
        } else {
          results.errors.push(`Users table: ${error.message}`)
        }
      } else {
        results.users = count || 0
      }
    } catch (error) {
      results.errors.push(`Users table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check transactions
    try {
      const { count, error } = await supabase.from("transactions").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Transactions table: Table does not exist")
        } else {
          results.errors.push(`Transactions table: ${error.message}`)
        }
      } else {
        results.transactions = count || 0
      }
    } catch (error) {
      results.errors.push(`Transactions table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check listings
    try {
      const { count, error } = await supabase.from("listings").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Listings table: Table does not exist")
        } else {
          results.errors.push(`Listings table: ${error.message}`)
        }
      } else {
        results.listings = count || 0
      }
    } catch (error) {
      results.errors.push(`Listings table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check agents
    try {
      const { count, error } = await supabase.from("agents").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Agents table: Table does not exist")
        } else {
          results.errors.push(`Agents table: ${error.message}`)
        }
      } else {
        results.agents = count || 0
      }
    } catch (error) {
      results.errors.push(`Agents table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check vendors
    try {
      const { count, error } = await supabase.from("vendors").select("id", { count: "exact", head: true })
      if (error) {
        if (error.code === "PGRST116") {
          results.errors.push("Vendors table: Table does not exist")
        } else {
          results.errors.push(`Vendors table: ${error.message}`)
        }
      } else {
        results.vendors = count || 0
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
