import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role?: string
      /**
       * Credential fingerprint: an HMAC of the password hash this session was
       * issued against, used by getSessionUser() to revoke sessions after a
       * password reset. Opaque without NEXTAUTH_SECRET.
       */
      cfp?: string
    } & DefaultSession["user"]
  }

  interface User {
    id: string
    role?: string
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string
    role?: string
    /** See Session["user"].cfp. */
    cfp?: string
  }
}
