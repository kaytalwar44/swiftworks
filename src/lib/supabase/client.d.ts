import { type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
export type TypedSupabaseClient = SupabaseClient<Database>;
/**
 * Single browser client for the whole app.
 *
 * Only the anon key belongs here. It is public by design and RLS is what
 * actually protects the data — the deployed Phase 4 policies gate every table
 * on app.current_company_id(), so this client can only ever see the signed-in
 * user's tenant.
 *
 * Never put the service-role key in frontend code: it bypasses RLS entirely
 * and would expose every tenant.
 *
 * The generic is applied via `as` rather than `createClient<Database>(...)`.
 * The generated-schema slot on createClient is constrained by the library's
 * internal DatabaseWithoutInternals shape, which a hand-written Database
 * interface does not satisfy. Casting the result keeps `supabase` fully typed
 * for consumers while leaving the call itself inference-driven.
 *
 * Regenerating with `supabase gen types typescript --linked` produces a shape
 * the generic accepts natively, at which point the cast can move back inline.
 */
export declare const supabase: TypedSupabaseClient;
/** Thrown by query helpers so callers can branch on status vs message. */
export declare class SupabaseError extends Error {
    readonly status?: number;
    readonly code?: string;
    constructor(message: string, status?: number, code?: string);
}
/**
 * Unwraps a PostgREST response, converting the error envelope into a
 * SupabaseError. RPC functions in Phase 5 raise with codes like
 * 'slot_full', 'unit_already_booked' and 'rate_limited' — those arrive in
 * `error.message` and are matched by the booking UI.
 */
export declare function unwrap<T>(response: {
    data: T | null;
    error: {
        message: string;
        code?: string;
    } | null;
}): T;
//# sourceMappingURL=client.d.ts.map