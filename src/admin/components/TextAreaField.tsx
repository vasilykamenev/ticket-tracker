import React from 'react';
import { FormGroup, FormMessage, Label, TextArea } from '@adminjs/design-system';
import { useTranslation, type EditPropertyProps } from 'adminjs';

/** A multi-line input of about ten rows that scrolls instead of growing. */
const TextAreaField = ({ record, property, onChange }: EditPropertyProps) => {
  const { translateProperty } = useTranslation();
  const error = record.errors?.[property.path];
  return (
    <FormGroup error={Boolean(error)}>
      <Label htmlFor={property.path}>{translateProperty(property.path, property.resourceId)}</Label>
      <TextArea
        id={property.path}
        width="100%"
        rows={10}
        disabled={property.isDisabled}
        value={String(record.params?.[property.path] ?? '')}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(property.path, e.target.value)}
        style={{ minHeight: 220, maxHeight: 220, overflowY: 'auto', resize: 'vertical' }}
      />
      {property.description && <span style={{ display: 'block', marginTop: 4, fontSize: 12, opacity: 0.7 }}>{property.description}</span>}
      {error && <FormMessage>{error.message}</FormMessage>}
    </FormGroup>
  );
};

export default TextAreaField;
