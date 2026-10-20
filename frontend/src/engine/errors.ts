/** The request is malformed (the reference API answers these with HTTP 400). */
export class RequestError extends Error {}

/** Thrown by engine parts that have not been ported yet. */
export class NotPortedError extends Error {}
