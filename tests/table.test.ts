import { describe, expect, it } from 'bun:test';
import { DateTime, eq, RecordId } from 'surrealdb';

import { manageTable } from '../src/table';

type Product = {
	id: string | RecordId;
	name?: string;
	start_at?: string | Date | DateTime;
	end_at?: string | Date | DateTime;
	due_at?: string | Date | DateTime;
	sync_deleted?: boolean;
	updated_at?: Date | number | string;
};

const createDbMock = () => {
	const state: {
		queries: Array<{ sql: string; params: Record<string, unknown> }>;
		createdContent: unknown[];
		inserted: unknown[];
		updated: Array<{ id: unknown; payload: unknown }>;
		deleted: unknown[];
		upserted: Array<{ id: unknown; payload: unknown }>;
		liveWhere: unknown[];
		liveKillCount: number;
		supportLiveQueries: boolean;
		liveSubscriber?: (msg: unknown) => void;
	} = {
		queries: [],
		createdContent: [],
		inserted: [],
		updated: [],
		deleted: [],
		upserted: [],
		liveWhere: [],
		liveKillCount: 0,
		supportLiveQueries: true,
	};

	const db = {
		query: async (sql: string, params: Record<string, unknown>) => {
			state.queries.push({ sql, params });
			return [[]];
		},
		create: () => ({
			content: async (payload: unknown) => {
				state.createdContent.push(payload);
			},
		}),
		insert: async (_table: unknown, payload: unknown) => {
			state.inserted.push(payload);
		},
		update: (id: unknown) => ({
			merge: async (payload: unknown) => {
				state.updated.push({ id, payload });
			},
		}),
		delete: async (id: unknown) => {
			state.deleted.push(id);
		},
		upsert: (id: unknown) => ({
			merge: async (payload: unknown) => {
				state.upserted.push({ id, payload });
			},
		}),
		isFeatureSupported: () => state.supportLiveQueries,
		live: () => ({
			where: (whereExpr: unknown) => {
				state.liveWhere.push(whereExpr);
				return {
					subscribe: (cb: (msg: unknown) => void) => {
						state.liveSubscriber = cb;
					},
					kill: async () => {
						state.liveKillCount += 1;
					},
				};
			},
		}),
	};

	return { db, state };
};

describe('manageTable', () => {
	it('builds listAll query and subset query correctly', async () => {
		const { db, state } = createDbMock();
		const table = manageTable<Product>(db as never, false, {
			name: 'products',
			fields: ['id', 'name'],
			where: eq('active', true),
		});

		await table.listAll();
		await table.loadSubset({
			orderBy: ['name DESC', 'id ASC'],
			limit: 10,
			offset: 5,
		});

		expect(state.queries.length).toBe(2);
		expect(state.queries[0]?.sql).toContain('SELECT id, name FROM');
		expect(state.queries[0]?.sql).toContain('WHERE $where');
		expect(state.queries[1]?.sql).toContain('ORDER BY name DESC, id ASC');
		expect(state.queries[1]?.sql).toContain('LIMIT $limit');
		expect(state.queries[1]?.sql).toContain('START $offset');
	});

	it('creates with db.create when id is missing and with db.insert when id exists', async () => {
		const { db, state } = createDbMock();
		const table = manageTable<Product>(db as never, false, {
			name: 'products',
		});

		await table.create({ name: 'desk' });
		await table.create({ id: '1', name: 'chair' });

		expect(state.createdContent).toEqual([{ name: 'desk' }]);
		expect(state.inserted.length).toBe(1);
		const inserted = state.inserted[0] as { id: RecordId; name: string };
		expect(inserted.name).toBe('chair');
		expect(inserted.id instanceof RecordId).toBe(true);
		expect(inserted.id.toString()).toBe('products:⟨1⟩');
	});

	it('treats undefined id as missing and uses db.create', async () => {
		const { db, state } = createDbMock();
		const table = manageTable<Product>(db as never, false, {
			name: 'products',
		});

		await table.create({ id: undefined, name: 'server-id' });

		expect(state.createdContent).toEqual([{ id: undefined, name: 'server-id' }]);
		expect(state.inserted.length).toBe(0);
	});

	it('updates and soft-deletes according to useLoro mode', async () => {
		const { db, state } = createDbMock();
		const rid = new RecordId('products', '1');

		const nonLoro = manageTable<Product>(db as never, false, {
			name: 'products',
		});
		await nonLoro.update(rid, { name: 'plain' });
		await nonLoro.softDelete(rid);

		const loro = manageTable<Product>(db as never, true, {
			name: 'products',
		});
		await loro.update(rid, { name: 'loro' });
		await loro.softDelete(rid);

		expect(state.updated.length).toBe(2);
		expect(state.deleted.length).toBe(1);
		expect(state.upserted.length).toBe(1);

		const plainUpdate = state.updated[0]?.payload as { name: string };
		expect(plainUpdate.name).toBe('plain');
		expect('sync_deleted' in plainUpdate).toBe(false);

		const loroUpdate = state.updated[1]?.payload as {
			name: string;
			sync_deleted: boolean;
			updated_at: unknown;
		};
		expect(loroUpdate.name).toBe('loro');
		expect(loroUpdate.sync_deleted).toBe(false);
		expect(typeof loroUpdate.updated_at).toBe('number');

		const tombstone = state.upserted[0]?.payload as {
			sync_deleted: boolean;
			updated_at: unknown;
		};
		expect(tombstone.sync_deleted).toBe(true);
		expect(typeof tombstone.updated_at).toBe('number');
	});

	it('preserves string/Date/DateTime values when updating datetime fields', async () => {
		const { db, state } = createDbMock();
		const rid = new RecordId('products', 'dt-1');
		const asString = '2026-01-10T12:00:00.000Z';
		const asDate = new Date('2026-01-11T12:00:00.000Z');
		const asSurrealDate = new DateTime(new Date('2026-01-12T12:00:00.000Z'));

		const nonLoro = manageTable<Product>(db as never, false, {
			name: 'products',
		});
		await nonLoro.update(rid, {
			start_at: asString,
			end_at: asDate,
			due_at: asSurrealDate,
		});

		const loro = manageTable<Product>(db as never, true, {
			name: 'products',
		});
		await loro.update(rid, {
			start_at: asString,
			end_at: asDate,
			due_at: asSurrealDate,
		});

		const nonLoroPayload = state.updated[0]?.payload as Record<string, unknown>;
		expect(nonLoroPayload.start_at).toBe(asString);
		expect(nonLoroPayload.end_at).toBe(asDate);
		expect(nonLoroPayload.due_at).toBe(asSurrealDate);
		expect(nonLoroPayload.due_at instanceof DateTime).toBe(true);

		const loroPayload = state.updated[1]?.payload as Record<string, unknown>;
		expect(loroPayload.start_at).toBe(asString);
		expect(loroPayload.end_at).toBe(asDate);
		expect(loroPayload.due_at).toBe(asSurrealDate);
		expect(loroPayload.due_at instanceof DateTime).toBe(true);
		expect(loroPayload.sync_deleted).toBe(false);
		expect(typeof loroPayload.updated_at).toBe('number');
	});

	it('subscribes to live updates and cleans up', async () => {
		const { db, state } = createDbMock();
		const events: Array<{ type: 'insert' | 'update' | 'delete'; row: Product }> =
			[];
		const table = manageTable<Product>(db as never, false, {
			name: 'products',
			where: eq('active', true),
		});

		const cleanup = table.subscribe((evt) => {
			events.push(evt);
		});

		await Promise.resolve();
		expect(state.liveWhere.length).toBe(1);
		expect(typeof state.liveSubscriber).toBe('function');

		state.liveSubscriber?.({
			action: 'CREATE',
			value: { id: 'products:1', name: 'desk' },
		});
		state.liveSubscriber?.({
			action: 'UPDATE',
			value: { id: 'products:1', name: 'desk v2' },
		});
		state.liveSubscriber?.({
			action: 'DELETE',
			value: { id: 'products:1' },
		});
		state.liveSubscriber?.({
			action: 'KILLED',
			value: { id: 'products:1' },
		});

		expect(events.length).toBe(3);
		expect(events[0]?.type).toBe('insert');
		expect(events[1]?.type).toBe('update');
		expect(events[2]?.type).toBe('delete');

		cleanup();
		expect(state.liveKillCount).toBe(1);
	});

	it('does not open live subscription when feature is unsupported', async () => {
		const { db, state } = createDbMock();
		state.supportLiveQueries = false;

		const table = manageTable<Product>(db as never, false, {
			name: 'products',
		});
		const cleanup = table.subscribe(() => {});
		await Promise.resolve();
		cleanup();

		expect(state.liveWhere.length).toBe(0);
		expect(state.liveKillCount).toBe(0);
	});
});
