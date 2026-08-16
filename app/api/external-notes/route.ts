import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { aiLimiter } from '@/lib/rate-limit';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';
export const revalidate = 3600; // cache for 1 hour

const RSS_URL = 'https://review.ykpao.com/rss.xml';

type ExternalNote = {
  id: string;
  title: string;
  link: string;
  author: string;
  categories: string[];
  pubDate: string;
  excerpt: string;
  content: string;
  // Key stats scraped from the post page (undefined when not fetched).
  publishedAt?: string;   // ISO date from the page header (发布于 YYYY-MM-DD)
  reads?: number;        // 浏览/阅读 count
  upvotes?: number;      // likes / heart count
  commentCount?: number; // best-effort; usually needs login so often undefined
};

/** Stats that can be scraped from a YKPao Review (Halo/Joe) post page. */
type PostStats = {
  publishedAt?: string;
  reads?: number;
  upvotes?: number;
};

/** Pull published date, read count, and upvote count out of the page HTML. */
function extractStats(html: string): PostStats {
  const stats: PostStats = {};

  // 发布于 2026-02-12  (the page header is more reliable than RSS pubDate)
  const pub = html.match(/发布于\s*(\d{4})-(\d{2})-(\d{2})/);
  if (pub) {
    stats.publishedAt = `${pub[1]}-${pub[2]}-${pub[3]}`;
  }

  // "284,805 阅读" — comma-formatted read counter in the post meta line.
  // Capture the LAST occurrence (the post-level one); the first occurrence
  // further up the DOM is also the post's own counter.
  const readMatches = html.matchAll(/([\d,]+)\s*阅读/g);
  let lastRead: string | undefined;
  for (const m of readMatches) lastRead = m[1];
  if (lastRead) {
    const n = parseInt(lastRead.replace(/,/g, ''), 10);
    if (!Number.isNaN(n)) stats.reads = n;
  }

  // Upvotes: the count sits in the span right after data-upvote-post-name="…".
  //   data-upvote-post-name="019c…84e"
  // >5</span>
  const up = html.match(/data-upvote-post-name="[^"]+"[\s\S]{0,200}?>(\d+)</);
  if (up) {
    stats.upvotes = parseInt(up[1], 10);
  }

  return stats;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const UPSTREAM_ORIGIN = 'https://review.ykpao.com';

function rewriteUrls(html: string): string {
  // Rewrite root-relative and protocol-relative URLs to the upstream origin
  // so images, links, and assets resolve correctly (not to localhost).
  return html
    // srcset="/upload/a.jpg 1600w, /upload/b.jpg 800w" → full URLs
    .replace(/(srcset)=["']([^"']*)["']/gi, (match, attr, val: string) => {
      const rewritten = val
        .split(',')
        .map((entry: string) => {
          const trimmed = entry.trim();
          // each entry is like "/upload/img.jpg?w=1600 1600w"
          const parts = trimmed.split(/\s+/);
          if (parts[0] && parts[0].startsWith('/') && !parts[0].startsWith('//')) {
            parts[0] = UPSTREAM_ORIGIN + parts[0];
          }
          return parts.join(' ');
        })
        .join(', ');
      return `${attr}="${rewritten}"`;
    })
    // src="/upload/..." → src="https://review.ykpao.com/upload/..."
    .replace(/(src|href|data-src|data-href)=["'](\/(?!\/)[^"']*)["']/gi,
      (_match, attr, path) => `${attr}="${UPSTREAM_ORIGIN}${path}"`)
    // Protocol-relative: src="//review.ykpao.com/..." → https://...
    .replace(/(src|href)=["']\/\/review\.ykpao\.com/gi, '$1="https://review.ykpao.com');
}

function extractContent(html: string): string {
  // Extract the <article> body (Halo/Joe theme pattern)
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let raw = articleMatch ? articleMatch[1] : '';

  // Strip telemetry gifs, pjax styles, and other noise
  raw = raw
    .replace(/<img[^>]*telemetry[^>]*>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Rewrite all URLs to point to the upstream origin
  raw = rewriteUrls(raw);

  return raw.trim();
}

async function fetchRss(): Promise<string> {
  const res = await fetch(RSS_URL, {
    headers: { 'User-Agent': 'SmartEdu/1.0' },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  return res.text();
}

/**
 * Crawl the upstream /archives paginated index to discover post URLs that
 * the (bounded) RSS feed omits. The Halo/Joe theme lists each post as
 * <a href="/archives/<slug>">. We walk /archives, /archives/page/2, … until
 * a page returns no new slugs (Halo stops paginating) or we hit MAX_PAGES.
 */
const ARCHIVES_BASE = 'https://review.ykpao.com/archives';
const MAX_ARCHIVE_PAGES = 10;

async function discoverArchiveSlugs(): Promise<string[]> {
  const slugs = new Set<string>();
  for (let page = 1; page <= MAX_ARCHIVE_PAGES; page++) {
    const url = page === 1 ? ARCHIVES_BASE : `${ARCHIVES_BASE}/page/${page}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SmartEdu/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) break;
      const html = await res.text();
      // Post links look like href="/archives/<slug>". Exclude the /page/N
      // pagination links and any non-post archive routes.
      const matches = html.matchAll(/href="\/archives\/([^"\/]+)"/g);
      let newCount = 0;
      for (const m of matches) {
        const slug = decodeURIComponent(m[1]);
        // Skip pagination links (page/2, page/3) — they're not posts.
        if (/^page\/\d+$/i.test(slug)) continue;
        if (!slugs.has(slug)) {
          slugs.add(slug);
          newCount++;
        }
      }
      // If the page added nothing new, we've exhausted pagination.
      if (newCount === 0) break;
    } catch {
      break;
    }
  }
  return [...slugs];
}

/** Fetch a single post page by URL and extract title + published date. */
async function fetchPostMeta(postUrl: string): Promise<{ title: string; publishedAt?: string } | null> {
  try {
    const res = await fetch(postUrl, {
      headers: { 'User-Agent': 'SmartEdu/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? postUrl).trim();
    const stats = extractStats(html);
    return { title, publishedAt: stats.publishedAt };
  } catch {
    return null;
  }
}

function parseRss(xml: string) {
  const items: Array<{
    title: string;
    link: string;
    guid: string;
    author: string;
    categories: string[];
    pubDate: string;
    description: string;
  }> = [];

  // Regex-based RSS parsing (no DOM dependency)
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const getTag = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const getTagCDATA = (tag: string) => {
      const m = block.match(new RegExp(
        `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i'
      ));
      if (m) return m[1].trim();
      return getTag(tag);
    };

    // dc:creator and category use namespaces
    const creatorMatch = block.match(/<dc:creator[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/dc:creator>/i);
    const categoryMatches = [...block.matchAll(/<category[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/category>/gi)];

    items.push({
      title: getTagCDATA('title'),
      link: getTag('link') || getTagCDATA('link'),
      guid: getTagCDATA('guid'),
      author: creatorMatch ? creatorMatch[1].trim() : 'Anonymous',
      categories: categoryMatches.map((c) => c[1].trim()).filter(Boolean),
      pubDate: getTag('pubDate'),
      description: getTagCDATA('description'),
    });
  }
  return items;
}

export async function GET(req: NextRequest) {
  // One request here fans out to many upstream fetches (archive pages, then
  // one per discovered post), so it must be both authenticated and metered —
  // otherwise it is a free amplifier for knocking over this server and
  // review.ykpao.com alike.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!(await aiLimiter.check(`external-notes:${user.id}`))) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment.' },
      { status: 429 }
    );
  }

  const { searchParams } = new URL(req.url);
  const withContent = searchParams.get('content') !== 'false';
  const limit = parsePositiveInt(searchParams.get('limit'), 50, 100);

  // Single-post mode: fetch just one post's full HTML by URL. The URL MUST be
  // on the allow-list below to prevent SSRF (server-side request forgery).
  const ALLOWED_HOSTS = ['review.ykpao.com'];
  const singleUrl = searchParams.get('url');
  if (singleUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(singleUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }
    if (parsedUrl.protocol !== 'https:' || !ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
      return NextResponse.json(
        { error: 'URL host not allowed' },
        { status: 403 }
      );
    }

    try {
      const res = await fetch(parsedUrl.href, {
        headers: { 'User-Agent': 'SmartEdu/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });
      }
      const html = await res.text();
      const content = extractContent(html);
      const excerpt = stripHtml(content).slice(0, 200);
      const stats = extractStats(html);
      return NextResponse.json({
        note: {
          id: parsedUrl.href,
          title: (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? parsedUrl.href).trim(),
          link: parsedUrl.href,
          author: 'Anonymous',
          categories: [] as string[],
          pubDate: stats.publishedAt
            ? new Date(stats.publishedAt).toUTCString()
            : new Date().toUTCString(),
          excerpt,
          content,
          ...stats,
        },
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to fetch post' },
        { status: 500 }
      );
    }
  }

  try {
    const xml = await fetchRss();
    const rssItems = parseRss(xml).slice(0, limit);

    // The upstream RSS feed is bounded (only ~19 newest posts). Augment it
    // with any posts discovered via the /archives index so older Y9 content
    // is reachable. We only do this in the fast (metadata) path to avoid
    // N extra page fetches during full-content mode.
    if (!withContent) {
      // Normalise links for dedup: URL-decode, strip trailing slash, lowercase.
      // RSS and archives may store the same post with different encoding
      // (e.g. %E9%87 in RSS vs the literal Chinese char in archives).
      const normalise = (url: string) => {
        try {
          return decodeURIComponent(url).replace(/\/+$/, '').toLowerCase();
        } catch {
          return url.replace(/\/+$/, '').toLowerCase();
        }
      };
      const rssLinks = new Set(rssItems.map((i) => normalise(i.link)));
      let archiveSlugs: string[] = [];
      try {
        archiveSlugs = await discoverArchiveSlugs();
      } catch {
        // best-effort; if archives crawl fails, fall back to RSS only.
      }

      const extraNotes: ExternalNote[] = [];
      // Fetch missing posts' metadata in parallel (bounded concurrency via
      // Promise.all — typically only a handful of extras beyond RSS).
      const missing = archiveSlugs
        .map((slug) => `https://review.ykpao.com/archives/${slug}`)
        .filter((url) => !rssLinks.has(normalise(url)));

      if (missing.length > 0) {
        const metas = await Promise.all(missing.map((u) => fetchPostMeta(u)));
        for (let i = 0; i < missing.length; i++) {
          const m = metas[i];
          if (!m) continue;
          const url = missing[i];
          extraNotes.push({
            id: url,
            title: m.title,
            link: url,
            author: 'Anonymous',
            categories: [],
            pubDate: m.publishedAt
              ? new Date(m.publishedAt).toUTCString()
              : new Date().toUTCString(),
            excerpt: '',
            content: '',
          });
        }
      }

      const notes: ExternalNote[] = [
        ...rssItems.map((item) => ({
          id: item.guid || item.link,
          title: item.title,
          link: item.link,
          author: item.author,
          categories: item.categories,
          pubDate: item.pubDate,
          excerpt: stripHtml(item.description).slice(0, 200),
          content: '',
        })),
        ...extraNotes,
      ];
      // Final dedup by normalised link — catches any stragglers from
      // encoding differences between RSS and archives.
      const seenLinks = new Set<string>();
      const dedupedNotes = notes.filter((n) => {
        const key = normalise(n.link);
        if (seenLinks.has(key)) return false;
        seenLinks.add(key);
        return true;
      });
      // Sort by date desc (newest first) so RSS + archive extras interleave.
      dedupedNotes.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
      return NextResponse.json({ notes: dedupedNotes.slice(0, limit), total: dedupedNotes.length });
    }

    const items = rssItems;

    // Full-content mode: fetch ALL posts in parallel (not batched)
    const results = await Promise.all(
      items.map(async (item) => {
        try {
          const res = await fetch(item.link, {
            headers: { 'User-Agent': 'SmartEdu/1.0' },
            signal: AbortSignal.timeout(8000), // per-post timeout
          });
          if (!res.ok) return null;
          const html = await res.text();
          const content = extractContent(html);
          const excerpt = stripHtml(content).slice(0, 200);
          const stats = extractStats(html);
          return {
            id: item.guid || item.link,
            title: item.title,
            link: item.link,
            author: item.author,
            categories: item.categories,
            pubDate: stats.publishedAt
              ? new Date(stats.publishedAt).toUTCString()
              : item.pubDate,
            excerpt,
            content,
            ...stats,
          } as ExternalNote;
        } catch {
          // Return the item with empty content rather than dropping it
          return {
            id: item.guid || item.link,
            title: item.title,
            link: item.link,
            author: item.author,
            categories: item.categories,
            pubDate: item.pubDate,
            excerpt: stripHtml(item.description).slice(0, 200),
            content: '',
          } as ExternalNote;
        }
      })
    );

    const notes = results.filter((r): r is ExternalNote => r !== null);
    return NextResponse.json({ notes, total: notes.length });
  } catch (error) {
    console.error('Failed to fetch external notes:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch external notes' },
      { status: 500 }
    );
  }
}
