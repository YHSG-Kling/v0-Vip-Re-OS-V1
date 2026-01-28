import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  try {
    console.log('[LOGOUT] User logout initiated')

    // Create response that clears cookies
    const response = NextResponse.json({ success: true })

    // Clear auth cookies
    response.cookies.delete('auth_token')
    response.cookies.delete('user_email')

    // PHASE 2: Delete session from database
    // const token = request.cookies.get('auth_token')?.value
    // if (token) {
    //   await supabase
    //     .from('sessions')
    //     .delete()
    //     .eq('token', token)
    // }

    console.log('[LOGOUT] Cookies cleared, user logged out')

    return response
  } catch (error) {
    console.error('[LOGOUT] Error:', error)
    return NextResponse.json(
      { error: 'Logout failed' },
      { status: 500 }
    )
  }
}
