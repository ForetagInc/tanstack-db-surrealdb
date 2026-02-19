import { describe, expect, it } from 'bun:test';
import { RecordId } from 'surrealdb';

import { manageTable } from '../src/table';

type Row = {
	id: string | RecordId;
	name?: string;
	sync_deleted?: boolean;
	updated_at?: Date | number | string;
};

describe('CRDT behavior (useLoro=true)', () => {
	it('applies sync filter, update clock, and tombstone delete', async () => {
		const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
		const updates: Array<{ id: unknown; payload: Record<string, unknown> }> = [];
		const upserts: Array<{ id: unknown; payload: Record<string, unknown> }> = [];
		const deletes: unknown[] = [];

		const db = {
			query: async (sql: string, params: Record<string, unknown>) => {
				queries.push({ sql, params });
				return [[]];
			},
			update: (id: unknown) => ({
				merge: async (payload: Record<string, unknown>) => {
					updates.push({ id, payload });
				},
			}),
			upsert: (id: unknown) => ({
				merge: async (payload: Record<string, unknown>) => {
					upserts.push({ id, payload });
				},
			}),
			delete: async (id: unknown) => {
				deletes.push(id);
			},
			create: () => ({
				content: async () => {},
			}),
			insert: async () => {},
			isFeatureSupported: () => false,
			live: () => ({
				subscribe: () => {},
				kill: async () => {},
			}),
		};

		const table = manageTable<Row>(db as never, true, { name: 'products' });
		const rid = new RecordId('products', '1');

		await table.listAll();
		await table.update(rid, { name: 'desk' });
		await table.softDelete(rid);

		expect(queries[0]?.sql).toContain('WHERE (sync_deleted = false)');

		expect(updates.length).toBe(1);
		expect(updates[0]?.payload.sync_deleted).toBe(false);
		expect(typeof updates[0]?.payload.updated_at).toBe('number');

		expect(upserts.length).toBe(1);
		expect(upserts[0]?.payload.sync_deleted).toBe(true);
		expect(typeof upserts[0]?.payload.updated_at).toBe('number');

		expect(deletes.length).toBe(0);
	});
});
