/**
 * Invalid codec configuration, or a payload the codec cannot decode.
 *
 * Messages name key ids (which are not secret) but never include key material.
 * `@norn-ts/codec` deliberately does not depend on `@norn-ts/core`, so this is a plain `Error` subclass.
 */
export class NornCodecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
  }
}
