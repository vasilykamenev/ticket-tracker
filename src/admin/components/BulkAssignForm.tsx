import React from 'react';
import type { ActionProps } from 'adminjs';
import BulkEditForm from './BulkEditForm.js';

/** Bulk "Assign": a group and an assignee for every selected ticket. */
const BulkAssignForm = (props: ActionProps) => <BulkEditForm {...props} mode="assign" />;

export default BulkAssignForm;
