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

const runOwnerSubscribeWhereMatch = async (
	owner: unknown,
	profileId: unknown,
): Promise<Array<{ type: string; value?: unknown }>> => {
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
			queryKey: ['calendar-subscribe'],
			syncMode: 'eager',
			table: { name: 'calendar' },
		}),
	);

	// Prime collection data first so where() literals are normalized against
	// already-loaded RecordId instances.
	await calendar.preload();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Timed out waiting for filtered changes.')),
			250,
		);

		let subscription: { unsubscribe: () => void } | undefined;
		subscription = calendar.subscribeChanges(
			(changes) => {
				if (!changes.length) return;
				clearTimeout(timeout);
				subscription?.unsubscribe();
				resolve(changes as Array<{ type: string; value?: unknown }>);
			},
			{
				includeInitialState: true,
				where: (row) =>
					eq(
						(row as { owner: unknown }).owner,
						profileId as RecordId,
					),
			},
		);
	});
};

describe('live query record-id equality suite', () => {
	it('matches eq(owner, profileId) for different RecordId instances with same value', async () => {
		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new RecordId('account', 'x'),
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.id as RecordId)).toBe('calendar:1');
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('matches eq(owner, profileId) when owner is wrapped as { id: recordId }', async () => {
		const rows = await runOwnerMatchQuery(
			{ id: new RecordId('account', 'x') },
			new RecordId('account', 'x'),
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.id as RecordId)).toBe('calendar:1');
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('does not match for different record ids', async () => {
		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new RecordId('account', 'y'),
		);

		expect(rows.length).toBe(0);
	});

	it('remains stable across repeated runs', async () => {
		const first = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new RecordId('account', 'x'),
		);
		const second = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			new RecordId('account', 'x'),
		);

		expect(first.length).toBe(1);
		expect(second.length).toBe(1);
	});

	it('matches eq(calendar.owner, profile?.id) in production shape', async () => {
		const profile: { id?: unknown } = {
			id: new RecordId('account', 'x'),
		};

		const rows = await runOwnerMatchQuery(
			new RecordId('account', 'x'),
			profile?.id,
		);

		expect(rows.length).toBe(1);
		expect(toRecordIdString(rows[0]?.owner as RecordId)).toBe('account:x');
	});

	it('matches subscribeChanges where(eq(owner, profileId)) after preload', async () => {
		const changes = await runOwnerSubscribeWhereMatch(
			new RecordId('account', 'x'),
			new RecordId('account', 'x'),
		);

		expect(changes.length).toBe(1);
		expect(changes[0]?.type).toBe('insert');
	});
});
