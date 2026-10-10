import { z } from 'zod';

export const COMMENT_MAX = 5000;

/** Plain text, 1-5000 characters. Rendered escaped; never interpreted as HTML. */
const body = z.string().trim().min(1).max(COMMENT_MAX);

// The ticket id comes from the URL and the author from the session, never from the payload.
export const commentInputSchema = z.object({ body }).strict();
