import { type NextRequest, NextResponse } from "next/server"
import { UserRole } from "@/types"

// Demo users database - matching login route
const DEMO_USERS = [
  {
    email: "agent1@vipos.com",
    name: "Michael Chen",
    first_name: "Michael",
    last_name: "Chen",
    user_type: "agent",
    role: UserRole.AGENT,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "agent2@vipos.com",
    name: "Jessica Martinez",
    first_name: "Jessica",
    last_name: "Martinez",
    user_type: "agent",
    role: UserRole.AGENT,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "teamlead@vipos.com",
    name: "David Williams",
    first_name: "David",
    last_name: "Williams",
    user_type: "team_lead",
    role: UserRole.TEAM_LEADER,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "broker@vipos.com",
    name: "Sarah Johnson",
    first_name: "Sarah",
    last_name: "Johnson",
    user_type: "broker",
    role: UserRole.BROKER,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "admin@vipos.com",
    name: "Admin User",
    first_name: "Admin",
    last_name: "User",
    user_type: "admin",
    role: UserRole.ADMIN,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "tc@vipos.com",
    name: "Tom Wilson",
    first_name: "Tom",
    last_name: "Wilson",
    user_type: "tc",
    role: UserRole.TC,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "compliance@vipos.com",
    name: "Lisa Anderson",
    first_name: "Lisa",
    last_name: "Anderson",
    user_type: "compliance_officer",
    role: UserRole.COMPLIANCE_OFFICER,
    brokerage: "Vipos Realty Group",
  },
  {
    email: "buyer_ftb@vipos.com",
    name: "Emma Thompson",
    first_name: "Emma",
    last_name: "Thompson",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "buyer_luxury@vipos.com",
    name: "Robert Park",
    first_name: "Robert",
    last_name: "Park",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "buyer_relocating@vipos.com",
    name: "Jennifer Chen",
    first_name: "Jennifer",
    last_name: "Chen",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "seller_motivated@vipos.com",
    name: "James Rodriguez",
    first_name: "James",
    last_name: "Rodriguez",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "seller_downsizing@vipos.com",
    name: "Margaret Douglas",
    first_name: "Margaret",
    last_name: "Douglas",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "investor_commercial@vipos.com",
    name: "David Lee",
    first_name: "David",
    last_name: "Lee",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "investor_residential@vipos.com",
    name: "Patricia Murphy",
    first_name: "Patricia",
    last_name: "Murphy",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    email: "lender@vipos.com",
    name: "Kevin Banks",
    first_name: "Kevin",
    last_name: "Banks",
    user_type: "lender",
    role: UserRole.LENDER,
    brokerage: "First National Bank",
  },
  {
    email: "title@vipos.com",
    name: "Susan Legal",
    first_name: "Susan",
    last_name: "Legal",
    user_type: "title_officer",
    role: UserRole.VENDOR,
    brokerage: "Secure Title Company",
  },
  {
    email: "inspector@vipos.com",
    name: "Mark Quality",
    first_name: "Mark",
    last_name: "Quality",
    user_type: "inspector",
    role: UserRole.VENDOR,
    brokerage: "Quality Home Inspections",
  },
  {
    email: "appraiser@vipos.com",
    name: "Nancy Value",
    first_name: "Nancy",
    last_name: "Value",
    user_type: "appraiser",
    role: UserRole.VENDOR,
    brokerage: "Accurate Appraisals Inc",
  },
  {
    email: "escrow@vipos.com",
    name: "Richard Escrow",
    first_name: "Richard",
    last_name: "Escrow",
    user_type: "escrow_officer",
    role: UserRole.VENDOR,
    brokerage: "Premier Escrow Services",
  },
  {
    email: "vendor@vipos.com",
    name: "Victor Services",
    first_name: "Victor",
    last_name: "Services",
    user_type: "vendor",
    role: UserRole.VENDOR,
    brokerage: "General Services LLC",
  },
]

export async function GET(request: NextRequest) {
  try {
    // Return all demo users
    return NextResponse.json(
      {
        success: true,
        users: DEMO_USERS,
        count: DEMO_USERS.length,
      },
      { status: 200 }
    )
  } catch (error: any) {
    console.error("[Demo Users API Error]", error)
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch demo users" },
      { status: 500 }
    )
  }
}
