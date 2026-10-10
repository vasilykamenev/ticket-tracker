import React from 'react';
import { Box } from '@adminjs/design-system';
import type { BasePropertyProps } from 'adminjs';

// Stage 1 prototype: proves a custom component builds and renders in the production bundle.
const Hello = (props: BasePropertyProps) => (
  <Box>Custom component OK: {String(props.record?.params?.subject ?? '')}</Box>
);
export default Hello;
