import type { ReactNode } from 'react';

/**
 * The page frame for tabs that fill the whole workspace (Study, Materials).
 *
 * Practice, Mock Exams and Discussions sit in a centred column and leave the
 * margins to the app background, which a student can set to a photo. Study and
 * Materials used to paint a solid full-width page over it, so the photo
 * appeared on some tabs and vanished on others. This keeps the same centred
 * column and puts the whole screen on one solid sheet, so the photo frames it
 * and the text on it stays readable whatever the image is.
 */
export default function PageSheet({ children }: { children: ReactNode }) {
  return (
    <div className="h-full p-2 sm:p-4">
      <div className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-lg border border-line bg-surface-raised">
        {children}
      </div>
    </div>
  );
}
