import { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: {
      id: string
      role?: string
      /**
       * Whether this user is an administrator / may moderate community
       * content. Resolved server-side in the session callback: admin can come
       * from the ADMIN_EMAILS allowlist rather than the role column, so `role`
       * alone is not enough to answer either question. Clients must read these
       * rather than compare `role` themselves.
       */
      isAdmin?: boolean
      canModerate?: boolean
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
