import { cn } from './cn';

/**
 * Who contributed a file or folder to the shared library.
 *
 * Any signed-in student can upload here, which is the point: the library is
 * the year group's, not the staff's. Attribution is what makes that safe to
 * read -- before this, a file's uploader column fell back to the literal
 * string "Staff", so a classmate's revision notes were presented as though
 * the school had issued them.
 *
 * A missing contributor renders as nothing, not as a placeholder name. Every
 * folder created before attribution shipped has no true answer (see
 * prisma/migrations/20260928080000_school_resource_folder_creator), and a
 * guess in this particular spot is worse than a blank: it tells a student the
 * wrong person stands behind the work.
 */
export type ContributorUser = { id: string; name: string | null; image: string | null };

function initials(name: string | null): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

export function Contributor({
  user,
  label,
  className,
}: {
  user: ContributorUser | null | undefined;
  /** Optional lead-in, e.g. "Added by". Omitted in dense table cells. */
  label?: string;
  className?: string;
}) {
  if (!user) return null;

  // A signed-in account with no display name is real and common (an OAuth
  // profile can arrive without one), so it gets the neutral noun rather than
  // being dropped -- someone did contribute this.
  const name = user.name?.trim() || 'A contributor';

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span
        aria-hidden="true"
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent text-[9px] font-semibold text-white"
      >
        {user.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.image} alt="" className="h-full w-full object-cover" />
        ) : (
          initials(user.name)
        )}
      </span>
      <span className="truncate">
        {label ? <span className="text-muted">{label} </span> : null}
        {name}
      </span>
    </span>
  );
}
