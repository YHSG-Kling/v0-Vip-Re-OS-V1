import { NextRequest, NextResponse } from 'next/server'
import { handleAuthCallback } from '@/app/actions/auth'
import { AUTH_ROUTES } from '@/app/constants/auth'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const errorDescription = searchParams.get('error_description')

  // Handle errors from Supabase
  if (error) {
    const message = errorDescription?.includes('expired')
      ? 'link-expired'
      : errorDescription?.includes('used')
      ? 'link-used'
      : 'error'

    return NextResponse.redirect(
      new URL(`/login?message=${message}`, request.url)
    )
  }

  // No code provided
  if (!code) {
    return NextResponse.redirect(new URL('/login?message=error', request.url))
  }

  // Exchange code for session
  const result = await handleAuthCallback(code)

  if (!result.success) {
    const message = result.error?.code || 'error'
    return NextResponse.redirect(
      new URL(`/login?message=${message}`, request.url)
    )
  }

  // Redirect to dashboard - role-based routing happens at /dashboard
  return NextResponse.redirect(new URL('/dashboard', request.url))
}
