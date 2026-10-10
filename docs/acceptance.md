# Acceptance checklist

Tick each item with evidence (test name, URL, screenshot) as stages complete.

- [~] 1. Package compatibility prototype; versions pinned (verified: build, list+FK lookup+save, custom component in production bundle; NOT verified: run inside Docker image)
- [ ] 2. Supabase `support` schema, migrations, runtime role, Session table
- [x] 3. Auth: login/logout, sessions, CSRF, rate limit; rejected-request tests (tests/unit/auth.test.ts, tests/integration/auth.test.ts; verified in Chrome: AdminJS 'Create' sends X-CSRF-Token via XHR)
- [x] 4. Policies and domain services: workflow, assignment, optimistic locking (tests/unit/workflow.test.ts, tests/integration/ticket-service.test.ts; mutation-checked: scope filter, version lock, row locks)
- [x] 5. Ticket and Customer resources: lists, search, filters, no generic-action bypass (tests/integration/admin-resources.test.ts, admin-actions.test.ts, ticket-queries.test.ts; checked in Chrome: dashboard presets, assign, change status, history, age, customer tickets, form error display)
- [ ] 6. Users, Agents, Groups, memberships, Status administration
- [ ] 7. CommentsInline create/edit within Ticket view
- [ ] 8. Attachments: upload/download/delete, reconcile, fixtures
- [ ] 9. bulkChangeStatus (all-or-nothing) and history
- [ ] 10. Seed reset/verify with 2000 tickets
- [ ] 11. Docker build, CI, HTTPS deploy, smoke tests for both roles
- [ ] 12. AI bonus (optional), README, review prep
