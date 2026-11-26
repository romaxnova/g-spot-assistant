/**
 * Google OAuth 2.0 (server → Google). Two POSTs to Google's token endpoint and
 * one redirect; no client library needed. The only hosts contacted are
 * accounts.google.com and oauth2.googleapis.com.
 */

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

import { createHash, randomBytes } from 'node:crypto';

export type FetchLike = typeof fetch;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Where Google sends the user back: `${BASE_URL}/auth/google/callback`, or the relay of the server that shared its key. */
  redirectUri: string;
  /** Put before every state: tells that relay which server the sign-in belongs to ("<id>."). */
  statePrefix?: string;
}

/** PKCE (S256): the code Google returns is useless without the verifier this server kept. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface AuthUrlOptions {
  scopes: string[];
  state: string;
  /** Request a refresh token (account linking). Forces the consent screen so Google actually returns one. */
  offline: boolean;
  loginHint?: string;
  /** Google's incremental authorization: keep previously granted scopes. */
  includeGrantedScopes?: boolean;
  /** PKCE challenge (S256), from pkcePair(). */
  codeChallenge?: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  token_type?: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  exp: number;
  hd?: string;
}

export class GoogleAuthError extends Error {
  constructor(
    /** OAuth error code from Google, e.g. invalid_grant, or 'network'. */
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export class GoogleAuth {
  constructor(
    private readonly cfg: GoogleOAuthConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly tokenUrl: string = GOOGLE_TOKEN_URL,
    private readonly authUrl: string = GOOGLE_AUTH_URL,
    private readonly revokeUrl: string = GOOGLE_REVOKE_URL,
  ) {}

  buildAuthUrl(opts: AuthUrlOptions): string {
    const u = new URL(this.authUrl);
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('redirect_uri', this.cfg.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', opts.scopes.join(' '));
    u.searchParams.set('state', `${this.cfg.statePrefix ?? ''}${opts.state}`);
    if (opts.codeChallenge) {
      u.searchParams.set('code_challenge', opts.codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
    }
    if (opts.offline) {
      u.searchParams.set('access_type', 'offline');
      u.searchParams.set('prompt', 'consent');
    } else {
      u.searchParams.set('prompt', 'select_account');
    }
    if (opts.includeGrantedScopes) u.searchParams.set('include_granted_scopes', 'true');
    if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
    return u.href;
  }

  async exchangeCode(code: string, codeVerifier?: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      redirect_uri: this.cfg.redirectUri,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    });
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    });
  }

  /** Best-effort revocation at Google (used when an account is unlinked). */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GoogleAuthError('network', `Could not reach Google's token endpoint: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: string; error_description?: string };
      const code = typeof b.error === 'string' ? b.error : `http_${res.status}`;
      throw new GoogleAuthError(code, b.error_description ?? `Google token endpoint returned HTTP ${res.status}`, res.status);
    }
    const t = body as TokenResponse;
    if (!t || typeof t.access_token !== 'string') throw new GoogleAuthError('invalid_response', 'Google token response had no access_token');
    return t;
  }
}

/**
 * Decodes the payload of an ID token received directly from Google's token
 * endpoint over TLS. Google documents that signature validation is unnecessary
 * in that case; we still check issuer, audience and expiry.
 */
export function decodeIdToken(idToken: string, expectedAud: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('invalid_id_token', 'ID token is not a JWT');
  let claims: IdTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    throw new GoogleAuthError('invalid_id_token', 'ID token payload is not valid JSON');
  }
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw new GoogleAuthError('invalid_id_token', 'ID token issuer is not Google');
  }
  if (claims.aud !== expectedAud) throw new GoogleAuthError('invalid_id_token', 'ID token audience does not match this OAuth client');
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000 - 60) {
    throw new GoogleAuthError('invalid_id_token', 'ID token has expired');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new GoogleAuthError('invalid_id_token', 'ID token has no subject');
  return claims;
}
