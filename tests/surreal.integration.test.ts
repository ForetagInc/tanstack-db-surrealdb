import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/query-core';
import { Features, RecordId, Surreal, Table } from 'surrealdb';

import { toRecordKeyString } from '../src/id';
import { surrealCollectionOptions } from '../src/index';
import { manageTable } from '../src/table';

type IntegrationEnv = {
	url: string;
	namespace: string;
	database: string;
	username?: string;
	password?: string;
	token?: string;
	requireLive: boolean;
};

type SyncWrite = {
	type: 'insert' | 'update' | 'delete';
	value?: Record<string, unknown>;
	key?: string;
};

const cjsSurreal = require('surrealdb') as {
	RecordId: new (table: string, id: string) => unknown;
};
const CjsRecordId = cjsSurreal.RecordId;

const loadIntegrationEnv = (): IntegrationEnv | null => {
	const url = process.env.SURREAL_URL;
	if (!url) return null;

	const namespace = process.env.SURREAL_NAMESPACE ?? 'test';
	const database = process.env.SURREAL_DATABASE ?? 'test';
	const token = process.env.SURREAL_TOKEN;
	const username = process.env.SURREAL_USERNAME;
	const password = process.env.SURREAL_PASSWORD;
	const requireLive = process.env.SURREAL_REQUIRE_LIVE !== 'false';

	if (!token && !(username && password)) {
		throw new Error(
			'Real Surreal integration tests require either SURREAL_TOKEN or SURREAL_USERNAME + SURREAL_PASSWORD.',
		);
	}

	return {
		url,
		namespace,
		database,
		username,
		password,
		token,
		requireLive,
	};
};

const integrationEnv = loadIntegrationEnv();

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const waitFor = async (
	check: () => boolean,
	message: string,
	timeoutMs = 8_000,
) => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (check()) return;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for: ${message}`);
};

const cleanupSyncResult = (result: unknown) => {
	if (typeof result === 'function') {
		result();
		return;
	}

	if (
		result &&
		typeof result === 'object' &&
		'cleanup' in result &&
		typeof (result as { cleanup?: unknown }).cleanup === 'function'
	) {
		(result as { cleanup: () => void }).cleanup();
	}
};

const createTableName = (prefix: string) =>
	`${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const assertSafeIdentifier = (value: string): string => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`Unsafe table identifier: ${value}`);
	}
	return value;
};

const ensureTableSchema = async (db: Surreal, tableName: string) => {
	const safe = assertSafeIdentifier(tableName);
	await db.query(`DEFINE TABLE ${safe} SCHEMAFULL;`);
	await db.query(`DEFINE FIELD name ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD category ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD title ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD owner ON ${safe} TYPE option<record<account>>;`);
};

const dropTable = async (db: Surreal, tableName: string) => {
	const safe = assertSafeIdentifier(tableName);
	await db.query(`REMOVE TABLE ${safe};`);
};

if (!integrationEnv) {
	describe('real surreal integration', () => {
		it.skip('requires SURREAL_URL and auth env vars', () => {});
	});
} else {
	describe('real surreal integration', () => {
	let db: Surreal;
	const createdTables = new Set<string>();

	beforeAll(async () => {
		const env = integrationEnv;
		db = new Surreal();
		await db.connect(env.url);

		if (env.token) {
			await db.authenticate(env.token);
		} else {
			await db.signin({
				username: env.username as string,
				password: env.password as string,
			});
		}

		await db.use({
			namespace: env.namespace,
			database: env.database,
		});
	});

	afterAll(async () => {
		for (const tableName of createdTables) {
			await dropTable(db, tableName).catch(() => undefined);
		}
		await db.close().catch(() => undefined);
	});

	it('runs CRUD against a real table via manageTable', async () => {
		const tableName = createTableName('it_crud');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });

		type Item = { id: string | RecordId; name: string; category?: string };
		const table = manageTable<Item>(db as never, { name: tableName });

		const createdAuto = await table.create({
			name: 'desk',
			category: 'office',
		});
		const createdFixed = await table.create({
			id: 'fixed-1',
			name: 'chair',
			category: 'office',
		});

		expect(createdAuto).toBeDefined();
		expect(createdFixed).toBeDefined();
		expect(toRecordKeyString((createdFixed as Item).id)).toBe('fixed-1');

		const list = await table.listAll();
		expect(list.length).toBe(2);

		const autoRid = new RecordId(
			tableName,
			toRecordKeyString((createdAuto as Item).id),
		);
		await table.update(autoRid, { name: 'desk-v2' });

		const updated = await db.select(autoRid);
		const updatedRow = Array.isArray(updated) ? updated[0] : updated;
		expect((updatedRow as { name?: string } | undefined)?.name).toBe('desk-v2');

		await table.remove(new RecordId(tableName, 'fixed-1'));
		const remaining = await table.listAll();
		expect(remaining.length).toBe(1);
	});

	it('hydrates and replicates live updates in eager mode', async () => {
		const env = integrationEnv;
		if (env.requireLive && !db.isFeatureSupported(Features.LiveQueries)) {
			throw new Error(
				'LiveQueries are not supported by this Surreal connection. Use a ws:// or wss:// SURREAL_URL, or set SURREAL_REQUIRE_LIVE=false.',
			);
		}

		const tableName = createTableName('it_eager');
		createdTables.add(tableName);
		const seedId = new RecordId(tableName, 'seed-1');

		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });
		await db.insert(new Table(tableName), {
			id: seedId,
			title: 'Seed',
		});

		type Note = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Note>({
			db,
			table: { name: tableName },
			queryClient: new QueryClient(),
			queryKey: [tableName, 'eager'],
			syncMode: 'eager',
		});

		let ready = 0;
		const writes: SyncWrite[] = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => writes.push(change as SyncWrite),
			commit: () => {},
			markReady: () => {
				ready += 1;
			},
			truncate: () => {},
		} as never);

		await waitFor(
			() =>
				ready === 1 &&
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title === 'Seed',
				),
			'eager initial hydration to complete',
		);

		await db.insert(new Table(tableName), {
			id: new RecordId(tableName, 'seed-2'),
			title: 'From Live',
		});
		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title ===
						'From Live',
				),
			'live CREATE event to be replicated',
		);

		await db.update(seedId).merge({ title: 'Seed Updated' });
		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title ===
						'Seed Updated',
				),
			'live UPDATE event to be replicated',
		);

		cleanupSyncResult(syncResult);
	});

	it('applies on-demand replication only for active ids', async () => {
		const env = integrationEnv;
		if (env.requireLive && !db.isFeatureSupported(Features.LiveQueries)) {
			throw new Error(
				'LiveQueries are not supported by this Surreal connection. Use a ws:// or wss:// SURREAL_URL, or set SURREAL_REQUIRE_LIVE=false.',
			);
		}

		const tableName = createTableName('it_on_demand');
		createdTables.add(tableName);
		const activeId = new RecordId(tableName, 'one');
		const inactiveId = new RecordId(tableName, 'two');

		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });
		await db.insert(new Table(tableName), { id: activeId, title: 'One' });

		type Task = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Task>({
			db,
			table: { name: tableName },
			queryClient: new QueryClient(),
			queryKey: [tableName, 'on-demand'],
			syncMode: 'on-demand',
		});

		const writes: SyncWrite[] = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => writes.push(change as SyncWrite),
			commit: () => {},
			markReady: () => {},
			truncate: () => {},
		} as never);

		if (
			!syncResult ||
			typeof syncResult !== 'object' ||
			!('loadSubset' in syncResult) ||
			typeof (syncResult as { loadSubset?: unknown }).loadSubset !== 'function'
		) {
			throw new Error('Expected on-demand sync result to expose loadSubset().');
		}

		await (syncResult as { loadSubset: (subset: object) => Promise<void> }).loadSubset(
			{},
		);

		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title === 'One',
				),
			'initial on-demand subset hydration',
		);

		await db.insert(new Table(tableName), { id: inactiveId, title: 'Two' });
		await sleep(400);
		expect(
			writes.some(
				(change) =>
					(change.value as { title?: string } | undefined)?.title === 'Two',
			),
		).toBe(false);

		await db.update(activeId).merge({ title: 'One Updated' });
		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title ===
						'One Updated',
				),
			'live UPDATE for active id in on-demand mode',
		);

		cleanupSyncResult(syncResult);
	});

	it('filters rows by RecordId in WHERE (native + cross-runtime)', async () => {
		const tableName = createTableName('it_where_recordid');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });

		const ownerA = new RecordId('account', 'user-a');
		const ownerB = new RecordId('account', 'user-b');
		await db.insert(new Table(tableName), [
			{
				id: new RecordId(tableName, 'r1'),
				title: 'One',
				owner: ownerA,
			},
			{
				id: new RecordId(tableName, 'r2'),
				title: 'Two',
				owner: ownerB,
			},
		]);

		type Item = { id: string | RecordId; title: string; owner: RecordId };
		const table = manageTable<Item>(db as never, { name: tableName });
		const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
		const val = (value: unknown) => ({ type: 'val', value }) as const;
		const eqExpr = (field: string, value: unknown) =>
			({ type: 'func', name: 'eq', args: [ref(field), val(value)] }) as const;

		const nativeRows = await table.loadSubset({
			where: eqExpr('owner', ownerA) as never,
		});
		expect(nativeRows.length).toBe(1);
		expect(toRecordKeyString(nativeRows[0]?.id as string | RecordId)).toBe('r1');

		const foreignOwnerA = new CjsRecordId('account', 'user-a');
		const crossRuntimeRows = await table.loadSubset({
			where: eqExpr('owner', foreignOwnerA) as never,
		});
		expect(crossRuntimeRows.length).toBe(1);
		expect(toRecordKeyString(crossRuntimeRows[0]?.id as string | RecordId)).toBe(
			'r1',
		);
	});
	});
}
