/**
 * send-invitation
 * ---------------------------------------------------------------------------
 * Delivers the invitation email for a row in public.user_invitations.
 *
 * Called from the Users page straight after invite_user() succeeds:
 *
 *   await supabase.functions.invoke('send-invitation', { body: { token } });
 *
 * Existing callers may still pass email/role/company fields. Those fields are
 * deliberately ignored: only the authorized database record supplies them.
 *
 * Deploy:
 *   supabase functions deploy send-invitation
 *   supabase secrets set RESEND_API_KEY=re_... APP_URL=[your-app](https://your-app)
 *   supabase secrets set INVITE_FROM="SwiftWorks <invites@yourdomain.com>"
 */

import { Resend } from "npm:resend";
import { createClient } from "npm:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const APP_URL = (Deno.env.get('APP_URL') ?? '').replace(/\/+$/, '');
const INVITE_FROM =
  Deno.env.get('INVITE_FROM') ?? 'SwiftWorks <onboarding@resend.dev>';

/** Roles this app knows how to name in an email. */
const ROLE_LABELS: Record<string, string> = {
  owner: 'an owner',
  admin: 'an administrator',
  company_admin: 'an administrator',
  technician: 'a technician',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** 2026-10-17T04:00:00Z or 2026-10-17 -> 17 October 2026 (Sydney). */
function formatExpiry(value: string | null | undefined): string | null {
  if (!value) return null;

  const d = new Date(value.includes('T') ? value : value + 'T23:59:59Z');
  if (Number.isNaN(d.getTime())) return null;

  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Australia/Sydney',
  }).format(d);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(args: {
  link: string;
  company: string;
  role: string;
  expires: string | null;
}) {
  const { link, company, role, expires } = args;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
      <tr>
        <td style="padding:28px 28px 8px;">
          <p style="margin:0;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;">SwiftWorks</p>
          <h1 style="margin:8px 0 0;font-size:20px;line-height:1.3;">You have been invited to ${escapeHtml(company)}</h1>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 28px 0;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
            You have been added to <strong>${escapeHtml(company)}</strong> as ${escapeHtml(role)}.
            Choose a password to finish setting up your account.
          </p>
          <p style="margin:0 0 24px;">
            <a href="${link}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;">Accept invitation</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#6b7280;">
            Or paste this link into your browser:<br />
            <span style="word-break:break-all;color:#374151;">${link}</span>
          </p>
          ${
            expires
              ? `<p style="margin:16px 0 0;font-size:13px;color:#6b7280;">This invitation expires on <strong>${escapeHtml(expires)}</strong>.</p>`
              : ''
          }
        </td>
      </tr>
      <tr>
        <td style="padding:24px 28px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af;">
            If you were not expecting this, you can ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildText(args: {
  link: string;
  company: string;
  role: string;
  expires: string | null;
}) {
  const { link, company, role, expires } = args;

  return [
    `You have been invited to ${company}`,
    '',
    `You have been added to ${company} as ${role}.`,
    'Choose a password to finish setting up your account:',
    '',
    link,
    '',
    expires ? `This invitation expires on ${expires}.` : '',
    'If you were not expecting this, you can ignore this email.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const authorization = req.headers.get('authorization');
  if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
    return json({ error: 'Authentication required.' }, 401);
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ error: 'Invitation delivery is unavailable.' }, 503);
  }

  try {
    // Never create a service-role client here. getUser validates the bearer
    // token with Auth; the RPC runs with this caller's verified session.
    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: identity, error: identityError } = await client.auth.getUser();
    if (identityError || !identity.user) {
      return json({ error: 'Authentication required.' }, 401);
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: 'Expected a JSON body.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'An invitation token is required.' }, 400);
    }
    const tokenValue = (payload as { token?: unknown }).token;
    if (typeof tokenValue !== 'string' ||
        tokenValue.trim() === '' || tokenValue.length > 256) {
      return json({ error: 'An invitation token is required.' }, 400);
    }

    const { data: invitations, error: invitationError } = await client.rpc(
      'invitation_for_delivery',
      { p_token: tokenValue.trim() },
    );
    if (invitationError || !Array.isArray(invitations) ||
        invitations.length !== 1) {
      return json({ error: 'Invitation delivery forbidden.' }, 403);
    }

    const invitation = invitations[0] as {
      email: string; token: string; role_code: string;
      company_name: string; expires_at: string;
    };
    if (!RESEND_API_KEY || !APP_URL) {
      return json({ error: 'Invitation delivery is unavailable.' }, 503);
    }

    const role = ROLE_LABELS[invitation.role_code] ??
      invitation.role_code.replace(/_/g, ' ');
    const link = `${APP_URL}/invite/${encodeURIComponent(invitation.token)}`;
    const expires = formatExpiry(invitation.expires_at);
    const company = invitation.company_name;

    const resend = new Resend(RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
      from: INVITE_FROM,
      to: invitation.email,
      subject: `You have been invited to ${company}`,
      html: buildHtml({ link, company, role, expires }),
      text: buildText({ link, company, role, expires }),
    });

    if (error) {
      return json({ error: 'The invitation email was not sent.' }, 502);
    }

    return json({ ok: true, id: data?.id ?? null, to: invitation.email });
  } catch {
    // Do not return provider errors, bearer tokens or database internals.
    return json({ error: 'Invitation delivery is unavailable.' }, 503);
  }
}

Deno.serve(handleRequest);
