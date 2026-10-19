# Recipe: a general contractor invites a subcontractor

A general contractor (GC) invites a subcontractor to a project with proposed terms: scope, rate, start date and retainage. The subcontractor has 14 days to accept or decline. They get reminder emails while the invitation is open. The GC can change the terms while it is pending, and the subcontractor is emailed each new version; an acceptance must be for the latest version. When the subcontractor accepts, a subcontract record is created and both sides are notified; if the invitation expires, the GC is told.

This is a classic human-in-the-loop workflow: mostly waiting, with a few decisions driven by people. In Temporal it is one workflow per invitation, and the timers cost nothing while they wait.

::: info Illustrative
The code uses Norn's real APIs; the mail and database services are placeholders.
:::

## Domain types

Shared types and errors live in a workflow-safe module, with no I/O, so both the workflow and the API can import them:

```ts
// src/invitations/domain.ts
import type { Duration } from '@norn/core';

export interface InvitationTerms {
  scope: string; // "Electrical rough-in, building B"
  rateCents: number;
  rateUnit: 'hour' | 'fixed';
  startDate: string; // YYYY-MM-DD
  retainagePercent: number;
}

export interface InvitationInput {
  invitationId: string;
  projectId: string;
  gc: { companyId: string; name: string; contactEmail: string };
  sub: { name: string; email: string };
  terms: InvitationTerms;
  /** How long the subcontractor has to respond. Default 14 days. */
  expiresIn?: Duration;
  /** Time between reminders. Default 3 days. */
  reminderEvery?: Duration;
  /** Maximum number of reminders. Default 3. */
  maxReminders?: number;
}

export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

export interface TermsChange {
  /** The version the GC was looking at, for optimistic concurrency. */
  expectedVersion: number;
  changes: Partial<InvitationTerms>;
  note?: string;
}

export interface InvitationView {
  invitationId: string;
  status: InvitationStatus;
  terms: InvitationTerms;
  termsVersion: number;
  remindersSent: number;
  expiresAt: string;
  respondedBy?: string;
  declineReason?: string;
  subcontractId?: string;
}

export class InvalidTermsError extends Error {
  override name = 'InvalidTermsError';
}
export class StaleTermsError extends Error {
  override name = 'StaleTermsError';
}
export class InvitationClosedError extends Error {
  override name = 'InvitationClosedError';
}
export class InvalidRecipientError extends Error {
  override name = 'InvalidRecipientError';
}
```

## Services

The activities need a mailer and somewhere to store subcontracts. Both are interfaces with same-named tokens, so tests can swap them:

```ts
// src/services/mailer.ts
import { Service, token } from '@norn/activity';
import { InvalidRecipientError } from '../invitations/domain.js';
import { AppConfig } from './config.js';

export interface Mailer {
  send(message: { to: string; template: string; data: Record<string, unknown>; idempotencyKey: string }): Promise<{ messageId: string }>;
}
export const Mailer = token<Mailer>('Mailer');

@Service({ provides: Mailer })
export class HttpMailer implements Mailer {
  constructor(private readonly config: AppConfig) {}

  async send(message: { to: string; template: string; data: Record<string, unknown>; idempotencyKey: string }) {
    const res = await fetch(`${this.config.mailApiUrl}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.mailApiKey}`, 'idempotency-key': message.idempotencyKey },
      body: JSON.stringify({ to: message.to, template: message.template, data: message.data }),
    });
    if (res.status === 422) throw new InvalidRecipientError(`Cannot deliver to ${message.to}`);
    if (!res.ok) throw Object.assign(new Error(`Mail API returned ${res.status}`), { status: res.status });
    return (await res.json()) as { messageId: string };
  }
}
```

```ts
// src/services/subcontracts.ts
import { Service, token } from '@norn/activity';
import type { InvitationTerms } from '../invitations/domain.js';
import { Db } from './db.js';

export interface SubcontractRecord {
  invitationId: string;
  projectId: string;
  gcCompanyId: string;
  subEmail: string;
  terms: InvitationTerms;
  termsVersion: number;
  acceptedBy: string;
}

export interface SubcontractRepository {
  createFromInvitation(record: SubcontractRecord): Promise<{ subcontractId: string }>;
}
export const SubcontractRepository = token<SubcontractRepository>('SubcontractRepository');

@Service({ provides: SubcontractRepository })
export class PgSubcontractRepository implements SubcontractRepository {
  constructor(private readonly db: Db) {}

  /** Idempotent: one subcontract per invitation, however often the activity is retried. */
  async createFromInvitation(r: SubcontractRecord) {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into subcontracts (invitation_id, project_id, gc_company_id, sub_email, terms, terms_version, accepted_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (invitation_id) do update set invitation_id = excluded.invitation_id
       returning id`,
      [r.invitationId, r.projectId, r.gcCompanyId, r.subEmail, JSON.stringify(r.terms), r.termsVersion, r.acceptedBy],
    );
    return { subcontractId: rows[0]!.id };
  }
}
```

`AppConfig` and `Db` are tokens registered in `src/providers.ts` with `provide()` (a configuration object and a `pg.Pool`); see [Dependency injection](/guide/dependency-injection#providers).

## Activities

```ts
// src/activities/invitation.activities.ts
import { Activities, Activity, NonRetryable, idempotencyKey } from '@norn/activity';
import { InvalidRecipientError, type InvitationTerms } from '../invitations/domain.js';
import { AppConfig } from '../services/config.js';
import { Mailer } from '../services/mailer.js';
import { SubcontractRepository, type SubcontractRecord } from '../services/subcontracts.js';

export interface InvitationEmail {
  invitationId: string;
  to: string;
  subName: string;
  gcName: string;
  terms: InvitationTerms;
  termsVersion: number;
  expiresAt: string;
}

@Activities({ prefix: 'invitations.' })
@NonRetryable([InvalidRecipientError]) // a bad address won't get better with retries
export class InvitationActivities {
  constructor(
    private readonly mailer: Mailer,
    private readonly subcontracts: SubcontractRepository,
    private readonly config: AppConfig,
  ) {}

  @Activity({ timeout: '30s', retries: 8 })
  async sendInvitation(email: InvitationEmail) {
    return this.mail(email.to, 'subcontractor-invitation', email);
  }

  @Activity({ timeout: '30s', retries: 8 })
  async sendReminder(email: InvitationEmail & { reminder: number }) {
    return this.mail(email.to, 'subcontractor-invitation-reminder', email);
  }

  @Activity({ timeout: '30s', retries: 8 })
  async sendTermsChanged(email: InvitationEmail & { note?: string }) {
    return this.mail(email.to, 'subcontractor-invitation-terms-changed', email);
  }

  /** Tells the GC what happened: accepted, declined or expired. */
  @Activity({ timeout: '30s', retries: 8 })
  async notifyGc(to: string, outcome: 'accepted' | 'declined' | 'expired', data: Record<string, unknown>) {
    return this.mail(to, `subcontractor-invitation-${outcome}`, data);
  }

  @Activity({ timeout: '30s', retries: 10 })
  async createSubcontract(record: SubcontractRecord) {
    return this.subcontracts.createFromInvitation(record);
  }

  private mail(to: string, template: string, data: object) {
    const link = 'invitationId' in data ? `${this.config.appUrl}/invitations/${String(data.invitationId)}` : undefined;
    // Stable across retries of this activity, so the provider never sends the same email twice.
    return this.mailer.send({ to, template, data: { ...data, link }, idempotencyKey: idempotencyKey() });
  }
}
```

## The workflow

```ts
// src/workflows/subcontractor-invitation.workflow.ts
import { condition } from '@temporalio/workflow';
import { toMs } from '@norn/core';
import { Query, Signal, Update, Validate, Workflow, setSearchAttributes, transitions, useActivities } from '@norn/workflow';
import { InvitationActivities } from '../../.norn/activities.js';
import {
  InvalidTermsError,
  InvitationClosedError,
  StaleTermsError,
  type InvitationInput,
  type InvitationTerms,
  type InvitationView,
  type TermsChange,
} from '../invitations/domain.js';

@Workflow({
  taskQueue: 'invitations',
  id: 'invitation-{invitationId}',
  versioning: 'pinned',
  searchAttributes: { ProjectId: 'keyword', GcCompanyId: 'keyword', InvitationStatus: 'keyword' },
  description: 'A subcontractor invitation: reminders, term changes, acceptance or expiry.',
})
export class SubcontractorInvitationWorkflow {
  private readonly notify = useActivities(InvitationActivities);
  private readonly status = transitions(
    { pending: ['accepted', 'declined', 'expired', 'revoked'], accepted: [], declined: [], expired: [], revoked: [] },
    'pending',
  );
  private readonly invitationId: string;
  private terms: InvitationTerms;
  private termsVersion = 1;
  private termsNote: string | undefined;
  private remindersSent = 0;
  private expiresAt = 0;
  private respondedBy: string | undefined;
  private declineReason: string | undefined;
  private subcontractId: string | undefined;

  constructor(input: InvitationInput) {
    this.invitationId = input.invitationId;
    this.terms = { ...input.terms };
  }

  /** The subcontractor accepts a specific version of the terms. */
  @Signal() accept(response: { userId: string; termsVersion: number }) {
    // An acceptance of terms that have since changed doesn't count; the UI shows the latest version.
    if (response.termsVersion !== this.termsVersion) return;
    if (this.status.move('accepted')) this.respondedBy = response.userId;
  }

  @Signal() decline(response: { userId: string; reason?: string }) {
    if (this.status.move('declined')) {
      this.respondedBy = response.userId;
      this.declineReason = response.reason;
    }
  }

  /** The GC withdraws the invitation. */
  @Signal() revoke(request: { userId: string }) {
    if (this.status.move('revoked')) this.respondedBy = request.userId;
  }

  @Query() view(): InvitationView {
    return {
      invitationId: this.invitationId,
      status: this.status.current,
      terms: { ...this.terms },
      termsVersion: this.termsVersion,
      remindersSent: this.remindersSent,
      expiresAt: new Date(this.expiresAt).toISOString(),
      ...(this.respondedBy ? { respondedBy: this.respondedBy } : {}),
      ...(this.declineReason ? { declineReason: this.declineReason } : {}),
      ...(this.subcontractId ? { subcontractId: this.subcontractId } : {}),
    };
  }

  @Validate('changeTerms') checkTermsChange(change: TermsChange) {
    if (!this.status.is('pending')) throw new InvitationClosedError(`The invitation is ${this.status.current}`);
    if (change.expectedVersion !== this.termsVersion) {
      throw new StaleTermsError(`The terms are at version ${this.termsVersion}; reload and try again`);
    }
    const next = { ...this.terms, ...change.changes };
    if (!next.scope?.trim()) throw new InvalidTermsError('Scope is required');
    if (!Number.isInteger(next.rateCents) || next.rateCents <= 0) throw new InvalidTermsError('Rate must be a positive amount');
    if (next.retainagePercent < 0 || next.retainagePercent > 10) throw new InvalidTermsError('Retainage must be between 0% and 10%');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(next.startDate)) throw new InvalidTermsError('Start date must be YYYY-MM-DD');
  }

  /** Changes the terms of a pending invitation and returns the new version. The subcontractor is emailed. */
  @Update() changeTerms(change: TermsChange): { termsVersion: number; terms: InvitationTerms } {
    this.terms = { ...this.terms, ...change.changes };
    this.termsVersion++;
    this.termsNote = change.note;
    return { termsVersion: this.termsVersion, terms: { ...this.terms } };
  }

  async run(input: InvitationInput): Promise<InvitationView> {
    setSearchAttributes({ ProjectId: input.projectId, GcCompanyId: input.gc.companyId, InvitationStatus: 'pending' });
    this.expiresAt = Date.now() + toMs(input.expiresIn ?? '14 days');
    const reminderEvery = toMs(input.reminderEvery ?? '3 days');
    const maxReminders = input.maxReminders ?? 3;

    const email = () => ({
      invitationId: input.invitationId,
      to: input.sub.email,
      subName: input.sub.name,
      gcName: input.gc.name,
      terms: { ...this.terms },
      termsVersion: this.termsVersion,
      expiresAt: new Date(this.expiresAt).toISOString(),
    });

    await this.notify.sendInvitation(email());
    let emailedVersion = this.termsVersion;
    let nextReminderAt = Date.now() + reminderEvery;

    while (this.status.is('pending')) {
      const now = Date.now();
      if (now >= this.expiresAt) {
        this.status.move('expired');
        break;
      }
      if (this.termsVersion !== emailedVersion) {
        emailedVersion = this.termsVersion;
        await this.notify.sendTermsChanged({ ...email(), note: this.termsNote });
        continue;
      }
      if (this.remindersSent < maxReminders && now >= nextReminderAt) {
        this.remindersSent++;
        await this.notify.sendReminder({ ...email(), reminder: this.remindersSent });
        nextReminderAt = now + reminderEvery;
        continue;
      }
      // Sleep until a response, a terms change, the next reminder or the expiry, whichever comes first.
      const wakeAt = this.remindersSent < maxReminders ? Math.min(nextReminderAt, this.expiresAt) : this.expiresAt;
      await condition(() => !this.status.is('pending') || this.termsVersion !== emailedVersion, wakeAt - now);
    }

    setSearchAttributes({ InvitationStatus: this.status.current });
    const summary = { invitationId: input.invitationId, projectId: input.projectId, subName: input.sub.name };

    if (this.status.is('accepted')) {
      const { subcontractId } = await this.notify.createSubcontract({
        invitationId: input.invitationId,
        projectId: input.projectId,
        gcCompanyId: input.gc.companyId,
        subEmail: input.sub.email,
        terms: { ...this.terms },
        termsVersion: this.termsVersion,
        acceptedBy: this.respondedBy!,
      });
      this.subcontractId = subcontractId;
      await this.notify.notifyGc(input.gc.contactEmail, 'accepted', { ...summary, subcontractId });
    } else if (this.status.is('declined')) {
      await this.notify.notifyGc(input.gc.contactEmail, 'declined', { ...summary, reason: this.declineReason });
    } else if (this.status.is('expired')) {
      await this.notify.notifyGc(input.gc.contactEmail, 'expired', summary);
    }
    return this.view();
  }
}
```

Things worth noticing:

- **One loop, one wait.** The `while` loop handles every kind of wake-up: a response (a signal moves the state machine), a terms change (the update bumps `termsVersion`), the next reminder, or expiry. `condition()` with a timeout returns as soon as any of them is due. The timeout is always positive, because the branches above it handle everything that is already due.
- **The update returns immediately; the email follows.** `changeTerms` only changes state and returns the new version to the GC's request. The loop notices the version change and emails the subcontractor, with retries, outside the request path.
- **Validators protect history.** A stale or invalid change is rejected before it is written to history, and the API gets a 422 with `failureType` `StaleTermsError`, `InvalidTermsError` or `InvitationClosedError`.
- **`transitions()` absorbs races.** If the subcontractor declines at the same moment the invitation expires, whichever is processed first wins and the other is ignored.
- **`accept` is a signal**, so the API can't tell whether an acceptance of stale terms counted. If your UI needs that answer synchronously, make `accept` an `@Update` with a `@Validate('accept')` that checks `termsVersion`, exactly like `changeTerms`.
- **Pinned versioning**, because invitations live for two weeks and it's simplest if each one finishes on the code it started with. See [Versioning](/guide/versioning).

## The API

```ts
// src/api/invitations.ts
import { Hono } from 'hono';
import type { NornEnv } from '@norn/hono';
import { SubcontractorInvitationWorkflow } from '../../.norn/contracts.js';
import type { InvitationTerms, TermsChange } from '../invitations/domain.js';
import { currentCompany, currentUser } from './auth.js';

export const invitations = new Hono<NornEnv>();
const flow = (c: { var: NornEnv['Variables'] }) => c.var.norn.workflow(SubcontractorInvitationWorkflow);

invitations.post('/projects/:projectId/invitations', async (c) => {
  const body = await c.req.json<{ sub: { name: string; email: string }; terms: InvitationTerms }>();
  const gc = await currentCompany(c);
  const invitationId = crypto.randomUUID();
  await flow(c).start({ invitationId, projectId: c.req.param('projectId'), gc, sub: body.sub, terms: body.terms });
  return c.json({ invitationId }, 201);
});

invitations.get('/invitations/:invitationId', async (c) => {
  return c.json(await flow(c).get({ invitationId: c.req.param('invitationId') }).query('view'));
});

invitations.patch('/invitations/:invitationId/terms', async (c) => {
  const change = await c.req.json<TermsChange>();
  // 422 UPDATE_REJECTED with details.failureType when the validator rejects it
  const result = await flow(c).get({ invitationId: c.req.param('invitationId') }).update('changeTerms', change);
  return c.json(result);
});

invitations.post('/invitations/:invitationId/accept', async (c) => {
  const { termsVersion } = await c.req.json<{ termsVersion: number }>();
  const user = await currentUser(c); // authorise: the user must be the invited subcontractor
  await flow(c).get({ invitationId: c.req.param('invitationId') }).signal('accept', { userId: user.id, termsVersion });
  return c.body(null, 202);
});

invitations.post('/invitations/:invitationId/decline', async (c) => {
  const { reason } = await c.req.json<{ reason?: string }>();
  const user = await currentUser(c);
  await flow(c).get({ invitationId: c.req.param('invitationId') }).signal('decline', { userId: user.id, reason });
  return c.body(null, 202);
});

invitations.get('/projects/:projectId/invitations', async (c) => {
  const open = [];
  for await (const w of flow(c).list(`ProjectId = "${c.req.param('projectId')}" AND InvitationStatus = "pending"`)) {
    open.push({ workflowId: w.workflowId, startedAt: w.startTime });
  }
  return c.json(open);
});
```

Mount it with `app.use(temporal({}))` and `app.onError(nornErrorHandler())` (see [Hono integration](/guide/hono)). Signalling a closed invitation returns **409** `WORKFLOW_CLOSED`, and an unknown ID **404**. In production, validate `projectId` before interpolating it into a visibility query.

## Tests

Time-skipping makes a 14-day workflow a sub-second test:

```ts
// test/subcontractor-invitation.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockActivities, useTestEnv } from '@norn/testing/vitest';
import { InvitationActivities } from '../.norn/activities.js';
import { SubcontractorInvitationWorkflow } from '../.norn/contracts.js';
import { registry } from '../.norn/registry.js';
import type { InvitationInput } from '../src/invitations/domain.js';

const notify = mockActivities(InvitationActivities, {
  sendInvitation: async () => ({ messageId: 'm-invite' }),
  sendReminder: async () => ({ messageId: 'm-reminder' }),
  sendTermsChanged: async () => ({ messageId: 'm-terms' }),
  notifyGc: async () => ({ messageId: 'm-gc' }),
  createSubcontract: async (record) => ({ subcontractId: `sc-${record.invitationId}` }),
});
const env = useTestEnv({ registry, mode: 'time-skipping', activities: notify });
beforeEach(() => vi.clearAllMocks());

let n = 0;
const input = (): InvitationInput => ({
  invitationId: `inv-${Date.now()}-${n++}`,
  projectId: 'proj-1',
  gc: { companyId: 'gc-1', name: 'Acme Builders', contactEmail: 'pm@acme.example' },
  sub: { name: 'Sparks Electric', email: 'office@sparks.example' },
  terms: { scope: 'Electrical rough-in', rateCents: 9_000, rateUnit: 'hour', startDate: '2026-11-02', retainagePercent: 5 },
});

describe('SubcontractorInvitationWorkflow', () => {
  it('sends three reminders, then expires and tells the GC', async () => {
    const invite = await env.workflow(SubcontractorInvitationWorkflow).start(input());
    expect((await invite.result()).status).toBe('expired');
    expect(notify.sendReminder).toHaveBeenCalledTimes(3);
    expect(notify.notifyGc).toHaveBeenCalledWith('pm@acme.example', 'expired', expect.anything());
  });

  it('is pending with one reminder after four days', async () => {
    const invite = await env.workflow(SubcontractorInvitationWorkflow).start(input());
    await env.sleep('4 days');
    expect(await invite.query('view')).toMatchObject({ status: 'pending', remindersSent: 1 });
  });

  it('accepts the latest terms and creates the subcontract', async () => {
    const invite = await env.workflow(SubcontractorInvitationWorkflow).start(input());
    const { termsVersion } = await invite.update('changeTerms', { expectedVersion: 1, changes: { rateCents: 9_500 } });
    expect(termsVersion).toBe(2);

    await invite.signal('accept', { userId: 'u-sub', termsVersion: 1 }); // stale: ignored
    await invite.signal('accept', { userId: 'u-sub', termsVersion: 2 });
    const view = await invite.result();

    expect(view).toMatchObject({ status: 'accepted', termsVersion: 2, subcontractId: `sc-${invite.workflowId.slice('invitation-'.length)}` });
    expect(notify.sendTermsChanged).toHaveBeenCalledOnce();
    expect(notify.createSubcontract).toHaveBeenCalledWith(expect.objectContaining({ termsVersion: 2, acceptedBy: 'u-sub' }));
  });

  it('rejects stale and invalid term changes without touching history', async () => {
    const invite = await env.workflow(SubcontractorInvitationWorkflow).start(input());
    await expect(invite.update('changeTerms', { expectedVersion: 7, changes: {} })).rejects.toMatchObject({
      code: 'UPDATE_REJECTED',
      failureType: 'StaleTermsError',
    });
    await expect(invite.update('changeTerms', { expectedVersion: 1, changes: { retainagePercent: 25 } })).rejects.toMatchObject({
      failureType: 'InvalidTermsError',
    });
    expect((await invite.query('view')).termsVersion).toBe(1);
    await invite.signal('decline', { userId: 'u-sub', reason: 'Fully booked' });
    expect((await invite.result()).status).toBe('declined');
  });
});
```

The test environment still builds the real container at startup (every singleton service), so providers must be constructible in tests: a `pg.Pool` connects lazily and is fine; anything that connects eagerly should be replaced with `container: { overrides: [...] }`.

## Variations

- **Escalation.** After the second reminder, also email the GC's project manager: one more branch in the loop.
- **Business-day expiry.** Use `businessCalendar()` and `addBusinessDays()` to expire after 10 business days.
- **Bulk invitations.** Inviting 30 subs to bid is 30 workflows; start them from an activity of a parent "bid package" workflow, or from the API in a loop with `ifRunning: 'useExisting'` for idempotency.
- **Documents.** Collect insurance certificates with an `@Update() uploadDocument(...)` and a validator, and require them before `accept` counts.
