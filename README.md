

# Tern
Full-stack web and native development platform.

> Note: This is very, very much a work in progress and nowhere near production grade.


## Overview
This repository serves as a basis for modern full stack web applications with a focus on aggressive simplicity, clean architecture, modularity, and extensibilty.

This repository is very much based around reducing _accidental complexity_ in order to focus on _incidental complexity_.

The architecture expressed here is directly influenced by J. Paul Morrison's work on push-oriented dataflow programming and also leans heavily on domain-driven design, CQRS, composite user interface principles, and multi-modal graph + time-series Postgres.

For more info and useful context, read [Out of the Tar Pit](https://github.com/papers-we-love/papers-we-love/blob/main/design/out-of-the-tar-pit.pdf) (PDF) and [Flow-based Programming](https://jpaulm.github.io/fbp/).


## Core Principles

**Graph-native.** All data — entities, configuration, extension metadata — is stored as RDF quads `(subject, predicate, object, graph)` in a relational database. There is no fixed schema to ALTER; adding a property means defining an IRI. Any package can extend any entity without a migration.

**Time-series and soft-delete.** Writes are never destructive. Every quad write is timestamped; deletes mark records as soft-deleted rather than removing them. The entire store can be queried at any point in time, which means undo/redo is a first-class platform capability and audit trails are free.

**Semantic Web native.** Ontologies are expressed in standard OWL/SHACL Turtle files. This makes the schema machine-readable, interoperable, and natively understood by AI agents and language models without any custom translation layer.

**Loose coupling.** Components communicate only through typed FBP ports and domain events. Unknown implementations produce empty results, not errors. Extensions hang their own data off entities as independent named subgraphs and never modify another package's data.


## Prerequisites
- [Node.js](https://nodejs.org/) 22+
- [Yarn](https://yarnpkg.com/) 4 (`corepack enable`)
- [Docker](https://www.docker.com/) + Docker Compose (for the runtime services)


## Setup

```bash
yarn install
yarn build
```

`yarn build` stamps each package with the current git SHA/branch and compiles all TypeScript.


## Development

Start the Docker services (worker, database, etc.) and tail their logs:

```bash
yarn dev
```

To also force a fresh image build before starting:

```bash
yarn bup
```

Watch for TypeScript changes and recompile automatically:

```bash
yarn watch
```

Tail Docker logs at any time:

```bash
yarn tail
```


## Testing

Run the full test suite (SQLite only, no Postgres required; the run ends with a notice that the Postgres legs were skipped):

```bash
yarn test
```

Run in watch mode with coverage:

```bash
yarn test:watch
```

### Postgres tests

All database tests run against SQLite by default. To also run each suite against Postgres, set `SYS_PG_URL`:

```bash
SYS_PG_URL=postgres://user:pass@localhost:5432/mydb yarn test
```

Each vitest worker runs its Postgres legs in its own database, `mydb_w1`, `mydb_w2` and so on, created on the same server and dropped when the run ends. The role in `SYS_PG_URL` needs `CREATEDB`. Two runs at once need different `mydb` names. The run ends with a count of the Postgres-leg tests that passed, failed and skipped. CI runs every Postgres leg and fails if none passed.

> **Important:** After editing any package's TypeScript source, rebuild its `dist/` before running tests — Vitest loads compiled output, not the raw TypeScript.
>
> ```bash
> cd packages/<name> && npx tsc -b
> # or rebuild everything:
> yarn build
> ```


## Codegen

Tern generates TypeScript types from RDF/SHACL ontologies. Each ontology-owning package declares its targets in the `tern` manifest in its own `package.json`. To run codegen across every such package:

```bash
yarn workspaces foreach --all run gen
```

Individual package:

```bash
yarn workspace @terncosoftware/core run gen
```

Generated files are checked in, and CI regenerates them and fails on any diff, so a hand-edited `*.generated.ts` or an unregenerated `.ttl` change is caught in the build.


## Type-checking

Check all packages without emitting:

```bash
yarn typecheck
```


## Building

Compile all packages (runs `tsc -b` in each workspace):

```bash
yarn build
```

Clean all `dist/` directories:

```bash
yarn clean
```


## Package structure

| Package | Purpose |
|---|---|
| `core` | Base types: RDF terms, messages, IRI, flow ports |
| `data` | Triple/quad store (SQLite + Postgres), migrations |
| `entities` | Domain entity system over the quad store |
| `auth` | User, device, session management |
| `flow` | Flow-based programming runtime, HTTP/WS adapters |
| `api` | HTTP API surface |
| `worker` | Backend worker process |
| `gen` | RDF/SHACL → TypeScript codegen |
| `secrets` | Secret management abstraction |
| `app` | Shared app shell |
| `test` | Integration test suite (covers all packages) |
| `sandbox-*` | Sandbox/demo apps |


## Workspace aliases

Common `yarn workspace @system/<name>` shortcuts are aliased at the root:

```bash
yarn api <script>
yarn core <script>
yarn tests <script>
yarn worker <script>
```
