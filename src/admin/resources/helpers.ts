import type { ActionContext } from 'adminjs';
import { Components } from '../component-loader.js';

type View = 'list' | 'filter' | 'show' | 'edit' | 'new';
const VIEWS: View[] = ['list', 'filter', 'show', 'edit', 'new'];

/** Property visibility: shown only in the listed views. */
export function onlyIn(...shown: View[]): Record<View, boolean> {
  return Object.fromEntries(VIEWS.map((v) => [v, shown.includes(v)])) as Record<View, boolean>;
}

const never = () => false;
const adminOnly = ({ currentAdmin }: Pick<ActionContext, 'currentAdmin'>) => currentAdmin?.role === 'ADMIN';

/** Generic delete is never available: records are deactivated, not deleted. Dead code if a handler slips through. */
export const NO_DELETE = {
  delete: { isAccessible: never },
  bulkDelete: { isAccessible: never },
};

export const NO_ACTIONS = NO_DELETE;

/** Read-only resource: only list, show and search remain. */
export const READ_ONLY = {
  ...NO_DELETE,
  new: { isAccessible: never },
  edit: { isAccessible: never },
};

export const ADMIN_ONLY_READ = {
  ...READ_ONLY,
  list: { isAccessible: adminOnly },
  show: { isAccessible: adminOnly },
  search: { isAccessible: adminOnly },
};

/** Only ADMIN may create or edit; everyone else keeps read access (scoped by the resource). Nothing is ever deleted. */
export const ADMIN_WRITE = {
  ...NO_DELETE,
  new: { isAccessible: adminOnly },
  edit: { isAccessible: adminOnly },
};

/** ADMIN-only resource: invisible to everyone else, writable by ADMIN. */
export const ADMIN_MANAGED = {
  ...ADMIN_ONLY_READ,
  new: { isAccessible: adminOnly },
  edit: { isAccessible: adminOnly },
};

export { adminOnly };

/** A boolean shown as a switch in forms and a colored pill elsewhere. */
export const toggle = (opts: { editOnly?: boolean } = {}) => ({
  components: { edit: Components.ToggleField, list: Components.ToggleShow, show: Components.ToggleShow },
  ...(opts.editOnly ? { custom: { mode: 'editOnly' } } : {}),
});

/** A long text edited in a tall, scrolling box. */
export const longText = () => ({ components: { edit: Components.TextAreaField } });
