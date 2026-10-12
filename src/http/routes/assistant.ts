import express, { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import { PayloadTooLargeError, ValidationError } from '../../domain/errors.js';
import type { Asker, AssistantService } from '../../assistant/service.js';

const askerOf = (req: Request): Asker => {
  const user = req.user!; // mounted behind requireUser
  return { userId: user.id, role: user.role };
};

/** A body of a few hundred bytes: the ids and a question of at most 1000 characters. */
const json = express.json({ limit: '4kb', type: 'application/json' });
const parseJson: RequestHandler = (req, res, next) => {
  json(req, res, (err: unknown) => {
    if (!err) return next();
    const tooLarge = (err as { type?: string }).type === 'entity.too.large';
    next(tooLarge ? new PayloadTooLargeError('The question is too long.') : new ValidationError('invalid_request', 'Send a JSON body.'));
  });
};

/**
 * `GET /internal/assistant/fields?resourceId=` lists the fields of a screen the person may ask about;
 * `POST /internal/assistant` answers one question about one field (requirements section 11). Mounted behind the
 * session, CSRF and authentication middleware, and only when AI_ENABLED=true.
 */
export function createAssistantRouter(service: AssistantService): Router {
  const router = Router();

  router.get('/assistant/fields', (req, res, next) => {
    try {
      const fields = service.fields(askerOf(req), String(req.query.resourceId ?? ''));
      res.set('Cache-Control', 'no-store').json({ fields });
    } catch (err) {
      next(err);
    }
  });

  router.post('/assistant', parseJson, async (req, res, next) => {
    try {
      const result = await service.ask(askerOf(req), req.body);
      res.set('Cache-Control', 'no-store');
      if (result.kind === 'rate_limited') {
        res.set('Retry-After', String(result.retryAfterSeconds)).status(429);
        res.json({ error: 'rate_limited', message: result.message, retryAfterSeconds: result.retryAfterSeconds, help: result.help });
      } else if (result.kind === 'unavailable') {
        // The question was valid and the application works: only the AI part is missing, so this is not an error status.
        res.json({ available: false, answer: null, message: result.message, help: result.help });
      } else {
        res.json({ available: true, answer: result.answer, help: result.help });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
