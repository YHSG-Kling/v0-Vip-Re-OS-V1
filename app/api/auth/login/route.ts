import { type NextRequest, NextResponse } from "next/server"
import { UserRole } from "@/types"

// Demo users database
const DEMO_USERS = [
  {
    id: "1",
    email: "agent1@vipos.com",
    name: "Michael Chen",
    first_name: "Michael",
    last_name: "Chen",
    user_type: "agent",
    role: UserRole.AGENT,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "2",
    email: "agent2@vipos.com",
    name: "Jessica Martinez",
    first_name: "Jessica",
    last_name: "Martinez",
    user_type: "agent",
    role: UserRole.AGENT,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "3",
    email: "teamlead@vipos.com",
    name: "David Williams",
    first_name: "David",
    last_name: "Williams",
    user_type: "team_leader",
    role: UserRole.TEAM_LEADER,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "4",
    email: "broker@vipos.com",
    name: "Sarah Johnson",
    first_name: "Sarah",
    last_name: "Johnson",
    user_type: "broker",
    role: UserRole.BROKER,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "5",
    email: "admin@vipos.com",
    name: "Admin User",
    first_name: "Admin",
    last_name: "User",
    user_type: "admin",
    role: UserRole.ADMIN,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "6",
    email: "tc@vipos.com",
    name: "Tom Wilson",
    first_name: "Tom",
    last_name: "Wilson",
    user_type: "transaction_coordinator",
    role: UserRole.TC,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "7",
    email: "compliance@vipos.com",
    name: "Lisa Anderson",
    first_name: "Lisa",
    last_name: "Anderson",
    user_type: "compliance_manager",
    role: UserRole.COMPLIANCE_OFFICER,
    brokerage: "Vipos Realty Group",
  },
  {
    id: "8",
    email: "buyer_ftb@vipos.com",
    name: "Emma Thompson",
    first_name: "Emma",
    last_name: "Thompson",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "9",
    email: "buyer_luxury@vipos.com",
    name: "Robert Park",
    first_name: "Robert",
    last_name: "Park",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "10",
    email: "buyer_relocating@vipos.com",
    name: "Jennifer Chen",
    first_name: "Jennifer",
    last_name: "Chen",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "11",
    email: "seller_motivated@vipos.com",
    name: "James Rodriguez",
    first_name: "James",
    last_name: "Rodriguez",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "12",
    email: "seller_downsizing@vipos.com",
    name: "Margaret Douglas",
    first_name: "Margaret",
    last_name: "Douglas",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "13",
    email: "investor_commercial@vipos.com",
    name: "David Lee",
    first_name: "David",
    last_name: "Lee",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "14",
    email: "investor_residential@vipos.com",
    name: "Patricia Murphy",
    first_name: "Patricia",
    last_name: "Murphy",
    user_type: "contact",
    role: UserRole.CONTACT,
    brokerage: null,
  },
  {
    id: "15",
    email: "lender@vipos.com",
    name: "Kevin Banks",
    first_name: "Kevin",
    last_name: "Banks",
    user_type: "lender",
    role: UserRole.LENDER,
    brokerage: "First National Bank",
  },
  {
    id: "16",
    email: "title@vipos.com",
    name: "Susan Legal",
    first_name: "Susan",
    last_name: "Legal",
    user_type: "title_officer",
    role: UserRole.VENDOR,
    brokerage: "Secure Title Company",
  },
  {
    id: "17",
    email: "inspector@vipos.com",
    name: "Mark Quality",
    first_name: "Mark",
    last_name: "Quality",
    user_type: "inspector",
    role: UserRole.VENDOR,
    brokerage: "Quality Home Inspections",
  },
  {
    id: "18",
    email: "appraiser@vipos.com",
    name: "Nancy Value",
    first_name: "Nancy",
    last_name: "Value",
    user_type: "appraiser",
    role: UserRole.VENDOR,
    brokerage: "Accurate Appraisals Inc",
  },
  {
    id: "19",
    email: "escrow@vipos.com",
    name: "Richard Escrow",
    first_name: "Richard",
    last_name: "Escrow",
    user_type: "escrow_officer",
    role: UserRole.VENDOR,
    brokerage: "Premier Escrow Services",
  },
  {
    id: "20",
    email: "vendor@vipos.com",
    name: "Victor Services",
    first_name: "Victor",
    last_name: "Services",
    user_type: "vendor",
    role: UserRole.VENDOR,
    brokerage: "General Services LLC",
  },
]

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email } = body

    if (!email) {
      return NextResponse.json(
        { success: false, error: "Email is required" },
        { status: 400 }
      )
    }

    // Find user by email (case-insensitive)
    const user = DEMO_USERS.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    )

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      )
    }

    // Generate a simple JWT-like token (in production, use proper JWT)
    const token = Buffer.from(
      JSON.stringify({
        userId: user.id,
        email: user.email,
        role: user.role,
        exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
      })
    ).toString("base64")

    // Create response with user data
    const response = NextResponse.json(
      {
        success: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          userType: user.user_type,
          brokerage: user.brokerage,
        },
      },
      { status: 200 }
    )

    // Set secure HTTP-only cookie with auth token
    response.cookies.set({
      name: "auth-token",
      value: token,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: "/",
    })

    return response
  } catch (error: any) {
    console.error("[Login API Error]", error)
    return NextResponse.json(
      { success: false, error: error.message || "Login failed" },
      { status: 500 }
    )
  }
}
