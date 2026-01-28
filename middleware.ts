import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Check if user is authenticated by looking for auth_token cookie
  const authToken = request.cookies.get('auth_token')?.value
  const isAuthenticated = !!authToken

  // Public routes that don't require authentication
  const publicRoutes = ['/login', '/auth', '/portal', '/journey', '/api/auth']
  const isPublicRoute = publicRoutes.some(route => pathname.startsWith(route))

  // Always allow root path - will redirect based on auth state in client
  if (pathname === '/') {
    return NextResponse.next()
  }

  // Redirect unauthenticated users trying to access protected routes
  if (!isAuthenticated && !isPublicRoute) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Redirect authenticated users away from login page
  if (isAuthenticated && pathname === '/login') {
    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Match all routes except static files and assets
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
}
