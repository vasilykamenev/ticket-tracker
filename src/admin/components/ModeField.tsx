import React from 'react';
import { FormGroup, Label, Text } from '@adminjs/design-system';
import { BasePropertyComponent, type EditPropertyProps } from 'adminjs';

/**
 * AdminJS uses one set of visible properties for both "new" and "edit". Group, customer and assignee
 * are chosen when a ticket is created but are changed later only through dedicated actions, so on an
 * existing record they are shown read-only. (The server rejects changes to them regardless.)
 */
const ReadOnlyWhenEditing = (props: EditPropertyProps) => {
  const { record, property } = props;

  if (!record?.id) {
    // Creating: the stock reference select. Dropping `components` stops BasePropertyComponent from recursing into this one.
    return <BasePropertyComponent {...props} property={{ ...property, components: undefined }} />;
  }

  const populated = record.populated?.[property.path];
  return (
    <FormGroup>
      <Label>{property.label}</Label>
      <Text>{populated?.title ?? String(record.params?.[property.path] ?? '—')}</Text>
      <Text variant="sm">
        {property.path === 'customer' ? 'The customer cannot be changed after creation.' : 'Change this with the Assign action.'}
      </Text>
    </FormGroup>
  );
};

export default ReadOnlyWhenEditing;
