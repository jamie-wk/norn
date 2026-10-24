export * from './errors.js';
export * from './duration.js';
export * from './id-template.js';
export * from './contracts.js';
export * from './transitions.js';
export * from './business-days.js';
export { NORN, tagMethod, readMethodTag, setClassTag, classTag, methodTags, type MethodTag } from './meta.js';
export * from './activity-options.js';

/** Header that carries a request's correlation ID from API calls into workflows and activities. */
export const CORRELATION_HEADER = 'norn-correlation-id';
export * from './connection.js';
