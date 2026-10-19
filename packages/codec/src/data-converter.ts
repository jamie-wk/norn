/**
 * Ready-made Temporal data converters: Norn's payload converter plus optional encryption.
 */
import { fileURLToPath } from 'node:url';
import { defaultFailureConverter, type LoadedDataConverter, type PayloadCodec } from '@temporalio/common';
import { createEncryptionCodec, type EncryptionCodecOptions } from './encryption.js';
import { NornCodecError } from './errors.js';
import { payloadConverter } from './payload-converter.js';

export interface NornDataConverterOptions {
  /** A codec to apply before encryption on encode (and after it on decode), e.g. compression. */
  codec?: PayloadCodec;
  /** Encryption keys by id; see {@link EncryptionCodecOptions.keys}. Requires `currentKeyId`. */
  keys?: EncryptionCodecOptions['keys'];
  /** Key id used to encrypt new payloads; see {@link EncryptionCodecOptions.currentKeyId}. */
  currentKeyId?: string;
}

/** A `DataConverter` for `Worker.create`: the payload converter is loaded by path, inside the workflow sandbox too. */
export interface WorkerDataConverter {
  payloadConverterPath: string;
  payloadCodecs: PayloadCodec[];
}

/**
 * Absolute path of this package's `payload-converter` module, for `bundleWorkflowCode({ payloadConverterPath })`
 * when you prebuild workflow bundles. Resolves to the `.ts` source when running from source and
 * to the `.js` build otherwise.
 */
export function resolvePayloadConverterPath(): string {
  const ext = /\.[cm]?[jt]s$/.exec(new URL(import.meta.url).pathname)?.[0] ?? '.js';
  return fileURLToPath(new URL(`./payload-converter${ext}`, import.meta.url));
}

function buildCodecs(options: NornDataConverterOptions): PayloadCodec[] {
  const { codec, keys, currentKeyId } = options;
  if ((keys === undefined) !== (currentKeyId === undefined)) {
    throw new NornCodecError('Encryption needs both `keys` and `currentKeyId`.');
  }
  const codecs: PayloadCodec[] = [];
  if (codec) codecs.push(codec);
  if (keys !== undefined) codecs.push(createEncryptionCodec({ keys, currentKeyId: currentKeyId! }));
  return codecs;
}

/**
 * Builds the `dataConverter` for `Worker.create`. Pass `keys` + `currentKeyId` to encrypt every
 * payload; workers, clients and codec servers must share the same keys.
 *
 * Note: if you build workflow bundles yourself (`workflowBundle`), also pass
 * `payloadConverterPath` (see {@link resolvePayloadConverterPath}) to `bundleWorkflowCode`.
 *
 * @example
 * ```ts
 * const worker = await Worker.create({
 *   workflowsPath, taskQueue, connection,
 *   dataConverter: createDataConverter({ keys, currentKeyId: '2026-10' }),
 * });
 * ```
 */
export function createDataConverter(options: NornDataConverterOptions = {}): WorkerDataConverter {
  return { payloadConverterPath: resolvePayloadConverterPath(), payloadCodecs: buildCodecs(options) };
}

/**
 * Builds the `dataConverter` for a `Client` (or `Connection`-based client). Clients cannot take a
 * converter path everywhere (e.g. bundled or edge deployments), so this passes the converter
 * object itself, which the client SDK accepts as an already-loaded data converter.
 *
 * @example
 * ```ts
 * const client = new Client({ connection, dataConverter: clientDataConverter({ keys, currentKeyId: '2026-10' }) });
 * ```
 */
export function clientDataConverter(options: NornDataConverterOptions = {}): LoadedDataConverter {
  return { payloadConverter, failureConverter: defaultFailureConverter, payloadCodecs: buildCodecs(options) };
}
