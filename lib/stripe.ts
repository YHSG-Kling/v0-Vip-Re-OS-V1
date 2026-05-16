import 'server-only'

import Stripe from 'stripe'

// Lazy proxy — STRIPE_SECRET_KEY is required at first USE, not at module load.
// This lets static page collection (next build) succeed even when env vars
// aren't present in the build environment (they're set at runtime on Vercel).
let _stripe: Stripe | null = null

function getStripe(): Stripe {
  if (_stripe) return _stripe
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required')
  }
  _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-02-25.clover',
    typescript: true,
  })
  return _stripe
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const s = getStripe() as any
    const v = s[prop]
    return typeof v === 'function' ? v.bind(s) : v
  },
})
