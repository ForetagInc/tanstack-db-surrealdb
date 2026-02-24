import { describe, expect, it } from 'bun:test';
import { DateTime, RecordId } from 'surrealdb';

import { manageTable } from '../src/table';

type Product = {
	id: string | RecordId;
	name?: string;
	start_at?: string | Date | DateTime;
	end_at?: string | Date | DateTime;
	due_at?: string | Date | DateTime;
	updated_at?: Date | number | string;
};

describe('manageTable', () => {
	it('builds listAll query and translates loadSubset options to SQL', async () => {
		const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
		const val = (value: unknown) => ({ type: 'val', value }) as const;
		const eqExpr = (field: string, value: unknown) =>
			({ type: 'func', name: 'eq', args: [ref(field), val(value)] }) as const;
		const state: {
			queries: Array<{ sql: string; params: Record<string, unknown> }>;
		} = {
			queries: [],
		};
		const db = {
			query: async (sql: string, params: Record<string, unknown>) => {
				state.queries.push({ sql, params });
				return [[]];
			},
		};
		const table = manageTable<Product>(db as never, { name: 'products' });

		await table.listAll();
		await table.loadSubset({
			where: eqExpr('active', true) as never,
			orderBy: [
				{
					expression: ref('name') as never,
					compareOptions: { direction: 'desc', nulls: 'last' },
				},
				{
					expression: ref('id') as never,
					compareOptions: { direction: 'asc', nulls: 'last' },
				},
			] as never,
			limit: 10,
			offset: 5,
		});

		expect(state.queries.length).toBe(2);
		expect(state.queries[0]?.sql).toContain('SELECT * FROM');
		expect(state.queries[0]?.sql).not.toContain('WHERE');
		expect(state.queries[1]?.sql).toContain('WHERE (active = $p0)');
		expect(state.queries[1]?.sql).toContain('ORDER BY name DESC, id ASC');
		expect(state.queries[1]?.sql).toContain('LIMIT $p1');
		expect(state.queries[1]?.sql).toContain('START $p2');
		expect(state.queries[1]?.params.p0).toBe(true);
		expect(state.queries[1]?.params.p1).toBe(10);
		expect(state.queries[1]?.params.p2).toBe(5);
	});

	it('normalizes explicit ids to RecordId payloads on create', async () => {
		const state: { inserted: unknown[] } = {
			inserted: [],
		};
		const db = {
			insert: async (_table: unknown, payload: unknown) => {
				state.inserted.push(payload);
			},
		};
		const table = manageTable<Product>(db as never, { name: 'products' });

		await table.create({ id: '1', name: 'chair' });

		expect(state.inserted.length).toBe(1);
		const inserted = state.inserted[0] as { id: RecordId; name: string };
		expect(inserted.name).toBe('chair');
		expect(inserted.id instanceof RecordId).toBe(true);
		expect(inserted.id.toString()).toBe('products:⟨1⟩');
	});

	it('preserves string/Date/DateTime values when updating datetime fields', async () => {
		const state: { updated: Array<{ id: unknown; payload: unknown }> } = {
			updated: [],
		};
		const db = {
			update: (id: unknown) => ({
				merge: async (payload: unknown) => {
					state.updated.push({ id, payload });
				},
			}),
		};
		const rid = new RecordId('products', 'dt-1');
		const asString = '2026-01-10T12:00:00.000Z';
		const asDate = new Date('2026-01-11T12:00:00.000Z');
		const asSurrealDate = new DateTime(new Date('2026-01-12T12:00:00.000Z'));

		const table = manageTable<Product>(db as never, { name: 'products' });
		await table.update(rid, {
			start_at: asString,
			end_at: asDate,
			due_at: asSurrealDate,
		});

		const payload = state.updated[0]?.payload as Record<string, unknown>;
		expect(payload.start_at).toBe(asString);
		expect(payload.end_at).toBe(asDate);
		expect(payload.due_at).toBe(asSurrealDate);
		expect(payload.due_at instanceof DateTime).toBe(true);
	});
});
