import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentLoader } from 'adminjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = [
  'ModeField', 'SetPasswordForm', 'ChangeRoleForm', 'GroupMembers',
  'ChangeStatusForm', 'AssignForm', 'TicketHistory', 'CustomerTickets', 'Dashboard',
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
  AssignForm: componentLoader.add('AssignForm', path.join(dir, 'components/AssignForm')),
  TicketHistory: componentLoader.add('TicketHistory', path.join(dir, 'components/TicketHistory')),
  CustomerTickets: componentLoader.add('CustomerTickets', path.join(dir, 'components/CustomerTickets')),
  Dashboard: componentLoader.add('Dashboard', path.join(dir, 'components/Dashboard')),
};
