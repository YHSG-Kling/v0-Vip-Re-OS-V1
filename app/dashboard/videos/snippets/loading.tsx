import { Scissors } from "lucide-react"

export default function SnippetsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <div className="bg-primary/10 rounded-full p-4 w-fit mx-auto mb-4 animate-pulse">
          <Scissors className="h-10 w-10 text-primary" />
        </div>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4" />
        <p className="text-muted-foreground">Loading Video Snippets...</p>
      </div>
    </div>
  )
}
