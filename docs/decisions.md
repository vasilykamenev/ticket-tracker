# Decisions

Source of truth: `Support_Ticket_Tracker_Requirements_EN_v1.1.md`.

## D-001 Naming and the `com.berney` domain
The stack is TypeScript/Node.js (no JVM packages). `com.berney` is the organisation identifier and is applied to:
- npm scope: `@berney/support-ticket-tracker`
- OCI image vendor label and GHCR namespace `ghcr.io/berney/...`
- (if Java-style package folders are wanted later, move code under `src/com/berney/...`; not done by default)

## D-002 Dependency versions
Not pinned yet. Stage 1 of the plan (requirements section 14) validates a compatible set of AdminJS, `@adminjs/express`, `@adminjs/prisma`, Prisma and Node in a prototype; then pin exact versions here and in the lock file.

## D-003 Prisma multi-schema
Tables live in PostgreSQL schema `support`. The `multiSchema` syntax in `prisma/schema.prisma` must be adjusted to the chosen Prisma major.
