/**
 * Just enough XML reading and writing for the S3 responses this app sees.
 *
 * A full XML parser would be a dependency for a handful of well-known, flat
 * response shapes. What is handled here is ListObjectsV2 (`<Key>`,
 * `<IsTruncated>`, `<NextContinuationToken>`), the multipart-upload handshake
 * (`<UploadId>`, and the `<CompleteMultipartUpload>` document sent back), and
 * S3's `<Error>` envelope; anything else in a document is ignored.
 */

export type S3Error = {
  code?: string;
  message?: string;
};

export type ListObjectsResult = {
  keys: string[];
  isTruncated: boolean;
  nextContinuationToken?: string;
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity] ?? entity);
}

function firstTagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeEntities(match[1]) : undefined;
}

function allTagText(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    values.push(decodeEntities(match[1]));
  }
  return values;
}

/** Escape a value for inclusion in an XML text node. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const XMLParser = {
  parseListObjects(xml: string): ListObjectsResult {
    // `<Key>` appears inside `<Contents>` entries only; `<CommonPrefixes>` uses
    // `<Prefix>`, so a plain scan for `<Key>` is unambiguous here.
    return {
      keys: allTagText(xml, 'Key'),
      isTruncated: firstTagText(xml, 'IsTruncated')?.trim() === 'true',
      nextContinuationToken: firstTagText(xml, 'NextContinuationToken'),
    };
  },

  /** The `UploadId` from a CreateMultipartUpload response, if present. */
  parseUploadId(xml: string): string | undefined {
    return firstTagText(xml, 'UploadId')?.trim();
  },

  /**
   * S3's error envelope.
   *
   * Worth extracting even on a 2xx: CompleteMultipartUpload may answer 200 and
   * then put an `<Error>` in the body, because the connection is held open
   * while the parts are assembled and the status line has already been sent.
   * Treating that response as success is how a multipart upload silently
   * produces no object.
   */
  parseError(xml: string): S3Error | undefined {
    if (!/<Error[\s>]/.test(xml)) return undefined;
    return {
      code: firstTagText(xml, 'Code')?.trim(),
      message: firstTagText(xml, 'Message')?.trim(),
    };
  },
};

/** Build the CompleteMultipartUpload request body from the uploaded parts. */
export function buildCompleteMultipartUploadXml(
  parts: ReadonlyArray<{ partNumber: number; eTag: string }>
): string {
  const entries = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber>` +
        `<ETag>${escapeXml(part.eTag)}</ETag></Part>`
    )
    .join('');
  return `<CompleteMultipartUpload>${entries}</CompleteMultipartUpload>`;
}
