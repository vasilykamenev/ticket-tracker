import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentLoader } from 'adminjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Components import each other with ".js" specifiers (NodeNext). Only compiled JavaScript satisfies that, so
// when running from sources (tsx) the bundler is pointed at dist/ if it exists (`npm run build` / `build:watch`).
// Without dist/ the sources are used: enough for tests, which never bundle, but not for serving the UI.
const compiled = path.resolve(here, '../../dist/admin');
const dir = here.includes(`${path.sep}src${path.sep}`) && existsSync(path.join(compiled, 'components')) ? compiled : here;

export const componentLoader = new ComponentLoader();

export const Components = {
  ReadOnlyWhenEditing: componentLoader.add('ReadOnlyWhenEditing', path.join(dir, 'components/ReadOnlyWhenEditing')),
  ChangeStatusForm: componentLoader.add('ChangeStatusForm', path.join(dir, 'components/ChangeStatusForm')),
  AssignForm: componentLoader.add('AssignForm', path.join(dir, 'components/AssignForm')),
  TicketHistory: componentLoader.add('TicketHistory', path.join(dir, 'components/TicketHistory')),
  CustomerTickets: componentLoader.add('CustomerTickets', path.join(dir, 'components/CustomerTickets')),
  Dashboard: componentLoader.add('Dashboard', path.join(dir, 'components/Dashboard')),
};
