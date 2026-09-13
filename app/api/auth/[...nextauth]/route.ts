import NextAuth from "next-auth"
import type { NextAuthOptions } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import GoogleProvider from "next-auth/providers/google"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/prisma"
import { credentialFingerprint } from "@/lib/password-reset"
import { isAdminUser, isModerator } from "@/lib/roles"
import { strictLimiter } from "@/lib/rate-limit"
import bcrypt from "bcrypt"

// NextAuth v4 otherwise falls back to NEXTAUTH_URL (or localhost:3000).
// Trust the request host only in development so alternate local ports work;
// production must use its canonical NEXTAUTH_URL.
if (process.env.NODE_ENV === "development") {
  process.env.AUTH_TRUST_HOST = "true"
}

const authSecret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET

// Without a secret NextAuth v4 falls back to an insecure development default,
// so every session token it issues in production would be forgeable. Refuse to
// start rather than serve traffic in that state.
if (process.env.NODE_ENV === "production" && !authSecret) {
  throw new Error(
    "NEXTAUTH_SECRET (or AUTH_SECRET) must be set in production. Generate one with: openssl rand -base64 32",
  )
}

/**
 * Only register an OAuth provider when it is actually configured.
 *
 * Registering unconditionally with `|| ""` meant every provider button
 * rendered on the login page whether or not it could work, and clicking an
 * unconfigured one took the student to a provider error page with no
 * explanation. The login page reads the enabled list from
 * /api/auth/providers so it only renders buttons that can succeed.
 */
const googleConfig =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }
    : null

// `httpOptions` is a valid next-auth runtime option that is missing from the
// v4 type defs, hence the final cast.
export const authOptions = {
  adapter: PrismaAdapter(prisma) as unknown as NonNullable<NextAuthOptions['adapter']>,
  // Secret for JWT signing/encryption. In production this MUST be set via
  // NEXTAUTH_SECRET (see .env.example).
  secret: authSecret,
  // Increase HTTP timeout for OAuth token exchange (default 3500ms is too
  // short — causes "outgoing request timed out" on slow connections).
  httpOptions: {
    timeout: 15000,
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) {
          return null
        }

        // Throttle before the database lookup and before bcrypt, which is
        // deliberately slow and is the expensive half of an attempt.
        //
        // Both keys are always checked, and neither depends on whether the
        // account exists, so this cannot be used to enumerate addresses. The
        // per-IP key stops one host spraying many accounts; the per-account
        // key stops a distributed attack converging on one account, which the
        // IP key alone would miss entirely.
        const ip = String(req?.headers?.["x-forwarded-for"] ?? "unknown")
          .split(",")[0]
          .trim()
        const normalisedEmail = credentials.email.trim().toLowerCase()
        const [ipAllowed, accountAllowed] = await Promise.all([
          strictLimiter.check(`login-ip:${ip}`),
          strictLimiter.check(`login-email:${normalisedEmail}`),
        ])
        if (!ipAllowed || !accountAllowed) {
          // Distinguishable from a bad password on purpose: a locked-out
          // student needs to know waiting will help. `signIn` surfaces this
          // as `result.error`, which the login page maps to a message.
          throw new Error("RateLimited")
        }

        // Signup stores addresses lowercased, so the lookup must be
        // case-insensitive too — otherwise anyone who types "Alice@school.org"
        // instead of "alice@school.org" is told their password is wrong.
        // `mode: 'insensitive'` (rather than `.toLowerCase()`) also matches
        // legacy rows created before normalisation was in place.
        const user = await prisma.user.findFirst({
          where: { email: { equals: credentials.email.trim(), mode: 'insensitive' } }
        })

        if (!user || !user.password) {
          return null
        }

        // A banned user must not be able to obtain a fresh session.
        if (user.banned) {
          return null
        }

        const isPasswordValid = await bcrypt.compare(
          credentials.password,
          user.password
        )

        if (!isPasswordValid) {
          return null
        }

        // An unconfirmed address gets no session.
        //
        // Deliberately AFTER the password check, not before. Answering earlier
        // would tell anyone who typed an address whether it has an account
        // awaiting confirmation; placed here, the distinct error only ever
        // reaches someone who already holds the correct password -- and that
        // person needs to be sent to their inbox, not told their password is
        // wrong.
        //
        // Everyone who existed when this shipped was stamped verified by
        // prisma/migrations/20260913120000_grandfather_email_verification, so
        // this can only fire for an account created after it. The gate lives
        // here rather than in `getSessionUser` because Google accounts arrive
        // through the adapter, which does not stamp this column -- gating on
        // read would lock every OAuth user out of an address Google itself
        // verified. The jwt callback below stamps them instead.
        if (!user.emailVerified) {
          throw new Error("EmailUnverified")
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        }
      }
    }),
    ...(googleConfig ? [GoogleProvider(googleConfig)] : []),
  ],
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/auth/login",
    error: "/auth/login",
  },
  callbacks: {
    // On OAuth sign-in, the PrismaAdapter creates/links the user in the DB.
    // We need to resolve the actual DB user id from the email so the JWT
    // carries the correct id (not the provider's internal id).
    async jwt({ token, user, account, trigger }) {
      // First sign-in with OAuth provider
      if (account && user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email },
        })
        if (dbUser) {
          token.id = dbUser.id
          token.name = dbUser.name
          token.email = dbUser.email
          token.picture = dbUser.image
          token.role = dbUser.role

          // The provider has already verified this address -- that is what
          // signing in with Google means -- but the PrismaAdapter's default
          // profile mapping never writes the column, so an OAuth account sits
          // at null forever. Stamp it, so `emailVerified` means the same thing
          // for every row and a future check that reads it cannot quietly lock
          // out every Google user.
          if (!dbUser.emailVerified) {
            await prisma.user.update({
              where: { id: dbUser.id },
              data: { emailVerified: new Date() },
            })
          }
        }
      } else if (user?.id) {
        // Credentials sign-in — id comes from authorize
        token.id = user.id
        // For credentials sign-in, resolve role from DB.
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { role: true },
        })
        token.role = dbUser?.role ?? 'student'
      }

      // On a session update (e.g. client calls update() after editing
      // profile), re-read the latest user from the DB so the token carries
      // fresh name/email/image instead of the stale sign-in snapshot.
      if (trigger === 'update' && token.id) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
        })
        if (dbUser) {
          token.name = dbUser.name
          token.email = dbUser.email
          token.picture = dbUser.image
          token.role = dbUser.role
        }
      }

      // Bind this token to the password it was issued against, so a password
      // reset invalidates it. lib/password-reset.ts explains why this and not
      // the token's own `iat` (NextAuth re-issues `iat` on every session read,
      // so a stolen cookie would refresh itself past any cutoff).
      //
      // Only filled in when ABSENT: on first sign-in, and once for tokens
      // issued before this existed. It is deliberately never refreshed for a
      // token that already has one — a *stale* fingerprint is precisely the
      // signal getSessionUser() checks, and re-deriving it here would let any
      // stolen session heal itself by calling update().
      if (token.cfp === undefined && token.id) {
        const cred = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { password: true },
        })
        token.cfp = credentialFingerprint(cred?.password)
      }

      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        // Propagate the (potentially refreshed) profile fields from the
        // JWT into the session so the client sees the latest values.
        session.user.name = (token.name as string | undefined) ?? session.user.name
        session.user.email = (token.email as string | undefined) ?? session.user.email
        session.user.image = (token.picture as string | undefined) ?? session.user.image
        session.user.role = (token.role as string | undefined) ?? 'student'
        // Resolve authority here rather than letting clients infer it from
        // `role`. Admin can come from the ADMIN_EMAILS allowlist instead of the
        // role column, so a bootstrap admin's role reads 'student' and every
        // `role === 'admin'` check in the UI was false for someone the server
        // treats as a full admin -- the admin console link and all moderation
        // controls were hidden from them.
        const bearer = { role: session.user.role, email: session.user.email }
        session.user.isAdmin = isAdminUser(bearer)
        session.user.canModerate = isModerator(bearer)
        // Opaque (HMAC-keyed) — carried so getSessionUser() can reject a
        // session issued against a password that has since been changed.
        session.user.cfp = token.cfp as string | undefined
      }
      return session
    }
  },
  debug: process.env.NODE_ENV === 'development',
} as NextAuthOptions

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
