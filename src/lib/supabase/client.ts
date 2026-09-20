import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

export type TypedSupabaseClient = SupabaseClient<Database>;

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error(
    'VITE_SUPABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
  );
}

if (!supabaseAnonKey) {
  throw new Error(
    'VITE_SUPABASE_ANON_KEY is not set. Copy .env.example to .env.local and fill it in.',
  );
}

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
 */
export const supabase: TypedSupabaseClient = createClient<Database>(
  supabaseUrl,
  supabaseAnonKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Required for the Supabase email-confirmation and password-reset
      // redirects to resolve the session from the URL fragment.
      detectSessionInUrl: true,
      storageKey: 'swiftworks.auth',
      flowType: 'pkce',
    },
    global: {
      headers: {
        'x-application-name': 'swiftworks-web',
      },
    },
    db: {
      schema: 'public',
    },
    realtime: {
      params: {
        eventsPerSecond: 5,
      },
    },
  },
);

/** Thrown by query helpers so callers can branch on status vs message. */
export class SupabaseError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Unwraps a PostgREST response, converting the error envelope into a
 * SupabaseError. RPC functions in Phase 5 raise with codes like
 * 'slot_full', 'unit_already_booked' and 'rate_limited' — those arrive in
 * `error.message` and are matched by the booking UI.
 */
export function unwrap<T>(response: {
  data: T | null;
  error: { message: string; code?: string } | null;
}): T {
  if (response.error) {
    throw new SupabaseError(
      response.error.message,
      undefined,
      response.error.code,
    );
  }
  if (response.data === null) {
    throw new SupabaseError('No data returned');
  }
  return response.data;
}
