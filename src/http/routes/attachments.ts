import { Router } from 'express';
import type { Request, RequestHandler } from 'express';
import multer from 'multer';
import type { AttachmentService } from '../../domain/attachments/attachment-service.js';
import { PayloadTooLargeError, UnsupportedMediaError } from '../../domain/errors.js';
import type { Actor } from '../../policies/ticket-policy.js';
import { FILE_LIMIT_LABEL, MAX_FILE_BYTES } from '../../storage/limits.js';
import { limitConcurrentUploads, rejectOversizedBody } from '../upload-limits.js';

const actorOf = (req: Request): Actor => {
  const user = req.user!; // mounted behind requireUser
  return { userId: user.id, role: user.role, agentId: user.agentId };
};

/**
 * Memory storage only: multer keeps the file in a bounded Buffer and never writes a temporary file. One file
 * of at most 10 MiB per request, no other form fields.
 */
const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 2 } }).single('file');

const parseUpload: RequestHandler = (req, res, next) => {
  parser(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return next(
        err.code === 'LIMIT_FILE_SIZE' ? new PayloadTooLargeError(`The file is larger than ${FILE_LIMIT_LABEL}.`) : new UnsupportedMediaError('Send exactly one file, in the "file" field.'),
      );
    }
    next(err);
  });
};

/** Browsers send UTF-8 file names; the multipart parser decodes them as Latin-1. */
const decodeName = (name: string) => Buffer.from(name, 'latin1').toString('utf8');

/**
 * Internal endpoints (requirements section 11), mounted after the session, CSRF and authentication
 * middleware: the CSRF header is checked before any of the upload body is read.
 */
export function createAttachmentRouter(service: AttachmentService, maxConcurrentUploads: number): Router {
  const router = Router();

  router.post('/comments/:commentId/attachments', limitConcurrentUploads(maxConcurrentUploads), rejectOversizedBody, parseUpload, async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) throw new UnsupportedMediaError('Send exactly one file, in the "file" field.');
      const attachment = await service.upload(actorOf(req), String(req.params.commentId), {
        originalName: decodeName(file.originalname),
        declaredType: file.mimetype,
        data: file.buffer,
      });
      res.status(201).json({ id: attachment.id, name: attachment.originalName, size: attachment.sizeBytes, contentType: attachment.contentType });
    } catch (err) {
      next(err);
    }
  });

  // Authorization first, then a redirect to a 60-second presigned URL (attachment disposition).
  router.get('/attachments/:id/download', async (req, res, next) => {
    try {
      const url = await service.downloadUrl(actorOf(req), String(req.params.id));
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.redirect(302, url);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/attachments/:id', async (req, res, next) => {
    try {
      await service.remove(actorOf(req), String(req.params.id));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
