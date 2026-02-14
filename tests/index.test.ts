import { describe, expect, it } from 'bun:test';
import { RecordId } from 'surrealdb';

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

	it('returns validation issues for non-object inserts', () => {
		const opts = createOptions();
		const result = opts.schema['~standard'].validate(
			'not-an-object',
		) as { issues?: Array<{ message: string }> };

		expect(result.issues?.[0]?.message).toBe(
			'Insert data must be an object.',
		);
	});
});
