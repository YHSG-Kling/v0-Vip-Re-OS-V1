'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { demoSignIn, getDemoUsers } from '@/app/actions/demo-auth';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoUsers, setDemoUsers] = useState<any[]>([]);

  // Load demo users on mount
  useState(() => {
    getDemoUsers().then(setDemoUsers);
  }, []);

  const handleDemoLogin = async (email: string) => {
    setLoading(true);
    setError(null);

    try {
      const result = await demoSignIn(email);

      if (result.success) {
        // Redirect to dashboard
        router.push('/dashboard');
      } else {
        setError(result.error || 'Login failed');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>VIP Agents Real Estate OS</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="demo" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="demo">Demo Login</TabsTrigger>
              <TabsTrigger value="credentials">Credentials</TabsTrigger>
            </TabsList>

            {/* Demo Tab */}
            <TabsContent value="demo" className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Select a demo user to log in:
                </p>

                <div className="grid gap-2 max-h-80 overflow-y-auto">
                  {demoUsers.length > 0 ? (
                    demoUsers.map((user) => (
                      <Button
                        key={user.email}
                        variant="outline"
                        className="justify-start text-left"
                        onClick={() => handleDemoLogin(user.email)}
                        disabled={loading}
                      >
                        <div className="flex-1">
                          <div className="font-medium">{user.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {user.email} • {user.role}
                          </div>
                        </div>
                        {loading && (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        )}
                      </Button>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Loading demo users...
                    </p>
                  )}
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                <p>All demo accounts use password: <code className="bg-muted px-1">Demo@123456</code></p>
              </div>
            </TabsContent>

            {/* Credentials Tab */}
            <TabsContent value="credentials" className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-4">
                <Input placeholder="Email" type="email" id="email" />
                <Input placeholder="Password" type="password" id="password" />
                <Button className="w-full" disabled={loading}>
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    'Sign In'
                  )}
                </Button>
              </div>

              <div className="text-center text-sm">
                <p className="text-muted-foreground">
                  Don't have an account?{' '}
                  <a href="#" className="text-primary hover:underline">
                    Sign up
                  </a>
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
