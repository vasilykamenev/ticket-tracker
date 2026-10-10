import React from 'react';
import { FormGroup, Label, Text } from '@adminjs/design-system';
import { BasePropertyComponent, useTranslation, type EditPropertyProps } from 'adminjs';

/**
 * AdminJS uses one set of visible properties for both "new" and "edit". This component decides per
 * mode, from `property.custom`:
 *   mode: 'readonlyOnEdit' (default)  stock input when creating, plain text when editing
 *         'createOnly'                stock input when creating, nothing when editing
 *         'editOnly'                  nothing when creating, stock input when editing
 *   hint: text under a read-only value, e.g. which action changes it
 * The server rejects forbidden changes regardless; this only keeps the forms honest.
 */
const ModeField = (props: EditPropertyProps) => {
  const { record, property } = props;
  const { translateProperty } = useTranslation();
  const mode: string = property.custom?.mode ?? 'readonlyOnEdit';
  const editing = Boolean(record?.id);
  // Dropping `components` stops BasePropertyComponent from recursing into this component.
  const stock = <BasePropertyComponent {...props} property={{ ...property, components: undefined }} />;

  if (mode === 'createOnly') return editing ? null : stock;
  if (mode === 'editOnly') return editing ? stock : null;
  if (!editing) return stock;

  const populated = record.populated?.[property.path];
  return (
    <FormGroup>
      <Label>{translateProperty(property.path, property.resourceId)}</Label>
      <Text>{populated?.title ?? String(record.params?.[property.path] ?? '—')}</Text>
      {property.custom?.hint && <Text variant="sm">{property.custom.hint}</Text>}
    </FormGroup>
  );
};

export default ModeField;
