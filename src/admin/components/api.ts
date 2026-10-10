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
