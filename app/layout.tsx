import React from "react"
import type { Metadata } from 'next'
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
    ...baseMetadata,
  }
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
