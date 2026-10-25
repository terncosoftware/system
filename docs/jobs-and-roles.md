# Jobs & Roles — Keeping the System Ticking

Tracking: **TRN-153** (Infrastructure), with workstreams **TRN-154** (schema),
**TRN-155** (RoleManager), **TRN-156** (JobScheduler + Schedule), **TRN-157**
(JobRunner), **TRN-158** (migration), **TRN-159** (observability).

Every worker today keeps itself ticking with a hand-rolled `setTimeout` loop
buried inside a bespoke FlowComponent. `ExperimentLifecycle` sweeps all domains
every 30s; `StatsAggregator` flushes roll-ups every 2s; the discovery sources
re-poll every 30s; `@terncosoftware/worker` (system-worker) is literally a
`setInterval` that logs `Hello from worker!`. Each of these re-implements the
same loop, swallows its own errors, and self-schedules with the
`void this._run()` pattern our conventions forbid.

There are two problems hiding in that sameness. The first is **coordination**:
run a worker two-up and *both* replicas sweep the same domains, racing each
other to freeze experiment winners. A shared subscription on the bus protects
*event* work, but tick work has no such guard. The second is **durability**: the
schedule lives only in process memory. A restart forgets when anything is due;
nothing records that a tick ran, succeeded, or failed; a crash mid-sweep is
invisible.

This design replaces all of it with one small, durable primitive. The guiding
constraint is **simple and durable** — no new infrastructure. Postgres is
already open in every worker's `main.ts`, already survives restarts, and already
gives us the two locking idioms we need. We add nothing else: no ZooKeeper, no
etcd, no Redis lock that evaporates when the holder pauses.

## Two primitives

There is only ever a row in a table and a query against it. Everything else is
arrangement.

### Roles — *who does what*

A **role** is a named, capped-N responsibility a process holds for as long as it
keeps a lease alive. The default cap is 1, which makes a role exactly
per-responsibility leader election. `labs.lifecycle`, `labs.stats`,
`tubemail.dispatcher`, `sys.scheduler` are roles.

A process declares the roles it is *willing* to play and, on a heartbeat,
tries to claim a free slot:

```sql
UPDATE sys_role_lease
   SET holder_id = :me, acquired_at = now(), expires_at = now() + :ttl
 WHERE role = :role AND slot = :slot
   AND (holder_id IS NULL OR expires_at < now());
```

If the update touches a row, the process holds that slot — but only for as long
as it keeps renewing (the same statement, run every `ttl/3`). Stop renewing —
crash, pause, partition — and the lease simply expires; the next willing process
claims it on its next heartbeat. Crash recovery is not a feature we build; it is
the absence of one. There is no janitor, no cleanup job, no fencing token
ceremony. A guarded piece of work asks `roleManager.holds('labs.lifecycle')`
before it acts, and that boolean is an O(1) read of an in-memory set.

That single `UPDATE ... WHERE expires_at < now()` is the *entire* leader
election. We deliberately do not reach for a consensus protocol; the cost of a
brief double-hold during clock skew is bounded by handlers being idempotent,
which they already are.

### Jobs — *what runs, and when*

A **job** is a durable, named unit of scheduled work: an id, a cadence, an
optional required role, and a handler reference (see *Handler references*).
Each job row carries its `next_run_at`.

The process holding the `*.scheduler` role runs a cheap tick:

```sql
SELECT * FROM sys_job
 WHERE enabled AND next_run_at <= now()
 ORDER BY next_run_at
 FOR UPDATE SKIP LOCKED;
```

For each due job it inserts a `sys_job_run` row (`pending`) and advances
`next_run_at` to the schedule's next fire. A **runner** — any process, scaled to
taste — claims pending runs with the same `FOR UPDATE SKIP LOCKED` idiom,
executes the handler inside its own fresh `ctx` and transaction, and records the
outcome with duration and error. Failures retry with capped exponential backoff
up to `max_attempts`, then park as `dead`.

`SKIP LOCKED` is doing the quiet heavy lifting: it lets N runners drain the same
queue with zero contention and zero double-execution, no distributed lock
required. The dedup safety rail is a unique constraint —
`unique (job_id, scheduled_for, attempt)` — which turns a racing second
scheduler into a harmless no-op.

Jobs and roles **compose**. The scheduler tick is itself just a role. A job may
*require* a role, which means it only fires on that role's holder. The lifecycle
sweep stops being a loop and becomes a registered job
(`labs.lifecycle.sweep`, every 30s, `requires_role: labs.lifecycle`) — and now
it runs on exactly one replica because exactly one replica holds the role.

## Scheduling: beyond cron

The cadence is *not* a raw cron string by default. Cron is cryptic (`0 3 * * *`
— is that 3am, or three-past-every-hour?), positional, timezone-blind, and
cannot express anything finer than a minute. Instead a job carries a typed,
named-field `Schedule` descriptor, stored as `jsonb` and type-checked where it
is registered:

```ts
type Schedule =
  | { every: Duration; jitter?: Duration }            // "PT30S" | "30s" | "5m" | "1h"
  | { daily: TimeOfDay; tz?: Tz }                      // { daily: "03:00", tz: "America/Toronto" }
  | { weekly: { day: Weekday; at: TimeOfDay }; tz?: Tz }
  | { monthly: { day: number; at: TimeOfDay }; tz?: Tz }
  | { cron: string; tz?: Tz };                         // escape hatch, nothing more
```

What this buys over cron:

- **Named fields, not positions.** The schedule reads as what it does; there is
  no off-by-one between the minute and hour slots.
- **Timezone is first-class.** Every kind takes an IANA `tz`. Cron has no notion
  of one, which is where its daylight-saving bugs come from. Here they
  disappear.
- **ISO-8601 durations for intervals**, including sub-minute (`PT30S`), which
  cron cannot express at all.
- **Jitter.** An optional `jitter` spreads a herd of jobs that share a cadence;
  raw cron fires all of them on the `:00` and stampedes the database.
- **Build-time validation.** A malformed schedule is a `tsc` error, not a 3am
  page.

Cron survives only as a labelled escape hatch for the genuinely irregular case,
confined to its own branch. All five kinds collapse to one pure function,
`nextRun(schedule, after): Date`, which is the only scheduling logic in the
system and is exhaustively unit-testable — including across a DST boundary in a
non-UTC zone.

## Data model

Three relational control-plane tables (system migrations,
`packages/data/src/migrations`). These are platform plumbing, not domain data,
so they are plain relational rows, not RDF. No triggers, no extensions.

```
sys_role_lease  primary key (role, slot)
  holder_id text          -- process instance id; null when free
  acquired_at timestamptz
  expires_at  timestamptz not null  -- lease deadline; < now() == free
  meta jsonb
  index (expires_at)

sys_job  primary key (id)            -- 'labs.lifecycle.sweep'
  schedule jsonb not null            -- the Schedule descriptor above
  handler text not null              -- module:// ref, or an in-process registerJob id
  requires_role text                 -- null = any worker may run it
  enabled boolean not null default true
  next_run_at timestamptz not null
  max_attempts smallint not null default 1
  meta jsonb
  index (enabled, next_run_at)       -- the scheduler's due scan

sys_job_run  primary key (id uuid)   -- durable history AND claim queue
  job_id text not null references sys_job
  scheduled_for timestamptz not null
  status text not null               -- pending|running|succeeded|failed|dead
  attempt smallint not null default 1
  claimed_by text
  started_at timestamptz
  finished_at timestamptz
  error text
  unique (job_id, scheduled_for, attempt)   -- dedup safety rail
  index (status, scheduled_for)             -- the runner's claim scan
```

`sys_job_run` is deliberately both the work queue and the audit log. Nothing
runs without leaving a row, so "did this fire?" and "why did it fail?" are always
answerable.

## Runtime — built in system-worker

The engine lives in **`@terncosoftware/worker`** (`packages/worker`), replacing its
`setInterval` stub. It ships two faces of the same code: a reusable runtime
library that any product worker (`labs-worker`, `tubemail-worker`,
`switchyard-worker`) imports and wires into its `FlowApp`, and a standalone
deployable that is the always-on heartbeat for platform-global jobs. Because
participation is just competing for leases, the *same* binary can be run N-up
and the leases decide who actually ticks.

Three FlowComponents, in the existing component idiom (ports, `onInit`, `step`,
`ctx`-first methods):

- **RoleManager** — owns the willing-role set, runs the acquire/renew tick,
  releases on clean shutdown for fast handover, and exposes `holds(role)` plus
  an `outRoleChanged` port so downstream components start and stop as leases
  move.
- **JobScheduler** — runs its due-job tick only while it holds
  `<ns>.scheduler`, and uses `nextRun()` to advance. If the process was down and
  missed several fires, it folds them into a single catch-up run rather than a
  thundering backlog.
- **JobRunner** — claims pending runs, resolves each job's handler reference,
  invokes it, and records the outcome with retry and dead-lettering. Respects
  `requires_role` so role-bound work stays on the elected holder, and claims
  only runs whose handler is a `module://` URI or an id registered in its own
  process, so a worker never takes (and fails) a job another worker handles.

A worker's `app.ts` adds these three and registers its handlers; `main.ts`
already has the store, the `ctx`, and `runMigrations` — no new connections, no
new dependencies.

## Handler references

A job has to name the code it runs, and that name must survive in a database row
and a config file — not just a closure registered at boot. The platform already
has most of this machinery: `HandlerRegistry` (`@terncosoftware/app`) maps type
IRIs to `{ module, export }` pairs and lazily `import()`s them, and `FlowLoader`
(`@terncosoftware/flow`) carries a `ModuleResolver` for component types. What's
missing is a single, uniform way to *address a specific method in a specific
module, with bound arguments*. We add it once and use it everywhere — job
handlers and application/extension handler config alike.

The address is a `module://` URI:

```
module://@terncosoftware/server/ComputeStates.js#sweepDomains?scope=active&dryRun=false
```

- the path (`@terncosoftware/server/ComputeStates.js`) is the module specifier — an
  npm package + subpath, a relative path, or a `file://` — resolved by the same
  rules `HandlerRegistry` already applies.
- the fragment (`#sweepDomains`) is the member: a named export, or a method on
  the module's default export.
- the query (`?scope=active&…`) is a bag of **bind-time** arguments baked into
  the reference, distinct from the runtime `ctx`. One generic handler backs many
  jobs by varying its query.

A single `resolveModuleRef(uri): Promise<{ fn, args }>` parses the URI, imports
the module, picks the member, and returns the callable plus its parsed args; the
handler signature is `(ctx, args) => Promise<void>`, and `sys_job.handler`
stores the URI as text. The same resolver replaces the split `module`/`export`
fields in `HandlerRegistry`'s `HandlerEntry`, so handlers, extensions, and jobs
all name code one way. (Implementation note: a scoped specifier does not survive
`new URL("module://@scope/pkg…")` — `@scope` is misread as URL userinfo — so the
resolver treats everything between `module://` and the first `#`/`?` as an
opaque specifier rather than parsing it as a URL authority.)

The in-process `registerJob(id, fn)` call remains the ergonomic path for
first-party handlers and tests: it is simply the case where the reference is a
live function rather than a URI.

## Why this holds up

- **Simple.** Three tables, three components, two SQL idioms
  (`UPDATE ... WHERE expires_at < now()` for roles,
  `SELECT ... FOR UPDATE SKIP LOCKED` for jobs), and one pure `nextRun()`. A new
  scheduled job is one `registerJob(...)` call and one seed row.
- **Durable.** Schedule and history live in Postgres, which already survives
  restart. Crash recovery on the role side is lease expiry; on the run side it
  is a stale-`running` reaper (itself a job). Every fire is recorded, so nothing
  silently stops — the class of bug behind TRN-139 and TRN-143.
- **Correct under replicas.** Singleton tick work runs on exactly one holder;
  parallel job execution fans out safely through `SKIP LOCKED`. The system even
  manages itself — the reaper and the history pruner are ordinary jobs on the
  `sys.scheduler` role, which doubles as the end-to-end smoke test of the whole
  mechanism.
