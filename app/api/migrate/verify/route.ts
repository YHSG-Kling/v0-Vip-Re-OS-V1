import { NextResponse } from "next/server"
import { supabaseService } from "@/services/supabaseService"

export async function GET() {
  try {
    // First check if we can connect to Supabase
    const healthCheck = await supabaseService.healthCheck()
    if (!healthCheck.connected) {
      return NextResponse.json(
        {
          error: "Failed to connect to Supabase",
          details: healthCheck.error,
          message:
            "Please check your Supabase connection and ensure the tables are created by running the SQL schema script.",
        },
        { status: 500 },
      )
    }

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
      const contacts = await supabaseService.getContacts()
      results.contacts = contacts.length
    } catch (error) {
      results.errors.push(`Contacts table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check users
    try {
      const users = await supabaseService.getUsers()
      results.users = users.length
    } catch (error) {
      results.errors.push(`Users table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check transactions
    try {
      const transactions = await supabaseService.getTransactions()
      results.transactions = transactions.length
    } catch (error) {
      results.errors.push(`Transactions table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check listings
    try {
      const listings = await supabaseService.getListings()
      results.listings = listings.length
    } catch (error) {
      results.errors.push(`Listings table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check agents
    try {
      const agents = await supabaseService.getAgents()
      results.agents = agents.length
    } catch (error) {
      results.errors.push(`Agents table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    // Check vendors
    try {
      const vendors = await supabaseService.getVendors()
      results.vendors = vendors.length
    } catch (error) {
      results.errors.push(`Vendors table: ${error instanceof Error ? error.message : "Unknown error"}`)
    }

    return NextResponse.json({
      success: results.errors.length === 0,
      results,
      message:
        results.errors.length === 0
          ? "All tables verified successfully!"
          : "Some tables have issues - see errors array",
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Migration verification failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
