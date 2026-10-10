import { Resource } from '@adminjs/prisma';
import { BaseRecord, ValidationError as AdminValidationError } from 'adminjs';
import type { ActionContext, Filter } from 'adminjs';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, ForbiddenError } from '../domain/errors.js';
import type { Actor } from '../policies/ticket-policy.js';
import type { SessionUser } from '../types/express-session.js';

type Row = Record<string, unknown>;
type Params = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Value of a reference filter meaning "no value" (e.g. unassigned tickets). */
export const NONE = '__none__';

const ALLOWED_PAGE_SIZES = [25, 50, 100];
const MAX_PAGE_SIZE = 100;
const uuid = z.uuid();
const IMPOSSIBLE: Where = { id: { in: [] } };

/** The signed-in staff member, taken from the session by the AdminJS plugin. Fails closed. */
export function actorFromContext(context?: ActionContext): Actor {
  const admin = context?.currentAdmin as Partial<SessionUser> | undefined;
  if (!admin?.id || (admin.role !== 'ADMIN' && admin.role !== 'AGENT')) {
    throw new ForbiddenError('unauthenticated', 'Sign in required');
  }
  return { userId: admin.id, role: admin.role, agentId: admin.agentId ?? null };
}

export interface GuardedOptions {
  /** Mandatory part of every read (list, count, show, search, reference lookups). AND-ed with user filters. */
  readScope?: (actor: Actor, db: PrismaClient) => Promise<Where>;
  /** Removes fields the actor must never receive. Runs on every row returned. */
  redact?: (actor: Actor, row: Row) => Row;
  /** Writes go through domain services only; without a handler the resource is read-only. */
  create?: (actor: Actor, params: Params) => Promise<Row>;
  update?: (actor: Actor, id: string, params: Params) => Promise<Row>;
  /** Maps domain field names (e.g. groupId) to AdminJS property paths (e.g. group) in error messages. */
  errorFields?: Record<string, string>;
  /**
   * AdminJS treats a record as saved unless a *property* error exists (base errors alone still show
   * "successfully updated"). Errors without a field, such as a version conflict, are attached here too.
   */
  fallbackErrorField?: string;
}

function readOnly(): never {
  throw new ForbiddenError('read_only', 'This resource cannot be changed here');
}

/**
 * Prisma-backed AdminJS resource that enforces access at the data layer: scope on every read,
 * writes only through domain services, no generic delete. AdminJS passes the action context to
 * find/count/findOne/findMany/create/update/delete, so the actor is always known; without one the
 * resource refuses to answer.
 */
export class GuardedResource extends Resource {
  private readonly db: PrismaClient;

  constructor(
    args: ConstructorParameters<typeof Resource>[0],
    private readonly guard: GuardedOptions,
  ) {
    super(args);
    this.db = args.client;
    // AdminJS decides whether to wrap a resource in its own adapter with `isAdapterFor`, which looks for
    // `model` + `client` on the object. Without this, our instance would be silently replaced by the stock
    // Resource and every guard below would be bypassed. The client is only needed here and in `this.db`.
    this.client = undefined as never;
  }

  override databaseType(): string {
    return 'postgresql';
  }

  private async where(actor: Actor, extra: Where): Promise<Where> {
    const scope = (await this.guard.readScope?.(actor, this.db)) ?? {};
    return { AND: [extra, scope] };
  }

  private toRecord(actor: Actor, row: Row): BaseRecord {
    return new BaseRecord(this.prepareReturnValues(this.guard.redact ? this.guard.redact(actor, row) : row), this);
  }

  override async count(filter: Filter, context?: ActionContext): Promise<number> {
    const actor = actorFromContext(context);
    return this.manager.count({ where: await this.where(actor, this.filterToWhere(filter)) });
  }

  override async find(
    filter: Filter,
    params: { limit?: number; offset?: number; sort?: { sortBy?: string; direction?: 'asc' | 'desc' } } = {},
    context?: ActionContext,
  ): Promise<BaseRecord[]> {
    const actor = actorFromContext(context);
    const requested = params.limit ?? ALLOWED_PAGE_SIZES[0]!;
    const take = Math.min(Math.max(requested, 1), MAX_PAGE_SIZE);
    const sort = this.buildSortBy(params.sort);
    const rows = (await this.manager.findMany({
      where: await this.where(actor, this.filterToWhere(filter)),
      skip: params.offset ?? 0,
      take,
      // `id` tie-breaker keeps pagination stable when sort values repeat.
      orderBy: [sort, { id: 'desc' }],
    })) as Row[];
    return rows.map((row) => this.toRecord(actor, row));
  }

  override async findOne(id: string | number, context?: ActionContext): Promise<BaseRecord | null> {
    const actor = actorFromContext(context);
    if (!uuid.safeParse(id).success) return null;
    const row = (await this.manager.findFirst({ where: await this.where(actor, { id }) })) as Row | null;
    return row ? this.toRecord(actor, row) : null;
  }

  override async findMany(ids: Array<string | number>, context?: ActionContext): Promise<BaseRecord[]> {
    const actor = actorFromContext(context);
    const valid = ids.filter((id) => uuid.safeParse(id).success);
    if (valid.length === 0) return [];
    const rows = (await this.manager.findMany({ where: await this.where(actor, { id: { in: valid } }) })) as Row[];
    return rows.map((row) => this.toRecord(actor, row));
  }

  override async create(params: Params, context?: ActionContext): Promise<Row> {
    const actor = actorFromContext(context);
    if (!this.guard.create) return readOnly();
    return this.prepareReturnValues(await this.mapErrors(() => this.guard.create!(actor, params)));
  }

  override async update(id: string | number, params: Params = {}, context?: ActionContext): Promise<Row> {
    const actor = actorFromContext(context);
    if (!this.guard.update) return readOnly();
    return this.prepareReturnValues(await this.mapErrors(() => this.guard.update!(actor, String(id), params)));
  }

  override async delete(): Promise<void> {
    // Records are deactivated, never deleted.
    return readOnly();
  }

  /**
   * Validation and conflict errors become AdminJS form errors (shown next to the field or as a
   * notice). Not-found and forbidden propagate and are rendered by the HTTP error handler.
   */
  private async mapErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DomainError && (err.status === 422 || err.status === 409)) {
        const entries = Object.entries(err.details ?? {});
        if (entries.length === 0) {
          const field = this.guard.fallbackErrorField;
          throw new AdminValidationError(field ? { [field]: { message: err.message } } : {}, { message: err.message });
        }
        const fields = this.guard.errorFields ?? {};
        throw new AdminValidationError(Object.fromEntries(entries.map(([key, message]) => [fields[key] ?? key, { message }])));
      }
      throw err;
    }
  }

  /**
   * Translates AdminJS filters into a Prisma `where`. Differences from the stock adapter:
   * case-insensitive substring search, and the NONE value on reference filters ("unassigned").
   * Malformed values match nothing instead of raising a database error.
   */
  private filterToWhere(filter?: Filter): Where {
    const where: Where = {};
    for (const [name, entry] of Object.entries(filter?.filters ?? {})) {
      const { property, value } = entry as unknown as { property: ReturnType<Resource['properties']>[number]; value: unknown };
      const type = property.type();
      if (type === 'reference') {
        const column = property.foreignColumnName();
        if (!column) continue;
        if (value === NONE) where[column] = null;
        else if (uuid.safeParse(value).success) where[column] = value;
        else return IMPOSSIBLE;
      } else if (type === 'boolean') {
        if (value !== 'true' && value !== false && value !== true && value !== 'false') return IMPOSSIBLE;
        where[name] = value === true || value === 'true';
      } else if (type === 'number') {
        const n = Number(value);
        if (!Number.isInteger(n)) return IMPOSSIBLE;
        where[name] = n;
      } else if (type === 'date' || type === 'datetime') {
        const range = value as { from?: string; to?: string } | string;
        if (typeof range === 'string') continue;
        const cond: Record<string, Date> = {};
        if (range.from && !Number.isNaN(Date.parse(range.from))) cond.gte = new Date(range.from);
        if (range.to && !Number.isNaN(Date.parse(range.to))) cond.lte = new Date(range.to);
        if (Object.keys(cond).length > 0) where[name] = cond;
      } else if (property.isEnum()) {
        if (!property.availableValues()?.includes(String(value))) return IMPOSSIBLE;
        where[name] = { equals: String(value) };
      } else if (uuid.safeParse(value).success) {
        where[name] = { equals: value };
      } else {
        where[name] = { contains: String(value), mode: 'insensitive' };
      }
    }
    return where;
  }
}
