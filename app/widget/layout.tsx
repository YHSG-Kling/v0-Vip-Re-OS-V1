// Widget routes render their own <html>/<body> — opt out of the root layout.
// Next.js App Router: any layout.tsx at this level overrides ancestors.
export default function WidgetLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
