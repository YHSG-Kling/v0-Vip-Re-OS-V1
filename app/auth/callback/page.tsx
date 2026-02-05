'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Loader2 } from 'lucide-react';
export const dynamic = 'force-dynamic';
export default function CallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const handleCallback = async () => {
      try {
        console.log('[v0] Processing auth callback...');
        
        const code = searchParams.get('code');
        if (!code) {
          console.error('[v0] No authentication code found');
          setError('No authentication code found');
          setLoading(false);
          return;
        }

        const supabase = createClient();
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

        if (exchangeError) {
          console.error('[v0] Session exchange error:', exchangeError);
          setError(exchangeError.message);
          setLoading(false);
          return;
        }

        console.log('[v0] Auth callback successful, redirecting to dashboard...');
        
        // Redirect to dashboard
        router.push('/dashboard');
      } catch (err) {
        console.error('[v0] Callback processing error:', err);
        setError('An error occurred during authentication');
        setLoading(false);
      }
    };

    handleCallback();
  }, [searchParams, router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Signing you in...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-md border border-gray-200 p-8 w-full max-w-md">
          <h1 className="text-2xl font-bold text-red-600 mb-4">Authentication Error</h1>
          <p className="text-gray-700 mb-4">{error}</p>
          <a
            href="/login"
            className="block w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg text-center transition-colors"
          >
            Back to Login
          </a>
        </div>
      </div>
    );
  }

  return null;
}
