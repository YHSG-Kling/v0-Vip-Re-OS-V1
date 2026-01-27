import { Suspense } from "react"
import ContentStudioClient from "./content-studio-client"

interface ContentStudioPageProps {
  userId?: string
  userRole?: string
}

export default function ContentStudioPage({ userId, userRole }: ContentStudioPageProps) {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <ContentStudioClient userId={userId} userRole={userRole} />
    </Suspense>
  )
}
