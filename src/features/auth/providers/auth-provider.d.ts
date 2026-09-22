import { type ReactNode } from 'react';
import type { User as AuthUser } from '@supabase/supabase-js';
import type { CompanyRow, RoleRow, UserRow } from '@/lib/supabase/database.types';
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
interface AuthProviderProps {
    children: ReactNode;
}
export declare function AuthProvider({ children }: AuthProviderProps): import("react").JSX.Element;
export declare function useAuth(): AuthContextValue;
export default AuthProvider;
//# sourceMappingURL=auth-provider.d.ts.map