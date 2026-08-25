/**
 * Minimal declarations for `node:sqlite`.
 *
 * The module is stable in the Node 24 runtime this repo uses, but `@types/node`
 * is pinned at v20 and does not describe it. Declaring only the surface
 * scripts/upload-bank-assets.ts actually calls is preferable to bumping the
 * types package, which would pull a large diff across every Node API for the
 * sake of one script.
 *
 * Delete this file when @types/node is upgraded to 22 or later.
 */
declare module 'node:sqlite' {
  export type SQLOutputValue = string | number | bigint | Uint8Array | null;

  export class StatementSync {
    all(...params: unknown[]): Record<string, SQLOutputValue>[];
    get(...params: unknown[]): Record<string, SQLOutputValue> | undefined;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
