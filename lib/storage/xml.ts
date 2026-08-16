/**
 * Just enough XML reading for S3's ListObjectsV2 response.
 *
 * A full XML parser would be a dependency for one well-known, flat response
 * shape. The fields extracted here are `<Key>`, `<IsTruncated>` and
 * `<NextContinuationToken>`; anything else in the document is ignored.
 */

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
};
