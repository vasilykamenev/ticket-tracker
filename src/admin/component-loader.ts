import { ComponentLoader } from 'adminjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export const componentLoader = new ComponentLoader();
export const Components = {
  Hello: componentLoader.add('Hello', path.join(dir, 'components/Hello')),
};
