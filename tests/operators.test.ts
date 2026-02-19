import { describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { RecordId } from 'surrealdb';
import { eqRecordId } from '../src/index';

describe('eqRecordId', () => {
	it('matches by table/id value, not object identity', async () => {
		const queryClient = new QueryClient();
		const owner = new RecordId('account', 'x');

		const rows = createCollection(
			queryCollectionOptions({
				queryKey: ['rows'],
				queryClient,
				getKey: (row: { id: string }) => row.id,
				queryFn: async () => [{ id: '1', owner }],
			}),
		);

		const ownerFromElsewhere = new RecordId('account', 'x');

		const stableEq = createLiveQueryCollection((q) =>
			q
				.from({ row: rows })
				.where(({ row }) => eqRecordId(row.owner, ownerFromElsewhere))
				.select(({ row }) => ({ id: row.id })),
		);
		const nonMatch = createLiveQueryCollection((q) =>
			q
				.from({ row: rows })
				.where(({ row }) => eqRecordId(row.owner, 'account:y'))
				.select(({ row }) => ({ id: row.id })),
		);

		await stableEq.preload();
		await nonMatch.preload();

		expect(stableEq.toArray).toEqual([{ id: '1' }]);
		expect(nonMatch.toArray).toEqual([]);
	});
});
