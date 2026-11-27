/**
 * A strip's size in 200-DPI pixels, whatever DPI it was rendered at.
 *
 * Most strips are rendered at 200 DPI, but a tall region is rendered lower to
 * stay under the renderer's pixel cap (about 20,000 strips sit between 137 and
 * 198 DPI). Laid out by raw pixels, a 147-DPI strip of the same 534pt column
 * came out three-quarters the width of the 200-DPI strip under it, so one part
 * of a question looked visibly smaller than the next. Every layout reads these
 * numbers, so normalising them here makes the whole question one width.
 */
export const STRIP_LAYOUT_DPI = 200;

export function stripDisplaySize(asset: {
  width: number | null;
  height: number | null;
  sourceDpi?: number | null;
}): { width: number | null; height: number | null } {
  const dpi = asset.sourceDpi && asset.sourceDpi > 0 ? asset.sourceDpi : STRIP_LAYOUT_DPI;
  const k = STRIP_LAYOUT_DPI / dpi;
  return {
    width: asset.width === null ? null : Math.round(asset.width * k),
    height: asset.height === null ? null : Math.round(asset.height * k),
  };
}
