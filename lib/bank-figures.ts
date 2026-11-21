import { bankAssetKey } from './storage/keys.ts';

/**
 * Replace the transcription's `![](asset:figN)` placeholders with real images.
 *
 * A placeholder with no asset is dropped rather than left as visible markup; the
 * `bankAssetKey` check means only a content-addressed bank asset can ever be
 * linked, whatever the stored text says.
 */
export function withFigures(
  bodyMd: string,
  assets: Array<{ placeholder: string; asset: { sha256: string; width: number | null; height: number | null } }>,
): string {
  const byName = new Map(assets.map((row) => [row.placeholder, row.asset]));
  return bodyMd.replace(/!\[[^\]]*\]\(asset:([a-z0-9_-]+)\)/gi, (_match, name: string) => {
    const asset = byName.get(name);
    const key = asset ? bankAssetKey(asset.sha256) : null;
    if (!asset || !key) return '';
    const size = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : '';
    return `<img src="/${key}" alt="Figure"${size} loading="lazy" class="question-figure paper-ground">`;
  });
}
