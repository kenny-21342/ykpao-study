import { POST } from '../signup/route';

/**
 * /api/auth/register is an alias for /api/auth/signup. The canonical
 * implementation lives in signup/route.ts; this file exists for backward
 * compatibility with older clients that POST to /api/auth/register.
 */
export { POST };
