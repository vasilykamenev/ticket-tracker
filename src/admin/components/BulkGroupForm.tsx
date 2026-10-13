import React from 'react';
import type { ActionProps } from 'adminjs';
import BulkEditForm from './BulkEditForm.js';

/** Bulk "Change group": a group (and optionally an assignee of it) for every selected ticket. */
const BulkGroupForm = (props: ActionProps) => <BulkEditForm {...props} mode="group" />;

export default BulkGroupForm;
