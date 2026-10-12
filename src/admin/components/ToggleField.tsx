import React from 'react';
import { Box, FormGroup, FormMessage, Label } from '@adminjs/design-system';
import { useTranslation, type EditPropertyProps, type ShowPropertyProps } from 'adminjs';
import { Pill } from './Badge.js';

/** A boolean as a switch in forms and a colored pill in lists and details. A missing value counts as on (new records default to active). */
export const ToggleShow = ({ record, property }: ShowPropertyProps) => {
  const on = record.params?.[property.path] !== false && record.params?.[property.path] !== 'false';
  return <Pill label={on ? 'Active' : 'Inactive'} color={on ? '#16a34a' : '#6b7280'} />;
};

const ToggleField = ({ record, property, onChange }: EditPropertyProps) => {
  const { translateProperty } = useTranslation();
  // Same contract as ModeField: new records start active, so the flag is only offered when editing.
  if (property.custom?.mode === 'editOnly' && !record?.id) return null;
  const raw = record.params?.[property.path];
  const on = raw !== false && raw !== 'false';
  const error = record.errors?.[property.path];
  const label = translateProperty(property.path, property.resourceId);
  return (
    <FormGroup error={Boolean(error)}>
      <Label>{label}</Label>
      <Box flex alignItems="center">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={label}
          disabled={property.isDisabled}
          onClick={() => onChange(property.path, !on)}
          style={{
            position: 'relative',
            width: 44,
            height: 24,
            padding: 0,
            border: 'none',
            borderRadius: 12,
            cursor: property.isDisabled ? 'not-allowed' : 'pointer',
            background: on ? '#16a34a' : '#9ca3af',
            transition: 'background .15s',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: on ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left .15s',
            }}
          />
        </button>
        <span style={{ marginLeft: 12 }}>{on ? 'Active' : 'Inactive'}</span>
      </Box>
      {property.description && <span style={{ display: 'block', marginTop: 4, fontSize: 12, opacity: 0.7 }}>{property.description}</span>}
      {error && <FormMessage>{error.message}</FormMessage>}
    </FormGroup>
  );
};

export default ToggleField;
