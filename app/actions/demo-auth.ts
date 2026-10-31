// app/actions/demo-auth.ts
// Server actions for demo user authentication

'use server';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createServiceClient } from '@/lib/supabase/service';
import { DEMO_USERS, DEMO_CONFIG, AUTH_MESSAGES } from '@/app/constants/auth';

// ── TENANCY (#204) ───────────────────────────────────────────────────────────
// Demo accounts used to be provisioned WITHOUT users.brokerage_id. An
// untenanted account is a broken account here: every tenant-scoped surface and
// RLS policy keys on current_user_brokerage_id(), so the demo user saw nothing
// and could write rows no tenant reader would ever count. Demo accounts now
// land in the live demo brokerage (DEMO_CONFIG.BROKERAGE_ID, verified to exist
// before any account is created) or the flow REFUSES.
//
// WHY THE SERVICE CLIENT for provisioning: the tenant check and the users
// upsert cannot ride the just-created session — brokerages_select requires
// platform staff or `id = current_user_brokerage_id()`, and a brand-new demo
// user has no users row yet, so RLS would refuse the very read that proves the
// tenant exists. Provisioning is server-only, demo-gated (DEMO_CONFIG.ENABLED
// is hard-off in production), and stamps a fixed tenant id.

/** Verify the demo brokerage row actually exists before relying on it. */
async function verifyDemoTenant(): Promise<{ ok: true } | { ok: false; error: string }> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('brokerages')
    .select('id')
    .eq('id', DEMO_CONFIG.BROKERAGE_ID)
    .maybeSingle();
  if (error) return { ok: false, error: `Demo tenant check failed: ${error.message}` };
  if (!data) return { ok: false, error: 'Demo brokerage is not provisioned — refusing to create an untenanted demo account' };
  return { ok: true };
}

/** Upsert the canonical users row for a demo account, WITH its tenant anchor. */
async function provisionDemoProfile(
  userId: string,
  demoUser: (typeof DEMO_USERS)[number],
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Map demo role → users.user_type (CHECK-constrained); the original role
  // string is kept in the free-text role col.
  const USER_TYPE_MAP: Record<string, string> = {
    manager: 'admin',
    buyer: 'contact',
    seller: 'contact',
  };
  const userType = USER_TYPE_MAP[demoUser.role] ?? demoUser.role;

  const service = createServiceClient();
  const { error } = await service.from('users').upsert(
    {
      id: userId,
      email: demoUser.email,
      first_name: demoUser.firstName,
      last_name: demoUser.lastName,
      user_type: userType, // NOT NULL + CHECK
      role: demoUser.role, // free-text display role
      brokerage: demoUser.agency, // canonical home for "agency"
      brokerage_id: DEMO_CONFIG.BROKERAGE_ID, // TENANT ANCHOR — never null
      created_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) return { ok: false, error: `Failed to provision demo profile: ${error.message}` };
  return { ok: true };
}

/**
 * Sign in with demo user email
 */
export async function demoSignIn(userEmail: string) {
  if (!DEMO_CONFIG.ENABLED) {
    return {
      success: false,
      error: 'Demo mode is not enabled',
    };
  }

  // Find demo user
  const demoUser = DEMO_USERS.find(
    (user) => user.email.toLowerCase() === userEmail.toLowerCase()
  );

  if (!demoUser) {
    return {
      success: false,
      error: 'Demo user not found',
    };
  }

  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            cookieStore.set(name, value, options);
          },
          remove(name: string, options: any) {
            cookieStore.delete(name);
          },
        },
      }
    );

    // Try to sign in
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: demoUser.email,
      password: demoUser.password,
    });

    if (!signInError && signInData.user) {
      // Sign in successful. SELF-HEAL (#204): accounts created before the
      // tenancy fix (or whose profile write failed mid-provision) may have no
      // users row or a NULL brokerage_id. Read through the service client —
      // the session client's own users_select would hide the very row we are
      // checking if it is broken — and re-provision when untenanted. Fail
      // CLOSED: an untenanted session is the bug this flow exists to prevent,
      // so end the session rather than hand it back.
      const service = createServiceClient();
      const { data: profile, error: profileReadError } = await service
        .from('users')
        .select('id, brokerage_id')
        .eq('id', signInData.user.id)
        .maybeSingle();
      if (profileReadError) {
        await supabase.auth.signOut();
        return { success: false, error: `Demo profile check failed: ${profileReadError.message}` };
      }
      if (!profile || !profile.brokerage_id) {
        const tenant = await verifyDemoTenant();
        if (!tenant.ok) {
          await supabase.auth.signOut();
          return { success: false, error: tenant.error };
        }
        const provisioned = await provisionDemoProfile(signInData.user.id, demoUser);
        if (!provisioned.ok) {
          await supabase.auth.signOut();
          return { success: false, error: provisioned.error };
        }
      }
      return {
        success: true,
        user: {
          id: signInData.user.id,
          email: signInData.user.email,
          firstName: demoUser.firstName,
          lastName: demoUser.lastName,
          role: demoUser.role,
        },
      };
    }

    // User might not exist, try to create them
    if (signInError && signInError.message.includes('Invalid login credentials')) {
      // TENANT FIRST (#204): prove the demo brokerage exists BEFORE creating
      // the auth account — a missing tenant refuses the whole flow instead of
      // minting an account that cannot be anchored.
      const tenant = await verifyDemoTenant();
      if (!tenant.ok) {
        return { success: false, error: tenant.error };
      }

      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: demoUser.email,
        password: demoUser.password,
      });

      if (signUpError) {
        return {
          success: false,
          error: `Failed to create demo account: ${signUpError.message}`,
        };
      }

      if (!signUpData.user) {
        return {
          success: false,
          error: 'Failed to create user account',
        };
      }

      // Store demo user in the canonical users table (user_profiles is a thin
      // extension table without these columns), WITH its tenant anchor. This
      // used to console.error-and-continue on failure, which is exactly how
      // untenanted accounts were minted; now the flow fails closed (the auth
      // account is healed by the sign-in branch's self-heal on the next
      // attempt once the underlying write succeeds).
      const provisioned = await provisionDemoProfile(signUpData.user.id, demoUser);
      if (!provisioned.ok) {
        await supabase.auth.signOut();
        return { success: false, error: provisioned.error };
      }

      return {
        success: true,
        user: {
          id: signUpData.user.id,
          email: demoUser.email,
          firstName: demoUser.firstName,
          lastName: demoUser.lastName,
          role: demoUser.role,
        },
        isNewAccount: true,
      };
    }

    return {
      success: false,
      error: signInError?.message || 'Authentication failed',
    };
  } catch (error: any) {
    console.error('Demo sign in error:', error);
    return {
      success: false,
      error: error.message || AUTH_MESSAGES.SIGN_IN_ERROR,
    };
  }
}

// `demoSignOut()` REMOVED — a duplicate of `app/actions/auth.ts:signOut`, which
// is the live one (called by app/components/layout/user-menu.tsx, the portal
// user menu, and the /auth/logout route). Despite the name it was not demo
// specific: it built its own createServerClient with the deprecated
// get/set/remove cookie shape and called `supabase.auth.signOut()` — the exact
// body of the survivor, which additionally uses the shared
// `lib/supabase/server.ts` client. A demo session is a real Supabase session
// (demoSignIn below signs in with a real password), so the survivor ends it.
// Nothing was merged forward; the only difference was a success `message`
// string no caller ever read.

/**
 * Get all demo users (for demo selection UI)
 */
export async function getDemoUsers() {
  if (!DEMO_CONFIG.ENABLED) {
    return [];
  }

  return DEMO_USERS.map((user) => ({
    id: user.id,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`,
    role: user.role,
    agency: user.agency,
    specialization: user.specialization,
    state: user.state,
  }));
}

// `getDemoUsersByRole()` REMOVED — a duplicate of `getDemoUsers` above, which is
// the live one (app/auth/login/page.tsx renders its result and shows each user's
// role on the row already). It read the same DEMO_USERS constant and differed
// only by grouping — and by returning the RAW constant entries, `password`
// field included, over a `"use server"` endpoint. `getDemoUsers` projects the
// safe fields. Nothing merged forward: no surface asks for demo users grouped,
// and the login page's flat list already carries the role.
//
// `validateDemoCredentials()` REMOVED — labelled "for testing" and used by no
// test, no simulator and no surface. It compared a submitted password to the
// plaintext in the DEMO_USERS constant in application code, which answers
// nothing about whether the account can actually sign in. `demoSignIn` above is
// the real check: it calls `supabase.auth.signInWithPassword` against the demo
// account and provisions it on first use if it does not exist yet. Nothing
// merged forward — the survivor validates against the identity provider, which
// is strictly stronger than a constant-array comparison.
