# @foretag/tanstack-db-surrealdb

TanStack DB collection adapter for SurrealDB JS with:

- Realtime replication (`LIVE`)
- Local-first writes
- Optional E2EE envelopes (`version/algorithm/key_id/nonce/ciphertext`)
- Optional Loro CRDT replication (`json`, `richtext`)
- Query-driven sync modes (`eager`, `on-demand`, `progressive`)

## Install

```sh
npm install @foretag/tanstack-db-surrealdb
# or
bun add @foretag/tanstack-db-surrealdb
```

## Quick Start

```ts
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { Surreal } from 'surrealdb';
import { surrealCollectionOptions } from '@foretag/tanstack-db-surrealdb';

const db = new Surreal();
const queryClient = new QueryClient();

type Product = { id: string; name: string; price: number };

export const products = createCollection(
  surrealCollectionOptions<Product>({
    db,
    table: { name: 'product' },
    queryClient,
    queryKey: ['product'],
    syncMode: 'eager',
  }),
);
```

## Adapter API

```ts
type SurrealCollectionOptions<T> = {
  db: Surreal;
  table: Table | { name: string; relation?: boolean } | string;
  queryClient: QueryClient;
  queryKey: readonly unknown[];
  syncMode?: 'eager' | 'on-demand' | 'progressive';
  e2ee?: {
    enabled: boolean;
    crypto: CryptoProvider;
    aad?: (ctx: { table: string; id: string; kind: 'base'|'update'|'snapshot'; baseTable?: string }) => Uint8Array;
  };
  crdt?: {
    enabled: boolean;
    profile: 'json' | 'richtext';
    updatesTable: Table | { name: string } | string;
    snapshotsTable?: Table | { name: string } | string;
    // Optional overrides. If omitted, adapter uses built-in handlers for `profile`.
    materialize?: (doc: LoroDoc, id: string) => T;
    applyLocalChange?: (doc: LoroDoc, change: { type: 'insert'|'update'|'delete'; value: T }) => void;
    persistMaterializedView?: boolean;
    actor?: string | ((ctx: { id: string; change?: { type: 'insert'|'update'|'delete'; value: T } }) => string | undefined);
    localActorId?: string; // deprecated
  };
};
```

## E2EE

Envelope fields stored in Surreal records:

```ts
type EncryptedEnvelope = {
  version: number;
  algorithm: string;
  key_id: string;
  nonce: string;
  ciphertext: string;
};
```

Default AAD:

- Base records: `<table>:<record_id>`
- CRDT updates/snapshots: `<updates_or_snapshots_table>:<base_table>:<doc_id>`

Included provider:

- `WebCryptoAESGCM` (`AES-256-GCM`, versioned envelope)

## CRDT Profiles

CRDT is managed by profile by default:

- `profile: 'json'` uses built-in JSON handlers
- `profile: 'richtext'` uses built-in richtext handlers

Advanced overrides are still available:

- `createLoroProfile('json' | 'richtext')`
- `materialize` and `applyLocalChange` in `crdt` options

For CRDT loop-prevention metadata, prefer `crdt.actor` so actor identity can be resolved per doc/write. `localActorId` remains only for backwards compatibility.

## CRDT Table Requirements

For `crdt.enabled: true`, users must provide:

- Base table (`table`) for record identity and optional materialized metadata.
- Updates table (`crdt.updatesTable`) as append-only CRDT log.

Optional:

- Snapshots table (`crdt.snapshotsTable`) for compaction and faster hydration.

If `crdt.updatesTable` is missing, CRDT mode cannot function.

## SQL Templates

### Plain

```sql
DEFINE TABLE note SCHEMAFULL;
DEFINE FIELD title ON note TYPE string;
DEFINE FIELD body ON note TYPE string;
DEFINE FIELD updated_at ON note TYPE datetime VALUE time::now();
DEFINE INDEX note_updated ON note FIELDS updated_at;
```

### E2EE-only

```sql
DEFINE TABLE secret_note SCHEMAFULL;
DEFINE FIELD owner ON secret_note TYPE record<account>;
DEFINE FIELD updated_at ON secret_note TYPE datetime;
DEFINE FIELD version ON secret_note TYPE int;
DEFINE FIELD algorithm ON secret_note TYPE string;
DEFINE FIELD key_id ON secret_note TYPE string;
DEFINE FIELD nonce ON secret_note TYPE string;
DEFINE FIELD ciphertext ON secret_note TYPE string;
DEFINE INDEX secret_note_owner_updated ON secret_note FIELDS owner, updated_at;
```

### CRDT-only

```sql
DEFINE TABLE doc SCHEMAFULL;
DEFINE FIELD owner ON doc TYPE record<account>;
DEFINE FIELD updated_at ON doc TYPE datetime;
DEFINE INDEX doc_owner_updated ON doc FIELDS owner, updated_at;

-- Necessary for CRDT updates
DEFINE TABLE crdt_update SCHEMAFULL;
DEFINE FIELD doc ON crdt_update TYPE record<doc>;
DEFINE FIELD ts ON crdt_update TYPE datetime;
DEFINE FIELD update_bytes ON crdt_update TYPE string;
DEFINE FIELD actor ON crdt_update TYPE string;
DEFINE INDEX crdt_doc_ts ON crdt_update FIELDS doc, ts;

DEFINE TABLE crdt_snapshot SCHEMAFULL;
DEFINE FIELD doc ON crdt_snapshot TYPE record<doc>;
DEFINE FIELD ts ON crdt_snapshot TYPE datetime;
DEFINE FIELD snapshot_bytes ON crdt_snapshot TYPE string;
DEFINE INDEX snap_doc_ts ON crdt_snapshot FIELDS doc, ts;
```

### CRDT + E2EE

```sql
DEFINE TABLE secure_doc SCHEMAFULL;
DEFINE FIELD owner ON secure_doc TYPE record<account>;
DEFINE FIELD updated_at ON secure_doc TYPE datetime;
DEFINE INDEX secure_doc_owner_updated ON secure_doc FIELDS owner, updated_at;

DEFINE TABLE crdt_update SCHEMAFULL;
DEFINE FIELD doc ON crdt_update TYPE record<secure_doc>;
DEFINE FIELD ts ON crdt_update TYPE datetime;
DEFINE FIELD actor ON crdt_update TYPE string;
DEFINE FIELD version ON crdt_update TYPE int;
DEFINE FIELD algorithm ON crdt_update TYPE string;
DEFINE FIELD key_id ON crdt_update TYPE string;
DEFINE FIELD nonce ON crdt_update TYPE string;
DEFINE FIELD ciphertext ON crdt_update TYPE string;
DEFINE INDEX crdt_doc_ts ON crdt_update FIELDS doc, ts;
```

If a single `crdt_update` table is shared across multiple base tables, use a union type such as `record<doc> | record<sheet>`.

## Permissions Templates

The adapter does not manage Surreal table permissions. Define them in schema.

### E2EE-only table permissions

```sql
DEFINE TABLE secret_note SCHEMAFULL
	PERMISSIONS
		FOR select, create, update, delete WHERE owner = $auth.id;
```

### CRDT updates table permissions (append-only)

```sql
DEFINE TABLE crdt_update SCHEMAFULL
	PERMISSIONS
		FOR select, create WHERE owner = $auth.id
		FOR update, delete NONE;

-- Add owner metadata on update rows for simple ACL checks
DEFINE FIELD owner ON crdt_update TYPE record<account>;
DEFINE INDEX crdt_owner_doc_ts ON crdt_update FIELDS owner, doc, ts;
```

### CRDT snapshots table permissions

```sql
DEFINE TABLE crdt_snapshot SCHEMAFULL
	PERMISSIONS
		FOR select WHERE owner = $auth.id
		FOR create, update, delete NONE;

-- Common pattern: clients read snapshots; only trusted backend writes/prunes them
DEFINE FIELD owner ON crdt_snapshot TYPE record<account>;
DEFINE INDEX snap_owner_doc_ts ON crdt_snapshot FIELDS owner, doc, ts;
```

If you run snapshot compaction from a trusted backend/service account, grant create/delete to that account only.

## Usage Snippets

### E2EE-only secret table

```ts
const provider = await WebCryptoAESGCM.fromRawKey(rawKey, { kid: 'org-key-2026-01' });

const secrets = createCollection(
  surrealCollectionOptions<{ id: string; title: string; body: string }>({
    db,
    table: { name: 'secret_note' },
    queryClient,
    queryKey: ['secret-note'],
    syncMode: 'eager',
    e2ee: { enabled: true, crypto: provider },
  }),
);
```

### CRDT richtext docs

```ts
const docs = createCollection(
  surrealCollectionOptions<{ id: string; content: string; title?: string }>({
    db,
    table: { name: 'doc' },
    queryClient,
    queryKey: ['doc'],
    syncMode: 'on-demand',
    crdt: {
      enabled: true,
      profile: 'richtext',
      updatesTable: { name: 'crdt_update' },
      snapshotsTable: { name: 'crdt_snapshot' },
      actor: ({ id }) => id.startsWith('team-a') ? 'device:team-a:abc' : 'device:team-b:abc',
    },
  }),
);
```

### RecordId model example

```ts
import { RecordId } from 'surrealdb';

type CalendarEvent = {
  id: RecordId<'calendar_event'>;
  owner: RecordId<'account'>;
  title: string;
  start_at: string;
};

await calendarEvents.insert({
  id: new RecordId('calendar_event', 'evt-001'),
  owner: new RecordId('account', 'user-123'),
  title: 'Planning',
  start_at: '2026-02-23T10:00:00.000Z',
});
```

Full runnable example: `examples/record-id.ts`.

### On-demand drive listing (query-driven)

```ts
import { createLiveQueryCollection, eq } from '@tanstack/db';

const files = createCollection(
  surrealCollectionOptions<{ id: string; owner: string; updated_at: string; name: string }>({
    db,
    table: { name: 'file' },
    queryClient,
    queryKey: ['file'],
    syncMode: 'on-demand',
  }),
);

const ownerFiles = createLiveQueryCollection((q) =>
  q
    .from({ files })
    .where(({ files }) => eq(files.owner, 'account:abc'))
    .select(({ files }) => files),
);

await ownerFiles.preload();
```

## Key Wrapping / Multi-Principal Access

This adapter expects key management to be provided by your app or KMS. For production shared access (users, teams, orgs), keep using wrapped keys:

- Encrypt entity data with a data key.
- Wrap that data key for each authorized principal (user/team/service/device).
- Resolve the active key by `kid` at decrypt time.
- Rotate by issuing a new `kid` and re-wrapping/re-encrypting progressively.

The adapter consumes derived keys through `CryptoProvider`; it does not manage wrapping policy for you.

## Testing

Unit tests (`bun test`) cover:

- id/query translation behavior
- modern eager + on-demand sync controls
- E2EE envelope/AAD behavior
- CRDT update append, snapshot hydration, and actor loop prevention

Real SurrealDB integration tests are available and run against a live instance:

1. Copy `.env.example` to `.env` and fill connection/auth values.
2. Run `bun run test:integration`.

Required env:

- `SURREAL_URL`
- `SURREAL_NAMESPACE`
- `SURREAL_DATABASE`
- `SURREAL_USERNAME`
- `SURREAL_PASSWORD`

`SURREAL_REQUIRE_LIVE=true` (default) enforces LIVE query assertions; set it to `false` if you intentionally use a connection without LIVE support.
