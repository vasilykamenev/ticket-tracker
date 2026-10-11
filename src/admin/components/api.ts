import { ApiClient } from 'adminjs';

const api = new ApiClient();

export interface ServerError {
  message: string;
  details: Record<string, string>;
}

/** Turns an axios error from our actions ({error, message, details}) into something to display. */
export function toServerError(err: unknown): ServerError {
  const data = (err as { response?: { data?: { message?: string; details?: Record<string, string> } } })?.response?.data;
  return {
    message: data?.message ?? 'Something went wrong. Please try again.',
    details: data?.details ?? {},
  };
}

/** GET a hidden JSON action of a record (formState, history, customerTickets). */
export async function recordData<T>(resourceId: string, recordId: string, actionName: string, params: Record<string, string | number> = {}): Promise<T> {
  const response = await api.recordAction({ resourceId, recordId, actionName, method: 'get', params });
  return response.data as T;
}

/** POST a state-changing record action. The CSRF header is added by public/csrf-client.js. */
export async function postRecordAction(resourceId: string, recordId: string, actionName: string, data: Record<string, unknown>): Promise<void> {
  await api.recordAction({ resourceId, recordId, actionName, method: 'post', data });
}

/** Where the admin lives, taken from the current URL (works for any rootPath). */
export function adminRoot(): string {
  const at = window.location.pathname.indexOf('/resources/');
  return at >= 0 ? window.location.pathname.slice(0, at) : window.location.pathname.replace(/\/$/, '');
}

export function ticketUrl(ticketId: string): string {
  return `${adminRoot()}/resources/Ticket/records/${ticketId}/show`;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'pdf', 'txt'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Friendly pre-check before sending; the server checks size, type and content again and is the authority. */
export function checkFile(file: File): string | null {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.includes(extension)) return 'Only PNG, JPEG, PDF and plain text (.txt) files can be attached.';
  if (file.size === 0) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return `The file is ${formatBytes(file.size)}; the limit is 10 MB.`;
  return null;
}

async function failureMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    if (data.message) return data.message;
  } catch {
    // not JSON
  }
  return response.status === 413 ? 'The file is too large.' : 'The request failed. Please try again.';
}

/** The CSRF header is added to these same-origin fetches by public/csrf-client.js. */
export async function uploadAttachment(commentId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`/internal/comments/${commentId}/attachments`, { method: 'POST', body: form, credentials: 'same-origin' });
  if (!response.ok) throw new Error(await failureMessage(response));
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  const response = await fetch(`/internal/attachments/${attachmentId}`, { method: 'DELETE', credentials: 'same-origin' });
  if (!response.ok) throw new Error(await failureMessage(response));
}

/** Opens through our own authorization, which then redirects to a short-lived storage URL. */
export const downloadHref = (attachmentId: string) => `/internal/attachments/${attachmentId}/download`;
