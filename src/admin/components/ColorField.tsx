import React from 'react';
import { FormGroup, FormMessage, Label } from '@adminjs/design-system';
import { useTranslation, type EditPropertyProps, type ShowPropertyProps } from 'adminjs';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A color chosen from the browser's palette, with the hex code beside it for typing or pasting one. */
const ColorField = ({ record, property, onChange }: EditPropertyProps) => {
  const { translateProperty } = useTranslation();
  const error = record.errors?.[property.path];
  const value = String(record.params?.[property.path] ?? '');
  return (
    <FormGroup error={Boolean(error)}>
      <Label htmlFor={property.path}>{translateProperty(property.path, property.resourceId)}</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          id={property.path}
          type="color"
          aria-label="Pick a color"
          disabled={property.isDisabled}
          value={HEX.test(value) ? value : '#3b82f6'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(property.path, e.target.value)}
          style={{ width: 56, height: 36, padding: 2, border: '1px solid #CBD5E1', borderRadius: 4, background: '#FFFFFF', cursor: 'pointer' }}
        />
        <input
          type="text"
          aria-label="Color code"
          disabled={property.isDisabled}
          value={value}
          maxLength={7}
          placeholder="#3b82f6"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(property.path, e.target.value)}
          style={{ width: 110, fontSize: 14, padding: '6px 10px', border: '1px solid #CBD5E1', borderRadius: 4 }}
        />
      </div>
      {property.description && <span style={{ display: 'block', marginTop: 4, fontSize: 12, opacity: 0.7 }}>{property.description}</span>}
      {error && <FormMessage>{error.message}</FormMessage>}
    </FormGroup>
  );
};

/** The same color as a swatch with its code, for lists and detail pages. */
export const ColorShow = ({ record, property }: ShowPropertyProps) => {
  const value = String(record.params?.[property.path] ?? '');
  if (!value) return <span>—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={{ width: 18, height: 18, borderRadius: 4, background: HEX.test(value) ? value : 'transparent', border: '1px solid #CBD5E1' }} />
      {value}
    </span>
  );
};

export default ColorField;
