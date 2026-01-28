import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Routes that don't require authentication
const publicRoutes = ['/', '/login', '/register', '/forgot-password']

// API routes that don't require authentication
const publicApiRoutes = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/demo-users', '/api/auth/logout']

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  
  // Allow root path (it will handle its own redirect)
  if (pathname === '/') {
    return NextResponse.next()
  }
  
  // Allow public routes
  if (publicRoutes.some(route => pathname.startsWith(route))) {
    return NextResponse.next()
  }
  
  // Allow public API routes
  if (publicApiRoutes.some(route => pathname.startsWith(route))) {
    return NextResponse.next()
  }
  
  // Allow all other API routes to pass through (they can handle their own auth)
  if (pathname.startsWith('/api/')) {
    return NextResponse.next()
  }
  
  // Allow static files and Next.js internals
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/static') ||
    pathname.includes('.') // files with extensions
  ) {
    return NextResponse.next()
  }
  
  // Check for auth token in cookies
  const authToken = request.cookies.get('auth-token')?.value
  const authStorage = request.cookies.get('auth-storage')?.value
  
  // If no auth token or storage, redirect to login
  if (!authToken && !authStorage) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(loginUrl)
  }
  
  // If auth storage exists, check if user is authenticated
  if (authStorage) {
    try {
      const storage = JSON.parse(authStorage)
      const state = storage.state
      
      if (!state?.isAuthenticated || !state?.user) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('redirect', pathname)
        return NextResponse.redirect(loginUrl)
      }
    } catch (error) {
      // If parsing fails, redirect to login
      const loginUrl = new URL('/login', request.url)
      loginUrl.searchParams.set('redirect', pathname)
      return NextResponse.redirect(loginUrl)
    }
  }
  
  return NextResponse.next()
}

// Configure which routes to run middleware on
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, icon.svg, apple-icon.png (favicon files)
     * - public files (images, etc)
     */
    '/((?!_next/static|_next/image|favicon.ico|icon.*\\.png|icon\\.svg|apple-icon\\.png|.*\\.(?:jpg|jpeg|gif|png|svg|ico|webp)).*)',
  ],
}
