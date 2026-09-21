import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session, User as AuthUser } from '@supabase/supabase-js';

import { supabase, SupabaseError } from '@/lib/supabase/client';
import type {
  CompanyRow,
  RoleRow,
  UserRow,
} from '@/lib/supabase/database.types';

// =============================================================================
// Types
// =============================================================================

export interface AuthContextValue {
  /** Supabase auth identity. Null when signed out. */
  authUser: AuthUser | null;

  /** Application profile row from public.users. Null until loaded. */
  user: UserRow | null;

  /** Tenant row from public.companies. Null for platform admins without one. */
  company: CompanyRow | null;

  /** Roles assigned to this user, with their permission arrays flattened. */
  roles: RoleRow[];

  /** Flattened permission strings across all of the user's roles. */
  permissions: string[];

  /** True while the initial session and profile are still resolving. */
  isLoading: boolean;

  /** Set when profile loading failed. Cleared on the next successful load. */
  error: Error | null;

  /** Whether the caller holds a permission. Supports '*' and 'prefix.*'. */
  hasPermission: (permission: string) => boolean;

  /** Whether the caller holds any of the supplied role codes. */
  hasRole: (code: string) => boolean;

  /** Refresh profile, company, roles and permissions from the database. */
  refresh: () => Promise<void>;

  /** Sign out and clear all cached identity. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// =============================================================================
// Permission matching
// =============================================================================
// Mirrors app.has_permission() in the database: '*' grants everything,
// 'jobs.*' grants every jobs.<action>. Kept identical so the UI and the RLS
// policies never disagree about what a user may do.
function permissionMatches(granted: string, required: string): boolean {
  if (granted === '*') return true;
  if (granted === required) return true;

  const family = `${required.split('.')[0]}.*`;
  return granted === family;
}

// =============================================================================
// Provider
// =============================================================================

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [user, setUser] = useState<UserRow | null>(null);
  const [company, setCompany] = useState<CompanyRow | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Guards against a stale profile fetch landing after sign-out, and against
  // the StrictMode double-invoke in development.
  const requestIdRef = useRef(0);

  /**
   * Loads the profile, tenant and roles for a given auth user.
   *
   * public.users, public.companies and public.roles are all under RLS
   * (Phase 4), so these selects return only what the caller is allowed to
   * see — no company_id filter is needed or wanted here.
   */
  const loadProfile = useCallback(async (id: string) => {
    const requestId = ++requestIdRef.current;

    try {
      setError(null);

      const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('*')
        .eq('id', id)
        .maybeSingle();

      if (profileError) throw profileError;

      // The handle_new_user() trigger from Phase 3 creates this row on
      // invitation acceptance. Its absence means the user authenticated but
      // never completed onboarding.
      if (!profile) {
        throw new SupabaseError(
          'No SwiftWorks profile found for this account. Check your invitation email.',
          404,
          'profile_missing',
        );
      }

      if (requestId !== requestIdRef.current) return;

      const profileRow = profile as unknown as UserRow;
      setUser(profileRow);

      // Platform admins may legitimately have no tenant.
      if (profileRow.company_id) {
        const { data: companyRow, error: companyError } = await supabase
          .from('companies')
          .select('*')
          .eq('id', profileRow.company_id)
          .maybeSingle();

        if (companyError) throw companyError;
        if (requestId !== requestIdRef.current) return;
        setCompany((companyRow as unknown as CompanyRow) ?? null);
      } else {
        setCompany(null);
      }
      // user_roles carries the role ids; roles carries the permission arrays.
      // The row shape is asserted here because the cast client cannot infer it
      // from the select string — see the note in lib/supabase/client.ts.
      type UserRoleAssignment = {
        role_id: string;
        expires_at: string | null;
      };
      const { data: assignments, error: assignmentError } = (await supabase
        .from('user_roles')
        .select('role_id, expires_at')
        .eq('user_id', id)
        .is('deleted_at', null)) as {
        data: UserRoleAssignment[] | null;
        error: { message: string } | null;
      };
    if (assignmentError) throw assignmentError;
if (requestId !== requestIdRef.current) return;

const now = Date.now();

const typedAssignments =
  (assignments ?? []) as UserRoleAssignment[];

const roleIds = typedAssignments
  .filter(
    (a) =>
      !a.expires_at ||
      new Date(a.expires_at).getTime() > now,
  )
  .map((a) => a.role_id);

if (roleIds.length === 0) {
  setRoles([]);
  return;
}
      const { data: roleRows, error: roleError } = await supabase
        .from('roles')
        .select('*')
        .in('id', roleIds)
        .is('deleted_at', null);
      if (roleError) throw roleError;
      if (requestId !== requestIdRef.current) return;
      setRoles((roleRows as unknown as RoleRow[]) ?? []);
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      // A failed load must not leave a half-populated identity behind.
      setUser(null);
      setCompany(null);
      setRoles([]);
      setError(
        caught instanceof Error
          ? caught
          : new Error('Failed to load your workspace'),
      );
    }
  }, []);
  /** Clears every identity field. Used by sign-out and session loss. */
  const clearIdentity = useCallback(() => {
    requestIdRef.current += 1;
    setUser(null);
    setCompany(null);
    setRoles([]);
    setError(null);
  }, []);
  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) {
      await loadProfile(data.user.id);
    }
  }, [loadProfile]);
  const signOut = useCallback(async () => {
    clearIdentity();
    setAuthUser(null);
    await supabase.auth.signOut();
  }, [clearIdentity]);
  // ---------------------------------------------------------------------------
  // Session bootstrap and change subscription
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function bootstrap() {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (cancelled) return;
      if (sessionError) {
        setError(sessionError);
        setIsLoading(false);
        return;
      }
      const session: Session | null = data.session;
      setAuthUser(session?.user ?? null);

      if (session?.user) {
        await loadProfile(session.user.id);
      }
      if (!cancelled) setIsLoading(false);
    }
    void bootstrap();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // Defer to a microtask: Supabase invokes this callback from inside its
      // own token-refresh lock, and awaiting a query here deadlocks the client.
      queueMicrotask(() => {
        if (cancelled) return;
        setAuthUser(session?.user ?? null);
        if (event === 'SIGNED_OUT' || !session?.user) {
          clearIdentity();
          setIsLoading(false);
          return;
        }
        // TOKEN_REFRESHED fires on a timer; the profile has not changed, so
        // there is nothing to reload.
        if (event === 'TOKEN_REFRESHED') return;

        void loadProfile(session.user.id).finally(() => setIsLoading(false));
      });
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadProfile, clearIdentity]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------
  const permissions = useMemo(() => {
    const set = new Set<string>();
    for (const role of roles) {
      if (!Array.isArray(role.permissions)) continue;
      for (const permission of role.permissions) set.add(permission);
    }
    return Array.from(set).sort();
  }, [roles]);
  const hasPermission = useCallback(
    (permission: string) => {
      // Platform admins bypass every tenant check, matching
      // app.is_platform_admin() in the database.
      if (user?.is_platform_admin) return true;
      return permissions.some((granted) =>
        permissionMatches(granted, permission),
      );
    },
    [permissions, user?.is_platform_admin],
  );

  const hasRole = useCallback(
    (code: string) => roles.some((role) => role.code === code),
    [roles],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      authUser,
      user,
      company,
      roles,
      permissions,
      isLoading,
      error,
      hasPermission,
      hasRole,
      refresh,
      signOut,
    }),
    [
      authUser,
      user,
      company,
      roles,
      permissions,
      isLoading,
      error,
      hasPermission,
      hasRole,
      refresh,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// =============================================================================
// Hook
// =============================================================================

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context === null) {
    throw new Error(
      'useAuth must be used inside <AuthProvider>. Wrap the route tree in App.tsx.',
    );
  }

  return context;
}

export default AuthProvider;
