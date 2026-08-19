import crypto from 'node:crypto';

/**
 * Authenticated encryption for credentials this platform stores on a student's
 * behalf — currently the API keys they bring for AI features.
 *
 * These are real, billable third-party credentials that belong to teenagers,
 * so they never touch the database in plaintext and are never returned to any
 * client. Only two things ever leave this module: the sealed envelope (stored)
 * and a four-character hint (displayed).
 *
 * AES-256-GCM, not AES-CBC + separate HMAC: GCM authenticates the ciphertext
 * as part of decryption, so a tampered row fails loudly instead of decrypting
 * to garbage that would then be sent to a provider as a bearer token.
 *
 * The envelope is `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version
 * prefix exists so a future scheme (or a key rotation with dual-read) can be
 * introduced without guessing at the format of existing rows.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
/** 96 bits — the IV length GCM is specified and optimised for. */
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

/**
 * Cached alongside the raw string it was derived from, so a process that
 * changes `CREDENTIAL_ENCRYPTION_KEY` at runtime (the tests do) is not served
 * a stale key.
 */
let cache: { raw: string; key: Buffer } | null = null;

function readKey(): Buffer {
  const raw = (process.env.CREDENTIAL_ENCRYPTION_KEY ?? '').trim();
  if (!raw) {
    throw new CredentialCryptoError(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` ' +
        'and add it to your environment before storing API credentials.',
    );
  }
  if (cache && cache.raw === raw) return cache.key;

  // Base64 decoding in Node is lenient — it silently drops invalid characters
  // rather than throwing — so the length check below is what actually
  // validates the input.
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new CredentialCryptoError(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }
  cache = { raw, key };
  return key;
}

/**
 * True when a usable key is present. Callers use this to disable the
 * credential UI with an explanation rather than throwing mid-save.
 */
export function isCredentialEncryptionConfigured(): boolean {
  try {
    readKey();
    return true;
  } catch {
    return false;
  }
}

/** Seal a secret into the storable envelope. */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CredentialCryptoError('Cannot encrypt an empty secret');
  }
  const key = readKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Open an envelope produced by `encryptSecret`.
 *
 * Throws — never returns a partial or fallback value — when the key is wrong,
 * the row was written under a rotated key, or the ciphertext was tampered
 * with. A silent failure here would mean sending junk to a provider as a
 * bearer token, or worse, treating a corrupted record as "no credentials".
 */
export function decryptSecret(envelope: string): string {
  const key = readKey();
  const parts = (envelope ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialCryptoError('Stored credential is not in a recognised format');
  }
  const [, ivPart, tagPart, ctPart] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctPart, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // Deliberately opaque: the caller has no business distinguishing "wrong
    // key" from "tampered ciphertext", and neither detail should reach a log
    // line that might be shipped somewhere.
    throw new CredentialCryptoError(
      'Stored credential could not be decrypted. It was most likely encrypted with a ' +
        'different CREDENTIAL_ENCRYPTION_KEY; the owner must re-enter it.',
    );
  }
}

/**
 * The only representation of a secret that is safe to show a client: the last
 * four characters, which is enough for someone to recognise which of their
 * keys they pasted without being enough to use it.
 */
export function maskSecret(secret: string): string {
  const trimmed = (secret ?? '').trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}
