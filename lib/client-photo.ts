/**
 * Browser-side helper: turn a chosen photo into a JPEG data URL small enough to
 * send to the handwriting reader.
 *
 * A phone photo is 3-12 MB and several thousand pixels wide; the reader needs
 * legible handwriting, not that. Shrinking the longest edge and re-encoding
 * keeps the upload to a few hundred KB. Orientation is applied by the browser
 * when it draws the image, so a sideways-held phone is not sent sideways.
 */
export async function photoToDataUrl(file: File, maxEdge = 1600, quality = 0.85): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that photo.'));
      el.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot process photos.');
    // White behind transparent PNGs, which JPEG would otherwise turn black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
