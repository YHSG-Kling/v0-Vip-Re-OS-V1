// app/legal/page.tsx — /legal (public; classifyProxyPath reads it as an open route, no sign-in)
//
// THE DISPLAYED COPYRIGHT + LICENSING NOTICE (wave 144, lane 144H; owner ruling 18: "copyright/licensing prohibitions for
// this platform must be DISPLAYED (notice/terms) so no one can copy it"). The text is the ONE notice in
// lib/branding/platform-rights-notice.ts; the holder's name is the platform's product brand (platform_settings.product_brand
// — never hardcoded, the app's name is still a setting). An unreadable brand falls back to the brand kit's default name.

import { platformRightsNotice, type PlatformRightsNotice } from "@/lib/branding/platform-rights-notice"
import { DEFAULT_PRODUCT_BRAND, loadProductBrand } from "@/lib/platform/product-brand"

export const dynamic = "force-dynamic"
export const metadata = { title: "Copyright and licensing notice" }

async function productName(): Promise<string> {
  try {
    const { createServiceClient } = await import("@/lib/supabase/service")
    return (await loadProductBrand(createServiceClient())).name
  } catch {
    return DEFAULT_PRODUCT_BRAND.name
  }
}

export default async function LegalNoticePage() {
  const name = await productName()
  const notice: PlatformRightsNotice = platformRightsNotice({ holder: name, product: name, year: new Date().getUTCFullYear() })
  return (
    <main className="min-h-screen bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <section id="copyright" aria-labelledby="copyright-title" className="space-y-5 text-slate-800">
          <h1 id="copyright-title" className="text-3xl font-bold">{notice.title}</h1>
          <p className="font-medium">{notice.copyrightLine}</p>
          {notice.intro.map((p) => <p key={p} className="leading-relaxed">{p}</p>)}
          <div>
            <p className="font-medium">Unless a written agreement with {name} expressly allows it, you may not:</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              {notice.prohibited.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
          {notice.closing.map((p) => <p key={p} className="leading-relaxed">{p}</p>)}
          <p className="text-xs text-slate-500">Notice version {notice.version}.</p>
        </section>
        <footer className="mt-12 border-t pt-4 text-xs text-slate-500">{notice.footerLine}</footer>
      </div>
    </main>
  )
}
