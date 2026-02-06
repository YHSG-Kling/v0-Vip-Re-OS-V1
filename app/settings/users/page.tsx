'use client';

import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

export default function UsersPage() {
  const [loading, setLoading] = useState(false);

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">User Management</h1>
        <p className="text-gray-600 mt-2">Manage users, roles, and permissions</p>
      </div>

      <Card className="p-6">
        <p className="text-gray-600">User management interface will be available here.</p>
      </Card>
    </div>
  );
}
