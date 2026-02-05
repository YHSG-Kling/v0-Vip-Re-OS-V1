interface CacheEntry {
  timestamp: number;
  data: any;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class PermissionCache {
  private cache: Map<string, CacheEntry> = new Map();

  private getCacheKey(userId: string, resource: string, action: string): string {
    return `${userId}:${resource}:${action}`;
  }

  set(userId: string, resource: string, action: string, allowed: boolean): void {
    const key = this.getCacheKey(userId, resource, action);
    this.cache.set(key, {
      data: allowed,
      timestamp: Date.now(),
    });
  }

  get(userId: string, resource: string, action: string): boolean | null {
    const key = this.getCacheKey(userId, resource, action);
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  invalidate(userId?: string): void {
    if (!userId) {
      this.cache.clear();
      return;
    }

    for (const [key] of this.cache.entries()) {
      if (key.startsWith(`${userId}:`)) {
        this.cache.delete(key);
      }
    }
  }

  getStats(): { size: number; ttl: number } {
    return {
      size: this.cache.size,
      ttl: CACHE_TTL,
    };
  }
}

export const permissionCache = new PermissionCache();
