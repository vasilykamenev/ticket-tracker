import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentLoader } from 'adminjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = [
  'ModeField', 'SetPasswordForm', 'ChangeRoleForm', 'GroupMembers',
  'ChangeStatusForm', 'BulkChangeStatusForm', 'AssignForm', 'TicketHistory', 'CustomerTickets', 'Dashboard', 'CommentsInline',
  'ToggleField', 'ToggleShow', 'TextAreaField', 'StatusBadge', 'PriorityBadge', 'TicketHeader', 'StatusEditField',
  'TicketPage', 'TicketList', 'TicketNumberCell', 'RelativeTime', 'BulkAssignForm', 'BulkGroupForm', 'BulkPriorityForm', 'BulkEditForm', 'ActivityFeed', 'PriorityMarker', 'TopBar', 'TicketNewForm', 'ColorField', 'ColorShow', 'Footer',
] as const;

// Components import each other with ".js" specifiers (NodeNext). Only compiled JavaScript satisfies that, so
// when running from sources (tsx) the bundler is pointed at dist/ if it holds a complete build
// (`npm run build` / `build:watch`). A missing or stale dist/ falls back to the sources: enough for tests,
// which never bundle, but not for serving the UI.
const compiled = path.resolve(here, '../../dist/admin');
const complete = NAMES.every((name) => existsSync(path.join(compiled, 'components', `${name}.js`)));
const dir = here.includes(`${path.sep}src${path.sep}`) && complete ? compiled : here;

export const componentLoader = new ComponentLoader();

export const Components = {
  ModeField: componentLoader.add('ModeField', path.join(dir, 'components/ModeField')),
  SetPasswordForm: componentLoader.add('SetPasswordForm', path.join(dir, 'components/SetPasswordForm')),
  ChangeRoleForm: componentLoader.add('ChangeRoleForm', path.join(dir, 'components/ChangeRoleForm')),
  GroupMembers: componentLoader.add('GroupMembers', path.join(dir, 'components/GroupMembers')),
  ChangeStatusForm: componentLoader.add('ChangeStatusForm', path.join(dir, 'components/ChangeStatusForm')),
  BulkChangeStatusForm: componentLoader.add('BulkChangeStatusForm', path.join(dir, 'components/BulkChangeStatusForm')),
  AssignForm: componentLoader.add('AssignForm', path.join(dir, 'components/AssignForm')),
  TicketHistory: componentLoader.add('TicketHistory', path.join(dir, 'components/TicketHistory')),
  CustomerTickets: componentLoader.add('CustomerTickets', path.join(dir, 'components/CustomerTickets')),
  Dashboard: componentLoader.add('Dashboard', path.join(dir, 'components/Dashboard')),
  CommentsInline: componentLoader.add('CommentsInline', path.join(dir, 'components/CommentsInline')),
  ToggleField: componentLoader.add('ToggleField', path.join(dir, 'components/ToggleField')),
  ToggleShow: componentLoader.add('ToggleShow', path.join(dir, 'components/ToggleShow')),
  TextAreaField: componentLoader.add('TextAreaField', path.join(dir, 'components/TextAreaField')),
  StatusBadge: componentLoader.add('StatusBadge', path.join(dir, 'components/StatusBadge')),
  PriorityBadge: componentLoader.add('PriorityBadge', path.join(dir, 'components/PriorityBadge')),
  TicketHeader: componentLoader.add('TicketHeader', path.join(dir, 'components/TicketHeader')),
  StatusEditField: componentLoader.add('StatusEditField', path.join(dir, 'components/StatusEditField')),
  ColorField: componentLoader.add('ColorField', path.join(dir, 'components/ColorField')),
  ColorShow: componentLoader.add('ColorShow', path.join(dir, 'components/ColorShow')),
  TicketNewForm: componentLoader.add('TicketNewForm', path.join(dir, 'components/TicketNewForm')),
  TicketPage: componentLoader.add('TicketPage', path.join(dir, 'components/TicketPage')),
  TicketList: componentLoader.add('TicketList', path.join(dir, 'components/TicketList')),
  TicketNumberCell: componentLoader.add('TicketNumberCell', path.join(dir, 'components/TicketNumberCell')),
  RelativeTime: componentLoader.add('RelativeTime', path.join(dir, 'components/RelativeTime')),
  BulkAssignForm: componentLoader.add('BulkAssignForm', path.join(dir, 'components/BulkAssignForm')),
  BulkGroupForm: componentLoader.add('BulkGroupForm', path.join(dir, 'components/BulkGroupForm')),
  BulkPriorityForm: componentLoader.add('BulkPriorityForm', path.join(dir, 'components/BulkPriorityForm')),
};

// Replaces the AdminJS top bar with one that adds the ticket search, "+ New ticket" and the bell around it.
componentLoader.override('TopBar', path.join(dir, 'components/TopBar'));

// A copyright line with the author's e-mail at the bottom of every page.
componentLoader.override('Footer', path.join(dir, 'components/Footer'));
