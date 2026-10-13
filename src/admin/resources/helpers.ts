import type { ActionContext, LayoutElement } from 'adminjs';
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

/**
 * Pages of a resource that only an ADMIN may open. With no accessible list action AdminJS leaves the resource out
 * of the side menu. `search` stays open to every staff member (and is scoped by the resource): the reference
 * pickers of the ticket forms and filters use it to offer groups, agents and statuses.
 */
export const ADMIN_VIEW = {
  list: { isAccessible: adminOnly },
  show: { isAccessible: adminOnly },
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

type Layout = LayoutElement[];

/**
 * The look of the ticket form for any record form: the fields in a wide panel on the left and the status-like
 * fields (switches, dates) in a narrow panel on the right. Used as an AdminJS action `layout`.
 */
export function twoColumn(main: string[], side: string[] = []): Layout {
  const columns: unknown[] = [[{ variant: 'white', p: 'lg', style: { flex: '1 1 480px', minWidth: 0 } }, main]];
  if (side.length > 0) columns.push([{ variant: 'white', p: 'lg', style: { flex: '0 0 320px', maxWidth: '100%' } }, side]);
  return [[{ flex: true, flexDirection: 'row', flexWrap: 'wrap', style: { gap: 24, alignItems: 'flex-start' } }, columns]] as unknown as Layout;
}

/** Adds the two layouts to the new/edit/show actions of a resource, keeping what the actions already say. */
export function withLayouts<A extends Record<string, unknown>>(actions: A, layouts: { form: Layout; show: Layout }) {
  const merged = (key: string, layout: Layout) => ({ ...((actions[key] as object | undefined) ?? {}), layout });
  return { ...actions, new: merged('new', layouts.form), edit: merged('edit', layouts.form), show: merged('show', layouts.show) };
}
