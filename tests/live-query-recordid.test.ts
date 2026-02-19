import { describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';
import { toRecordIdString } from '../src/id';
import { surrealCollectionOptions } from '../src/index';

type CalendarRow = {
	id: string | RecordId;
	owner: unknown;
	title: string;
};

class RecordId2 {
	constructor(private rid: string) {}
	toString() {
		return this.rid;
	}
}

describe('live query record-id equality', () => {
	it('matches eq(owner, profileId) when profileId is a foreign RecordId-like object', async () => {
		const queryClient = new QueryClient();
		const db = {
			query: async () => [
				[
					{
						id: new RecordId('calendar', '1'),
						owner: new RecordId('account', 'x'),
						title: 'Planning',
					},
				],
			],
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			update: () => ({ merge: async () => {} }),
			delete: async () => {},
			upsert: () => ({ merge: async () => {} }),
			isFeatureSupported: () => false,
			live: () => ({ subscribe: () => {}, kill: async () => {} }),
		};

		const calendar = createCollection(
			surrealCollectionOptions<CalendarRow>({
				db: db as never,
				queryClient,
				queryKey: ['calendar'],
				syncMode: 'on-demand',
				table: { name: 'calendar' },
			}),
		);

		const foreignProfileId = new RecordId2('account:x');

		const filtered = createLiveQueryCollection((q) =>
			q
				.from({ calendar })
				.where(({ calendar }) =>
					eq(calendar.owner, foreignProfileId as unknown as RecordId),
				)
				.select(({ calendar }) => ({
					id: calendar.id,
					owner: calendar.owner,
				})),
		);

		await filtered.preload();

		expect(filtered.toArray.length).toBe(1);
		expect(toRecordIdString(filtered.toArray[0]?.id as RecordId)).toBe(
			'calendar:1',
		);
		expect(toRecordIdString(filtered.toArray[0]?.owner as RecordId)).toBe(
			'account:x',
		);
	});
});
