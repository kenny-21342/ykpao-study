import NextAuth from "next-auth"
import type { NextAuthOptions } from "next-auth"
import CredentialsProvider from "next-auth/providers/credentials"
import GoogleProvider from "next-auth/providers/google"
import GitHubProvider from "next-auth/providers/github"
import AzureADProvider from "next-auth/providers/azure-ad"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { prisma } from "@/lib/prisma"
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

const azureConfig =
  process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_CLIENT_SECRET
    ? {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
        tenantId: process.env.AZURE_AD_TENANT_ID || "common",
      }
    : null

const githubConfig =
  process.env.GITHUB_ID && process.env.GITHUB_SECRET
    ? {
        clientId: process.env.GITHUB_ID,
        clientSecret: process.env.GITHUB_SECRET,
      }
    : null

// `httpOptions` is a valid next-auth runtime option that is missing from the
// v4 type defs, hence the final cast.
export const authOptions = {
  adapter: PrismaAdapter(prisma) as any,
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null
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

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        }
      }
    }),
    ...(googleConfig ? [GoogleProvider(googleConfig)] : []),
    ...(azureConfig ? [AzureADProvider(azureConfig)] : []),
    ...(githubConfig ? [GitHubProvider(githubConfig)] : []),
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
      }
      return session
    }
  },
  debug: process.env.NODE_ENV === 'development',
} as NextAuthOptions

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
