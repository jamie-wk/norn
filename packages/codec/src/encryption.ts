/**
 * AES-256-GCM payload encryption with key rotation, as a Temporal `PayloadCodec`.
 *
 * Uses WebCrypto (`globalThis.crypto.subtle`) only, so the same codec runs in workers, clients and
 * codec servers on Node, Bun, Deno or edge runtimes.
 */
import type { Payload, PayloadCodec } from '@temporalio/common';
import { NornCodecError } from './errors.js';
import { decodePayload, encodePayload } from './payload-proto.js';

/** `encoding` metadata value of payloads produced by {@link createEncryptionCodec}. */
export const ENCRYPTED_ENCODING = 'binary/encrypted';

/** Metadata key holding the id of the key a payload was encrypted with. */
export const ENCRYPTION_KEY_ID_METADATA_KEY = 'encryption-key-id';

const ENCODING_METADATA_KEY = 'encoding';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** `CryptoKey`, without depending on the DOM lib. */
type ImportedKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
const ENCRYPTED_ENCODING_BYTES = utf8.encode(ENCRYPTED_ENCODING);

export interface EncryptionCodecOptions {
  /**
   * Every key that may be needed to decrypt existing payloads, by key id. Values are base64
   * strings (standard or URL-safe alphabet) or raw bytes, and must be exactly 32 bytes (AES-256).
   * Key ids are stored in plaintext in payload metadata, so they must not be secret.
   */
  keys: Record<string, string | Uint8Array>;
  /** The key used to encrypt new payloads. Must be one of `keys`. */
  currentKeyId: string;
}

/** Shortens and quotes an id for an error message (ids read from payloads are untrusted). */
const quote = (id: string) => JSON.stringify(id.length > 100 ? `${id.slice(0, 100)}…` : id);

function decodeBase64(value: string): Uint8Array | undefined {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return undefined;
  try {
    return Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readKey(id: string, value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array | undefined;
  if (typeof value === 'string') {
    bytes = decodeBase64(value);
    if (!bytes) throw new NornCodecError(`Encryption key ${quote(id)} is not valid base64.`);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    throw new NornCodecError(`Encryption key ${quote(id)} must be a base64 string or a Uint8Array.`);
  }
  if (bytes.length !== KEY_BYTES) {
    throw new NornCodecError(
      `Encryption key ${quote(id)} must be exactly ${KEY_BYTES} bytes for AES-256-GCM, got ${bytes.length}. ` +
        'Generate one with generateKey().',
    );
  }
  // Copy, so callers mutating their array later cannot change (or zero) the key.
  return new Uint8Array(bytes);
}

/**
 * Generates a new random AES-256 key, base64-encoded, for use as a value in
 * {@link EncryptionCodecOptions.keys}. Store it in your secret manager, never in source control.
 */
export function generateKey(): string {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/**
 * Creates a Temporal `PayloadCodec` that encrypts every payload with AES-256-GCM.
 *
 * Encoding serializes the whole input Payload (metadata included, so the original `encoding`
 * is hidden too) and returns a new Payload whose metadata is
 * `{ encoding: "binary/encrypted", "encryption-key-id": <currentKeyId> }` and whose data is a
 * fresh random 12-byte IV followed by the ciphertext and 16-byte tag. The key id is bound as
 * additional authenticated data, so changing the key-id metadata makes decryption fail.
 *
 * Decoding passes through payloads that are not `binary/encrypted` untouched, so encryption can
 * be enabled on a namespace that already holds plaintext history. Encrypted payloads are decrypted
 * with the key their metadata names, so old payloads stay readable after rotating `currentKeyId`
 * as long as the old key stays in `keys`.
 *
 * @throws NornCodecError at creation if a key is malformed or `currentKeyId` is not in `keys`.
 *   `decode` rejects with NornCodecError for unknown key ids and for tampered or corrupted data.
 *
 * @example
 * ```ts
 * const codec = createEncryptionCodec({
 *   keys: { '2026-10': process.env.NORN_KEY_2026_10!, '2026-04': process.env.NORN_KEY_2026_04! },
 *   currentKeyId: '2026-10',
 * });
 * ```
 */
export function createEncryptionCodec(options: EncryptionCodecOptions): PayloadCodec {
  const { keys, currentKeyId } = options ?? ({} as EncryptionCodecOptions);
  if (keys === null || typeof keys !== 'object') {
    throw new NornCodecError('createEncryptionCodec requires a `keys` object mapping key ids to keys.');
  }
  const raw = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [id, value] of Object.entries(keys)) {
    if (id === '') throw new NornCodecError('Encryption key ids must be non-empty strings.');
    raw.set(id, readKey(id, value));
  }
  if (typeof currentKeyId !== 'string' || !raw.has(currentKeyId)) {
    const known = [...raw.keys()].map(quote).join(', ') || 'none';
    throw new NornCodecError(
      `currentKeyId ${quote(String(currentKeyId))} is not one of the configured encryption keys (configured: ${known}).`,
    );
  }

  // Keys are imported lazily as non-extractable CryptoKeys; the raw bytes are dropped once imported.
  const imported = new Map<string, Promise<ImportedKey>>();
  const cryptoKey = (id: string): Promise<ImportedKey> | undefined => {
    let key = imported.get(id);
    if (!key) {
      const bytes = raw.get(id);
      if (!bytes) return undefined;
      key = globalThis.crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      imported.set(id, key);
      raw.delete(id);
      void key.then(() => bytes.fill(0), () => undefined);
    }
    return key;
  };
  const currentKeyIdBytes = utf8.encode(currentKeyId);

  async function encryptOne(payload: Payload): Promise<Payload> {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = encodePayload(payload) as Uint8Array<ArrayBuffer>;
    const ciphertext = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: currentKeyIdBytes },
      (await cryptoKey(currentKeyId))!,
      plaintext,
    );
    const data = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    data.set(iv);
    data.set(new Uint8Array(ciphertext), IV_BYTES);
    return {
      metadata: {
        [ENCODING_METADATA_KEY]: ENCRYPTED_ENCODING_BYTES.slice(),
        [ENCRYPTION_KEY_ID_METADATA_KEY]: currentKeyIdBytes.slice(),
      },
      data,
    };
  }

  async function decryptOne(payload: Payload): Promise<Payload> {
    const encoding = payload.metadata?.[ENCODING_METADATA_KEY];
    if (!encoding || utf8Decoder.decode(encoding) !== ENCRYPTED_ENCODING) return payload;

    const idBytes = payload.metadata?.[ENCRYPTION_KEY_ID_METADATA_KEY];
    if (!idBytes) {
      throw new NornCodecError(`Encrypted payload has no "${ENCRYPTION_KEY_ID_METADATA_KEY}" metadata, so it cannot be decrypted.`);
    }
    const keyId = utf8Decoder.decode(idBytes);
    const key = cryptoKey(keyId);
    if (!key) {
      throw new NornCodecError(
        `Payload was encrypted with key ${quote(keyId)}, which is not configured. ` +
          'Keep retired keys in `keys` until no history references them.',
      );
    }
    const failed = (cause?: unknown) =>
      new NornCodecError(
        `Payload encrypted with key ${quote(keyId)} could not be decrypted: it was tampered with or corrupted, ` +
          `or the key configured as ${quote(keyId)} is not the key it was encrypted with.`,
        { cause },
      );
    const data = payload.data;
    if (!data || data.length < IV_BYTES + TAG_BYTES) throw failed();

    let plaintext: ArrayBuffer;
    try {
      plaintext = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: data.slice(0, IV_BYTES), additionalData: idBytes.slice() },
        await key,
        data.slice(IV_BYTES),
      );
    } catch (error) {
      throw failed(error);
    }
    try {
      return decodePayload(new Uint8Array(plaintext));
    } catch (error) {
      throw new NornCodecError(`Payload encrypted with key ${quote(keyId)} decrypted to an invalid Payload.`, { cause: error });
    }
  }

  return {
    encode: (payloads) => Promise.all(payloads.map(encryptOne)),
    decode: (payloads) => Promise.all(payloads.map(decryptOne)),
  };
}
