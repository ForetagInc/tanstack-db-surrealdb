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

class ForeignRid {
	constructor(private rid: string) {}
	toString() {
		return this.rid;
	}
}

const runOwnerMatchQuery = async (
	owner: unknown,
	profileId: unknown,
): Promise<Array<{ id: string | RecordId; owner: unknown }>> => {
	const queryClient = new QueryClient();
	const db = {
		query: async () => [
			[
				{
					id: new RecordId('calendar', '1'),
					owner,
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

	const filtered = createLiveQueryCollection((q) =>
		q
			.from({ calendar })
			.where(({ calendar }) => eq(calendar.owner, profileId as RecordId))
			.select(({ calendar }) => ({
				id: calendar.id,
				owner: calendar.owner,
			})),
	);

	await filtered.preload();
	return filtered.toArray as Array<{ id: string | RecordId; owner: unknown }>;
};

describe('live query record-id equality suite', () => {
	it('matches eq(owner, profileId) for native RecordId instances', async () => {
		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new RecordId('account', 'x'),
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.id as RecordId)).toBe('calendar:1');
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('matches eq(owner, profileId) when profileId is a foreign RecordId-like object', async () => {
		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new ForeignRid('account:x'),
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.id as RecordId)).toBe('calendar:1');
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('matches eq(owner, profileId) when owner is wrapped as { id: recordId }', async () => {
		const rows = await runOwnerMatchQuery(
			{ id: new RecordId('account', 'x') },
			new ForeignRid('account:x'),
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.id as RecordId)).toBe('calendar:1');
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('does not match for different record ids', async () => {
		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new ForeignRid('account:y'),
		);

		expect(rows.length).toBe(0);
	});
});
