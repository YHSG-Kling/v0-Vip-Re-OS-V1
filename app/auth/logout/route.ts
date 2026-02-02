import { NextRequest, NextResponse } from 'next/server'
import { signOut } from '@/app/actions/auth'

export async function POST(request: NextRequest) {
  try {
    await signOut()
    return NextResponse.redirect(new URL('/login', request.url))
  } catch (err) {
    console.error('Logout error:', err)
    return NextResponse.redirect(new URL('/login', request.url))
  }
}

export async function GET(request: NextRequest) {
  try {
    await signOut()
    return NextResponse.redirect(new URL('/login', request.url))
  } catch (err) {
    console.error('Logout error:', err)
    return NextResponse.redirect(new URL('/login', request.url))
  }
}
