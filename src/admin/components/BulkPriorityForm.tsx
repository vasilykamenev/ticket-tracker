import React from 'react';
import type { ActionProps } from 'adminjs';
import BulkEditForm from './BulkEditForm.js';

/** Bulk "Change priority". */
const BulkPriorityForm = (props: ActionProps) => <BulkEditForm {...props} mode="priority" />;

export default BulkPriorityForm;
