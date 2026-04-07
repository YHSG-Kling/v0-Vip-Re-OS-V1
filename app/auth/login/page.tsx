// app/(auth)/login/page.tsx or app/auth/login/page.tsx

'use client';

import { demoSignIn, getDemoUsers } from '@/app/actions/demo-auth';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

export default function LoginPage() {
  const [demoUsers, setDemoUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    getDemoUsers().then(setDemoUsers);
  }, []);

  const handleDemoLogin = async (email: string) => {
    setLoading(true);
    const result = await demoSignIn(email);
    setLoading(false);

    if (result.success) {
      router.push('/dashboard');
    } else {
      toast.error(result.error);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-4">
      <h1>VIP Agents Real Estate OS - Demo Login</h1>
      
      <div className="grid gap-2 mt-4">
        {demoUsers.map((user) => (
          <button
            key={user.email}
            onClick={() => handleDemoLogin(user.email)}
            disabled={loading}
            className="p-3 border rounded text-left hover:bg-gray-100"
          >
            <div className="font-medium">{user.name}</div>
            <div className="text-sm text-gray-600">{user.email} • {user.role}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
