import { describe, expect, it } from 'bun:test';
import { DateTime, RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Product = {
	id: string | RecordId;
	name: string;
};

const createOptions = () =>
	surrealCollectionOptions<Product>({
		db: {} as never,
		queryClient: {} as never,
		queryKey: ['products'],
		table: { name: 'products' },
	});

describe('surrealCollectionOptions schema', () => {
	it('generates temp ids when id is missing', () => {
		const opts = createOptions();
		const result = opts.schema['~standard'].validate({
			name: 'desk',
		}) as { value: Record<string, unknown> };

		expect(result.value.name).toBe('desk');
		expect(result.value.id instanceof RecordId).toBe(true);
		const key = (result.value.id as Record<string, unknown>).id;
		expect(typeof key).toBe('string');
		expect((key as string).startsWith('__temp__')).toBe(true);
	});

	it('normalizes record-id-like id values if provided', () => {
		const opts = createOptions();
		const result = opts.schema['~standard'].validate({
			id: 'products:1',
			name: 'desk',
		}) as { value: Record<string, unknown> };

		expect(result.value.id instanceof RecordId).toBe(true);
		expect((result.value.id as RecordId).toString()).toBe('products:⟨1⟩');
	});

	it('preserves DateTime-like fields through schema validation', () => {
		const opts = createOptions();
		const jsDate = new Date('2026-01-01T00:00:00.000Z');
		const surrealDate = new DateTime(new Date('2026-01-01T01:00:00.000Z'));
		const result = opts.schema['~standard'].validate({
			id: 'products:1',
			name: 'desk',
			start_at: jsDate,
			end_at: surrealDate,
		}) as {
			value: Record<string, unknown>;
		};

		expect(result.value.start_at).toBe(jsDate);
		expect(result.value.end_at).toBe(surrealDate);
		expect(result.value.end_at instanceof DateTime).toBe(true);
	});

	it('returns validation issues for non-object inserts', () => {
		const opts = createOptions();
		const result = opts.schema['~standard'].validate(
			'not-an-object',
		) as { issues?: Array<{ message: string }> };

		expect(result.issues?.[0]?.message).toBe(
			'Insert data must be an object.',
		);
	});

	it('normalizes getKey output across id variants', () => {
		const opts = createOptions();
		const key = 'e2d546ed-ff34-4b34-a313-97badfa6a86b';
		const variants = [
			`products:${key}`,
			`products:⟨${key}⟩`,
			`products:<${key}>`,
			`products:\`${key}\``,
			`"products:${key}"`,
			new RecordId('products', key),
		];

		for (const variant of variants) {
			expect(
				opts.getKey({
					id: variant as string | RecordId,
					name: 'desk',
				}),
			).toBe(`products:${key}`);
		}
	});

	it('onUpdate normalizes id variants and preserves datetime value types', async () => {
		type CalendarEvent = {
			id: string | RecordId;
			name: string;
			start_at?: string | Date | DateTime;
			end_at?: string | Date | DateTime;
			updated_at?: Date | number | string;
		};

		const updates: Array<{ id: RecordId; payload: Record<string, unknown> }> = [];
		const writeUpserts: Array<Record<string, unknown>> = [];

		const db = {
			update: (id: RecordId) => ({
				merge: async (payload: Record<string, unknown>) => {
					updates.push({ id, payload });
				},
			}),
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			query: async () => [[]],
			delete: async () => {},
			upsert: () => ({ merge: async () => {} }),
			isFeatureSupported: () => false,
			live: () => ({
				where: () => ({
					subscribe: () => {},
					kill: async () => {},
				}),
			}),
		};

		const opts = surrealCollectionOptions<CalendarEvent>({
			db: db as never,
			queryClient: {} as never,
			queryKey: ['calendarEvents'],
			table: { name: 'products' },
		});

		const startAt = '2026-01-10T12:00:00.000Z';
		const endAt = new Date('2026-01-11T12:00:00.000Z');
		const dueAt = new DateTime(new Date('2026-01-12T12:00:00.000Z'));

		await opts.onUpdate?.({
			transaction: {
				mutations: [
					{
						type: 'update',
						key: 'products:⟨e2d546ed-ff34-4b34-a313-97badfa6a86b⟩',
						modified: {
							name: 'updated',
							start_at: startAt,
							end_at: endAt,
							due_at: dueAt,
							ignored_undefined: undefined,
						},
					},
				],
			} as never,
			collection: {
				utils: {
					writeUpsert: (value: Record<string, unknown>) => {
						writeUpserts.push(value);
					},
				},
			} as never,
		});

		expect(updates.length).toBe(1);
		expect(updates[0]?.id.toString()).toBe(
			'products:⟨e2d546ed-ff34-4b34-a313-97badfa6a86b⟩',
		);
		expect(updates[0]?.payload.start_at).toBe(startAt);
		expect(updates[0]?.payload.end_at).toBe(endAt);
		expect(updates[0]?.payload.due_at).toBe(dueAt);
		expect(updates[0]?.payload.due_at instanceof DateTime).toBe(true);
		expect('ignored_undefined' in (updates[0]?.payload ?? {})).toBe(false);

		expect(writeUpserts.length).toBe(1);
		expect(writeUpserts[0]?.id).toBe(
			'products:⟨e2d546ed-ff34-4b34-a313-97badfa6a86b⟩',
		);
	});
});
