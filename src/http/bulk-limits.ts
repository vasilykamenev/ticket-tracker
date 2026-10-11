import type { RequestHandler } from 'express';
import { ValidationError } from '../domain/errors.js';
import { assertBatchSize } from '../domain/tickets/schemas.js';

const BULK_PATH = /^\/api\/resources\/[^/]+\/bulk\/[^/]+$/;

/**
 * AdminJS loads every id of `?recordIds=` before any handler runs, so the size of a bulk selection has to be
 * checked here, ahead of it, to keep the "validate batch size before querying the database" promise.
 */
export const limitBulkSelection: RequestHandler = (req, _res, next) => {
  if (!BULK_PATH.test(req.path)) return next();
  const raw = req.query.recordIds;
  if (raw === undefined) return next();
  if (typeof raw !== 'string') return next(new ValidationError('validation', 'Invalid input', { recordIds: 'must be one comma-separated list' }));
  try {
    assertBatchSize(new Set(raw.split(',')).size);
  } catch (err) {
    return next(err);
  }
  next();
};
