import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcrypt';

export const dynamic = 'force-dynamic';

// GET /api/account — current user's profile (for the app shell to read
// bgImage and other display fields without going through the session JWT).
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        bgImage: user.bgImage,
        // Explicit, rather than letting the client infer "OAuth user" from
        // "has an avatar and no password field" — that guess told every
        // credentials user who uploaded a profile picture that they could not
        // change their password.
        hasPassword: Boolean(user.password),
      },
    });
  } catch (error) {
    console.error('Failed to fetch account:', error);
    return NextResponse.json({ error: 'Failed to fetch account' }, { status: 500 });
  }
}

// PATCH /api/account — update profile name or change password
export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { name, image, bgImage, currentPassword, newPassword } = body as {
      name?: string;
      image?: string;
      bgImage?: string;
      currentPassword?: string;
      newPassword?: string;
    };

    // Update name + avatar + background image (can be sent together)
    if (name !== undefined || image !== undefined || bgImage !== undefined) {
      const data: { name?: string; image?: string | null; bgImage?: string | null } = {};
      if (name !== undefined) {
        if (!name.trim()) {
          return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 });
        }
        data.name = name.trim();
      }
      // Validate that image/bgImage point to our own uploads dir (prevent
      // storing arbitrary external URLs).
      if (image !== undefined) {
        if (image && (!image.startsWith('/uploads/') || image.includes('..'))) {
          return NextResponse.json({ error: 'Invalid image URL' }, { status: 400 });
        }
        data.image = image || null;
      }
      if (bgImage !== undefined) {
        if (bgImage && (!bgImage.startsWith('/uploads/') || bgImage.includes('..'))) {
          return NextResponse.json({ error: 'Invalid background image URL' }, { status: 400 });
        }
        data.bgImage = bgImage || null;
      }
      await prisma.user.update({ where: { id: user.id }, data });
      return NextResponse.json({ ok: true, user: { ...data } });
    }

    // Change password — currentPassword is ALWAYS required to prevent
    // privilege escalation via a stale session on a shared device.
    if (newPassword) {
      if (newPassword.length < 6) {
        return NextResponse.json(
          { error: 'Password must be at least 6 characters' },
          { status: 400 }
        );
      }

      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!dbUser?.password) {
        return NextResponse.json(
          { error: 'Password change not available for OAuth accounts' },
          { status: 400 }
        );
      }

      if (!currentPassword) {
        return NextResponse.json(
          { error: 'Current password is required' },
          { status: 400 }
        );
      }

      const valid = await bcrypt.compare(currentPassword, dbUser.password);
      if (!valid) {
        return NextResponse.json({ error: 'Current password is incorrect' }, { status: 400 });
      }

      const hashed = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashed },
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  } catch (error) {
    console.error('Failed to update account:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update account' },
      { status: 500 }
    );
  }
}
