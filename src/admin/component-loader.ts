import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentLoader } from 'adminjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

export const componentLoader = new ComponentLoader();

// More components (CommentsInline, GroupMembers, status/assign forms) are registered here as they are built.
export const Components = {
  ReadOnlyWhenEditing: componentLoader.add('ReadOnlyWhenEditing', path.join(dir, 'components/ReadOnlyWhenEditing')),
};
