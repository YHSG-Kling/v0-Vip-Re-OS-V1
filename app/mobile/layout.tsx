import { MobileBottomNav } from "./mobile-bottom-nav"

export default function MobileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-background">
      {children}
      <MobileBottomNav />
    </div>
  )
}
