import type { Request, RequestHandler } from 'express';
import { BusyError, PayloadTooLargeError } from '../domain/errors.js';
import { MAX_FILE_BYTES } from '../storage/file-validation.js';

/** Multipart framing around one file (boundary, headers). Anything bigger than file + this cannot be valid. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Throws away the rest of a request body that will not be read. Call it at the moment a request is refused
 * (CSRF, authentication, size or load limits), BEFORE the response is built: if the server answers while the
 * client is still writing a large body, the client sees a reset connection instead of the explanation, which a
 * browser shows as a network error. (Draining only when the response is flushed was too late; tested.)
 */
export function discardBody(req: Request): void {
  req.resume();
}

/**
 * Refuses an oversized upload from its Content-Length header, before a single byte of the body is read or
 * buffered. (Requests without a length are still capped by the parser's own limit.)
 */
export const rejectOversizedBody: RequestHandler = (req, _res, next) => {
  const length = Number(req.get('content-length'));
  if (Number.isFinite(length) && length > MAX_FILE_BYTES + MULTIPART_OVERHEAD_BYTES) {
    discardBody(req);
    return next(new PayloadTooLargeError('The file is larger than 10 MiB.'));
  }
  next();
};

/**
 * At most `max` uploads are processed at the same time, which bounds the memory they can hold
 * (max x 10 MiB). Excess requests get HTTP 429 instead of queueing.
 */
export function limitConcurrentUploads(max: number): RequestHandler {
  let active = 0;
  return (req, res, next) => {
    if (active >= max) {
      discardBody(req);
      return next(new BusyError());
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active--;
      }
    };
    res.on('close', release);
    res.on('finish', release);
    next();
  };
}
