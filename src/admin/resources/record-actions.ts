import type { ActionContext, ActionRequest } from 'adminjs';

export const recordId = (request: ActionRequest) => String(request.params.recordId);

export const query = (request: ActionRequest, key: string): string | undefined => {
  const value = request.query?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

export function pick(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (params[key] !== undefined) out[key] = params[key];
  return out;
}

/** AdminJS requires every record action to return the record (RecordJSON); our own data rides along. */
export const withRecord = (context: ActionContext, data: object = {}) => ({
  record: context.record!.toJSON(context.currentAdmin),
  ...data,
});

type Apply = (context: ActionContext, request: ActionRequest, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * A record action with a custom React form. AdminJS opens the action page with a GET that must return
 * the record; the form then POSTs, and domain errors keep their HTTP status for the form to show.
 */
export const formAction = (component: string, apply: Apply) => ({
  actionType: 'record' as const,
  component,
  handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
    if (request.method === 'get') return withRecord(context);
    await apply(context, request, (request.payload ?? {}) as Record<string, unknown>);
    return withRecord(context, { ok: true });
  },
});

/** Hidden JSON endpoint (GET) used by custom components; scoped by the service like everything else. */
export const dataAction = (load: (context: ActionContext, request: ActionRequest) => Promise<object>) => ({
  actionType: 'record' as const,
  isVisible: false,
  component: false as const,
  handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => withRecord(context, await load(context, request)),
});

/** Hidden state-changing endpoint (POST) called by custom components that live inside another page. */
export const mutationAction = (apply: Apply) => ({
  actionType: 'record' as const,
  isVisible: false,
  component: false as const,
  handler: async (request: ActionRequest, _response: unknown, context: ActionContext) => {
    const result = await apply(context, request, (request.payload ?? {}) as Record<string, unknown>);
    // Only what the action chose to send back, as `{ reply: {...} }`; never a whole database row.
    const reply = (result as { reply?: unknown } | null | undefined)?.reply;
    return withRecord(context, { ok: true, ...(reply !== null && typeof reply === 'object' ? reply : {}) });
  },
});
