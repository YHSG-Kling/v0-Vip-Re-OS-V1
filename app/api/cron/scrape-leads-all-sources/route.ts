import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// DEPRECATED — all scraping is now territory-driven via the canonical cron.
// This route exists only to prevent 404s from stale cron registrations.
export async function GET() {
  console.warn('[scrape-leads-all-sources] DEPRECATED — use /api/cron/lead-scraping')
  return NextResponse.json({ deprecated: true, canonical: '/api/cron/lead-scraping' })
}
