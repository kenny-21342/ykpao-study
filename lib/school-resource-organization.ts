/** A deterministic destination for legacy resources that never had a folder. */
export function legacyResourceFolderPath(resource: {
  subject: string | null;
  category: string | null;
  createdAt: Date;
}): string {
  const segment = (value: string | null, fallback: string) => {
    const clean = value?.replace(/[\\/\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return clean && clean !== '.' && clean !== '..' ? clean : fallback;
  };
  const year = String(resource.createdAt.getUTCFullYear());
  const month = String(resource.createdAt.getUTCMonth() + 1).padStart(2, '0');
  return [segment(resource.subject, 'Unsorted'), segment(resource.category, 'General'), year, month].join('/');
}
