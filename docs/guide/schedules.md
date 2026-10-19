# Schedules

Temporal [schedules](https://docs.temporal.io/schedule) start a workflow on a calendar: every night at 02:00, every weekday at 09:00 in Chicago, the first of every month. In Norn you declare them next to the workflow with `@Schedule`, and `norn schedules sync` makes the server match your code.

```ts
import { Schedule, Workflow, useActivities } from '@norn/workflow';
import { NotificationActivities } from '../../.norn/activities.js';

/** Emails the ops team every morning. */
@Workflow({ taskQueue: 'reports' })
@Schedule('0 9 * * 1-5', { id: 'daily-sales-report', timeZone: 'America/Chicago', note: 'Morning sales summary' })
export class DailyReportWorkflow {
  private readonly notify = useActivities(NotificationActivities);

  async run() {
    await this.notify.email('ops@example.com', 'daily_report', {});
    return 'sent';
  }
}
```

## `@Schedule(cron, options)`

The first argument is a cron expression (five fields: minute, hour, day of month, month, day of week) or an array of them; a schedule with several expressions fires on each. Options:

| Option | Default | Description |
| --- | --- | --- |
| `id` | workflow name in kebab case | Schedule ID, such as `'daily-sales-report'`. IDs must be unique across the project. |
| `input` | none | Input passed to every run. Must be JSON, and is type-checked against `run()`'s input. |
| `overlap` | `'skip'` | What to do when the previous run is still going at the next fire time: `'skip'`, `'buffer-one'`, `'buffer-all'`, `'cancel-other'`, `'terminate-other'` or `'allow-all'`. |
| `timeZone` | UTC | IANA time zone for the cron expression, such as `'America/New_York'`. Daylight-saving transitions are handled by the server. |
| `pauseOnFailure` | `false` | Pause the schedule after a failed run, so a broken job doesn't fail every hour. |
| `paused` | `false` | Create the schedule paused. |
| `note` | none | A human-readable note shown in the Temporal UI. |

A workflow can have several `@Schedule` decorators, each with its own ID:

```ts
@Schedule('0 2 * * *', { id: 'nightly-report', input: { kind: 'daily' }, timeZone: 'America/New_York', overlap: 'buffer-one' })
@Schedule(['0 9 * * 1', '0 9 * * 4'], { input: { kind: 'weekly' }, pauseOnFailure: true })
@Workflow({ taskQueue: 'reports' })
export class ReportWorkflow {
  async run(input: { kind: 'daily' | 'weekly' }) {
    // ...
  }
}
```

`@Schedule` only records metadata; it changes nothing at runtime. `norn gen` validates the expressions and options and writes them to `.norn/schedules.json`:

```json
[
  {
    "id": "nightly-report",
    "workflowType": "ReportWorkflow",
    "taskQueue": "reports",
    "cron": ["0 2 * * *"],
    "input": { "kind": "daily" },
    "overlap": "buffer-one",
    "timeZone": "America/New_York"
  },
  {
    "id": "report-workflow",
    "workflowType": "ReportWorkflow",
    "taskQueue": "reports",
    "cron": ["0 9 * * 1", "0 9 * * 4"],
    "input": { "kind": "weekly" },
    "pauseOnFailure": true
  }
]
```

## `norn schedules sync`

```sh
norn schedules sync --dry-run   # show what would change
norn schedules sync             # create or update schedules to match schedules.json
norn schedules sync --prune     # also delete norn-managed schedules that are no longer declared
```

`sync` connects with `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` and `TEMPORAL_TLS_CERT` / `TEMPORAL_TLS_KEY` (see [the CLI page](/guide/cli#norn-schedules-sync)); `--config <path>` picks the config file. It creates schedules that don't exist, updates ones whose spec or options changed, and with `--prune` deletes schedules that Norn created but that are no longer declared. Schedules it creates carry the memo `{ nornManaged: true }`; schedules without it are never modified or deleted, and a declared ID that already belongs to one is reported as a `conflict` (exit 1). Run it in your deploy pipeline after the new workers are up, so the first run of a new schedule finds a worker.

Schedules created this way are ordinary Temporal schedules: you can pause, trigger or backfill them from the Temporal UI or CLI (`temporal schedule trigger --schedule-id nightly-report`). If you pause a schedule by hand during an incident, `sync` leaves it alone while its declaration is unchanged; once the declaration changes, `sync` updates the schedule and sets `paused` back to what the code declares. The dry run lists such schedules as `updated`.

## Schedules vs long-running loops

A schedule starts a **new, short workflow** for every fire time. That gives you clean histories, per-run visibility, overlap policies, catch-up after outages and pause/backfill from the UI. A workflow that loops with `sleep('1 day')` is better when each iteration depends on state from the previous one; see [Long-running workflows](/guide/long-running).
