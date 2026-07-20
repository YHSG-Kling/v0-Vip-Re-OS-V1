import React from "react"
import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { Providers } from '@/components/providers'
import { AppShell } from '@/app/components/layout/app-shell'
import './globals.css'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });

// The platform's NAME is a setting (platform_settings.product_brand), never
// hardcoded — the root metadata resolves it per request and gives every child
// page a title template so no page carries the name itself.
export async function generateMetadata(): Promise<Metadata> {
  const { loadProductBrand } = await import('@/lib/platform/product-brand')
  const { createServiceClient } = await import('@/lib/supabase/service')
  const brand = await loadProductBrand(createServiceClient()) // never throws — defaults inside
  return {
    title: { default: brand.name, template: `%s · ${brand.name}` },
    // iOS "Add to Home Screen" installs as a standalone app with the brand name.
    appleWebApp: { capable: true, statusBarStyle: 'default', title: brand.name },
    ...baseMetadata,
  }
}

// Mobile viewport (Next 15 viewport export): edge-to-edge on notched phones
// (viewport-fit=cover) so safe-area-inset-* env() values work — the mobile
// bottom nav pads itself with env(safe-area-inset-bottom). themeColor matches
// the manifest / default brand primary (see app/manifest.ts).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0F172A',
}

const baseMetadata: Metadata = {
  description: 'AI-powered real estate operating system for agents, brokers, and teams',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased bg-white text-gray-900">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
        <Analytics />
      </body>
    </html>
  )
}
