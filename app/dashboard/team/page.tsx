import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"

export default async function TeamPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Get user's brokerage
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .single()

  // Fetch team members
  const { data: teamMembers } = userData?.brokerage_id 
    ? await supabase
        .from("users")
        .select("id, first_name, last_name, email, user_type, avatar_url, status")
        .eq("brokerage_id", userData.brokerage_id)
        .order("first_name")
        .limit(50)
    : { data: [] }

  const getInitials = (firstName: string, lastName: string) => {
    return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase()
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Team</h1>
          <p className="text-muted-foreground">View and manage your team members</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {teamMembers && teamMembers.length > 0 ? (
          teamMembers.map((member) => (
            <Card key={member.id}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <Avatar className="h-12 w-12">
                    <AvatarImage src={member.avatar_url || undefined} />
                    <AvatarFallback>
                      {getInitials(member.first_name || "", member.last_name || "")}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">
                      {member.first_name} {member.last_name}
                    </p>
                    <p className="text-sm text-muted-foreground truncate">{member.email}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {member.user_type || "agent"}
                  </Badge>
                  <Badge 
                    variant="outline" 
                    className={member.status === "active" ? "text-green-600" : "text-gray-500"}
                  >
                    {member.status || "active"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          <Card className="col-span-full">
            <CardContent className="py-8 text-center text-muted-foreground">
              No team members found. Team members will appear here once added to your brokerage.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
