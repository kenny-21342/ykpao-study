'use client';

/**
 * Client-side sync for one page's live Yjs document (Feature 5, flagged off
 * by default -- see `isYjsCollabEnabled()` in lib/stream-config.ts).
 *
 * `Page.content` stays the authoritative HTML mirror throughout: this hook
 * only maintains a side-channel CRDT document for the live editing session.
 * If a page has never had a collaborative session (no snapshot, no update
 * log), the very first client to open it converts `Page.content` into the
 * initial Yjs document -- see `SEEDING` below for why that step needs care.
 *
 * SEEDING: two clients can discover "this page has no session yet" at once.
 * To avoid both of them independently seeding the same starting text (which
 * Yjs would merge as two *separate* insertions -- visibly duplicated
 * content, not deduplicated) the candidate seed is built in a disposable,
 * unshared Y.Doc and POSTed with `seed: true`; the server accepts exactly
 * one seed per page via a unique-constraint race (see
 * app/api/pages/[id]/yjs-update/route.ts). The real, shared `Y.Doc` this
 * hook exposes is never mutated with a losing seed -- a loser discards its
 * disposable doc and fetches the winner's snapshot instead.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { generateJSON, getSchema } from '@tiptap/core';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { createRichTextEditorExtensions } from './richTextEditorExtensions';

const YJS_XML_FRAGMENT_FIELD = 'default';

async function fetchLog(pageId: string, since?: string): Promise<{
  snapshot: string | null;
  updates: { id: string; data: string }[];
} | null> {
  const url = since
    ? `/api/pages/${pageId}/yjs-updates?since=${encodeURIComponent(since)}`
    : `/api/pages/${pageId}/yjs-updates`;
  const res = await fetch(url);
  if (!res.ok) return null; // 501 (disabled) or any other failure -- caller falls back gracefully
  return res.json();
}

function applyBase64Update(doc: Y.Doc, base64: string) {
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(base64, 'base64')));
}

export function useYjsPageSync(
  pageId: string | null | undefined,
  initialContentHtml: string,
  remoteUpdateSignal: { id: string; nonce: number } | null | undefined
) {
  const [ydoc, setYdoc] = useState<Y.Doc | null>(null);
  const docRef = useRef<Y.Doc | null>(null);
  const lastAppliedIdRef = useRef<string | null>(null);
  const applyingRemoteRef = useRef(false);
  const contentRef = useRef(initialContentHtml);

  useEffect(() => {
    contentRef.current = initialContentHtml;
  }, [initialContentHtml]);

  useEffect(() => {
    if (!pageId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setYdoc(null);
      return;
    }

    let cancelled = false;
    const doc = new Y.Doc();

    const onLocalUpdate = (update: Uint8Array) => {
      // Skip re-posting updates we just applied *from* the server -- only
      // genuinely local edits need to go back out.
      if (applyingRemoteRef.current || cancelled) return;
      const body = JSON.stringify({ update: Buffer.from(update).toString('base64') });
      fetch(`/api/pages/${pageId}/yjs-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then((res) => res.json())
        .then((data: { id?: string }) => {
          if (data.id) lastAppliedIdRef.current = data.id;
        })
        .catch(() => {
          // best-effort -- a dropped update just means this client's next
          // edit (or the periodic autosave of Page.content) carries it forward
        });
    };
    doc.on('update', onLocalUpdate);

    (async () => {
      const log = await fetchLog(pageId);
      if (cancelled || !log) return; // disabled or unreachable -- editor just runs without Yjs

      if (!log.snapshot && log.updates.length === 0) {
        // No session has ever existed for this page -- try to seed it from
        // the current HTML, using a disposable doc so a losing race never
        // touches the shared one (see module doc comment).
        const seedDoc = new Y.Doc();
        try {
          const extensions = createRichTextEditorExtensions();
          const json = generateJSON(contentRef.current || '<p></p>', extensions);
          prosemirrorJSONToYXmlFragment(
            getSchema(extensions),
            json,
            seedDoc.getXmlFragment(YJS_XML_FRAGMENT_FIELD)
          );
          const seedUpdate = Y.encodeStateAsUpdate(seedDoc);

          const res = await fetch(`/api/pages/${pageId}/yjs-update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ update: Buffer.from(seedUpdate).toString('base64'), seed: true }),
          });
          const result = await res.json().catch(() => ({ seeded: false }));

          if (result.seeded) {
            applyingRemoteRef.current = true;
            try {
              Y.applyUpdate(doc, seedUpdate);
            } finally {
              applyingRemoteRef.current = false;
            }
          } else {
            // Lost the race -- fetch and apply whoever won instead of our
            // own (discarded) seed attempt.
            const winning = await fetchLog(pageId);
            if (winning?.snapshot && !cancelled) {
              applyingRemoteRef.current = true;
              try {
                applyBase64Update(doc, winning.snapshot);
                for (const u of winning.updates) {
                  applyBase64Update(doc, u.data);
                  lastAppliedIdRef.current = u.id;
                }
              } finally {
                applyingRemoteRef.current = false;
              }
            }
          }
        } finally {
          seedDoc.destroy();
        }
      } else {
        applyingRemoteRef.current = true;
        try {
          if (log.snapshot) applyBase64Update(doc, log.snapshot);
          for (const u of log.updates) {
            applyBase64Update(doc, u.data);
            lastAppliedIdRef.current = u.id;
          }
        } finally {
          applyingRemoteRef.current = false;
        }
      }

      if (!cancelled) setYdoc(doc);
    })();

    docRef.current = doc;

    return () => {
      cancelled = true;
      doc.off('update', onLocalUpdate);
      doc.destroy();
      docRef.current = null;
      lastAppliedIdRef.current = null;
      setYdoc(null);
    };
    // initialContentHtml is deliberately not a dependency here: seeding only
    // ever reads it once, at the moment a session is discovered to not exist
    // yet, via contentRef (kept current by the effect above) -- re-running
    // this whole effect on every content edit would tear down and reconnect
    // the live doc on every keystroke.
  }, [pageId]);

  // A pointer event arrived (see usePageCollaboration's onYjsUpdate) --
  // fetch and apply whatever's new since our last applied update.
  const fetchSince = useCallback(async () => {
    if (!pageId || !docRef.current) return;
    const log = await fetchLog(pageId, lastAppliedIdRef.current ?? undefined);
    if (!log) return;
    applyingRemoteRef.current = true;
    try {
      for (const u of log.updates) {
        applyBase64Update(docRef.current, u.data);
        lastAppliedIdRef.current = u.id;
      }
    } finally {
      applyingRemoteRef.current = false;
    }
  }, [pageId]);

  const remoteUpdateIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!remoteUpdateSignal || remoteUpdateSignal.id === remoteUpdateIdRef.current) return;
    remoteUpdateIdRef.current = remoteUpdateSignal.id;
    void fetchSince();
  }, [remoteUpdateSignal, fetchSince]);

  return ydoc;
}
