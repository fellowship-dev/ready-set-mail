// Better Auth on D1, via its Drizzle adapter on @ready-set-mail/db.
//
//  - email + password always; GitHub / Google only when their client id + secret are set
//  - sessions, credentials and reset tokens in D1 (migration 0013)
//  - password hashing stays PBKDF2 (src/api/password.ts), so hashes from before Better Auth verify unchanged
//  - one instance per request: hooks close over the request's sign-up intent and waitUntil
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { betterAuthSchema, getDb, globalQueries } from '@ready-set-mail/db';
import { hashPassword, verifyPassword } from '../api/password';
import { baseUrl, isSaas, oauthProviders, trustedOrigins, type AuthEnv } from './config';
import { d1RateLimitStorage } from './rate-limit';
import { authSecret } from './secret';
import { cleanName } from './names';
import { rotateDeviceEpoch } from './device';
import { assertMaySignUp, provisionUser, type SignupIntent } from './signup-policy';

export const AUTH_BASE_PATH = '/api/auth';

/** 30 days, rolling. */
const SESSION_SECONDS = 30 * 24 * 3600;

export async function createAuth(
  env: AuthEnv,
  request: Request,
  opts: { intent?: SignupIntent; ctx?: Pick<ExecutionContext, 'waitUntil'>; onEmailVerified?: (user: { id: string; email: string }) => void } = {},
) {
  const intent: SignupIntent = opts.intent ?? { kind: 'external' };
  const origin = baseUrl(env, new URL(request.url).origin);
  const db = env.DB as D1Database;
  const providers = oauthProviders(env);
  const saas = isSaas(env);

  return betterAuth({
    appName: 'Ready Set Mail',
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: await authSecret(env),
    trustedOrigins: trustedOrigins(env, new URL(request.url).origin),
    database: drizzleAdapter(getDb(db), { provider: 'sqlite', schema: betterAuthSchema }),
    plugins: [bearer(), codeSessions()],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Hosted: no session until the mailbox is proven. Better Auth's own sign-in refuses an unverified account; ours
      // (src/auth/routes.ts) never opens a session before the emailed code is right.
      requireEmailVerification: saas,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },

    // Addresses are proven with a six-digit code (src/auth/codes.ts), never by a link: Better Auth sends no verification mail.
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      afterEmailVerification: async (user) => { opts.onEmailVerified?.({ id: user.id, email: user.email }); },
    },

    socialProviders: providers,

    // Accounts are linked only when both emails are verified: the local account's (so a password registered by
    // someone else for this address cannot be inherited by the real owner's Google/GitHub login) and the provider's
    // (no provider is trusted blindly).
    account: { accountLinking: { enabled: true, requireLocalEmailVerified: true, trustedProviders: [] } },

    session: { expiresIn: SESSION_SECONDS, updateAge: 24 * 3600 },

    user: { modelName: 'user' },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertMaySignUp(env, intent, user.email.toLowerCase(), user.emailVerified === true);
            // Every account's name is stored clean, whatever created it (a form, an OAuth profile).
            return { data: { ...user, name: cleanName(user.name) || user.email } };
          },
          after: async (user) => {
            await provisionUser(env, intent, { id: user.id, email: user.email.toLowerCase(), name: user.name, emailVerified: user.emailVerified === true });
          },
        },
      },
      account: {
        create: {
          // The first time an OAuth login attaches to a user, every session they already had ends: whoever held them
          // (e.g. the registrant of a password for this address) no longer has access.
          after: async (account) => {
            if (account.providerId !== 'credential') {
              await globalQueries(db).sessions.revokeAll(account.userId);
              await rotateDeviceEpoch(env, account.userId); // and its device cookies stop skipping the per-address lock
            }
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await globalQueries(db).users.touchLogin(session.userId);
          },
        },
      },
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 20 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/reset-password': { window: 3600, max: 10 },
        '/get-session': false,
      },
      customStorage: d1RateLimitStorage(db),
    },

    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The browser session cookie: HttpOnly, SameSite=Lax, and Secure whenever the dashboard is served over https.
      useSecureCookies: origin.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      backgroundTasks: opts.ctx ? { handler: (p: Promise<unknown>) => opts.ctx!.waitUntil(p) } : undefined,
    },
  });
}

/**
 * Opens a session for an account whose sign-in step was completed elsewhere (src/auth/routes.ts, after the emailed code was
 * right). Server-only: it is never on the HTTP router (no path, and SERVER_ONLY), so only code in this Worker can call it,
 * through `auth.api.startCodeSession`. Sets the same session cookie (and, through the bearer plugin, set-auth-token) as a
 * password sign-in.
 */
function codeSessions() {
  return {
    id: 'rsm-code-sessions',
    endpoints: {
      startCodeSession: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
        if (typeof userId !== 'string' || !userId) throw ctx.error('BAD_REQUEST', { message: 'userId required' });
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (!user) throw ctx.error('NOT_FOUND', { message: 'no such user' });
        const session = await ctx.context.internalAdapter.createSession(user.id, false);
        if (!session) throw ctx.error('INTERNAL_SERVER_ERROR', { message: 'could not create session' });
        await setSessionCookie(ctx, { session, user });
        return ctx.json({ user: { id: user.id, email: user.email } });
      }),
    },
  } as const;
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
