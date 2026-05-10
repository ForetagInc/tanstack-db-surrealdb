import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/query-core';
import {
	persistedCollectionOptions,
	type PersistedCollectionPersistence,
} from '@tanstack/db-sqlite-persistence-core';
import { RecordId } from 'surrealdb';

import {
	persistedSurrealCollectionOptions,
	surrealCollectionOptions,
} from '../src/index';
import type {
	PersistedSurrealCollectionOptions,
	SurrealCollectionOptions,
} from '../src/types';

type Product = {
	id: string;
	name: string;
};

const createBaseOptions = (
	overrides: Partial<SurrealCollectionOptions<Product>> = {},
) =>
	surrealCollectionOptions<Product>({
		db: {} as never,
		table: { name: 'product' },
		queryClient: new QueryClient(),
		queryKey: ['product'],
		syncMode: 'eager',
		...overrides,
	});

const persistence: PersistedCollectionPersistence = {
	adapter: {
		loadSubset: async () => [],
		applyCommittedTx: async () => undefined,
		ensureIndex: async () => undefined,
	},
	coordinator: {
		getNodeId: () => 'test-node',
		subscribe: () => () => undefined,
		publish: () => undefined,
		isLeader: () => true,
		ensureLeadership: async () => undefined,
		requestEnsurePersistedIndex: async () => undefined,
	},
};

const createPersistedOptions = (
	overrides: Partial<PersistedSurrealCollectionOptions<Product>> = {},
) =>
	persistedSurrealCollectionOptions<Product>({
		db: {} as never,
		table: { name: 'product' },
		queryClient: new QueryClient(),
		queryKey: ['product'],
		syncMode: 'eager',
		persistence,
		schemaVersion: 1,
		...overrides,
	});

describe('persistence-safe collection ids', () => {
	it('derives the same id for the same table and queryKey', () => {
		const first = createBaseOptions();
		const second = createBaseOptions();

		expect(first.id).toBe(second.id);
		expect(first.id.startsWith('surreal:product:')).toBe(true);
	});

	it('derives different ids for different query keys', () => {
		const first = createBaseOptions({
			queryKey: ['product', 'featured'],
		});
		const second = createBaseOptions({
			queryKey: ['product', 'archived'],
		});

		expect(first.id).not.toBe(second.id);
	});

	it('derives different ids for different tables', () => {
		const first = createBaseOptions({
			table: { name: 'product' },
			queryKey: ['items'],
		});
		const second = createBaseOptions({
			table: { name: 'invoice' },
			queryKey: ['items'],
		});

		expect(first.id).not.toBe(second.id);
	});

	it('preserves an explicit id override', () => {
		const options = createBaseOptions({
			id: 'custom-products',
		});

		expect(options.id).toBe('custom-products');
	});

	it('creates a table-scoped temporary id through the public schema', async () => {
		const options = createBaseOptions();
		const result = await options.schema['~standard'].validate({
			name: 'Desk',
		});

		if ('issues' in result) {
			throw new Error('Expected insert schema validation to succeed.');
		}

		const value = result.value as Product & { id: unknown };
		expect(value.name).toBe('Desk');
		expect(value.id instanceof RecordId).toBe(true);
		expect(String(value.id).startsWith('product:')).toBe(true);
	});

	it('keeps the stable id when wrapped with persistedCollectionOptions', () => {
		const base = createBaseOptions({
			queryKey: ['product', 'persisted'],
		});
		const wrapped = persistedCollectionOptions({
			persistence,
			schemaVersion: 1,
			...base,
		});

		expect(wrapped.id).toBe(base.id);
		expect(wrapped.id.startsWith('persisted-collection:')).toBe(false);
	});

	it('provides a helper that removes manual persistence wrapping boilerplate', () => {
		const options = createPersistedOptions({
			queryKey: ['product', 'helper'],
		});

		expect(options.id.startsWith('surreal:product:')).toBe(true);
		expect(options.persistence.coordinator.getNodeId()).toBe('test-node');
	});

	it('preserves an explicit id override in the persistence helper', () => {
		const options = createPersistedOptions({
			id: 'custom-persisted-products',
		});

		expect(options.id).toBe('custom-persisted-products');
	});
});
