import { describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

describe('collection.delete RecordId normalization', () => {
	it('deletes rows when called with a RecordId key', async () => {
		const deleted: string[] = [];
		const db = {
			delete: async (id: RecordId) => {
				deleted.push(id.toString());
			},
		};

		const folders = createCollection(
			surrealCollectionOptions<{
				id: RecordId<'folder'>;
				name: string;
			}>({
				db: db as never,
				table: { name: 'folder' },
				queryClient: new QueryClient(),
				queryKey: ['folder', 'test'],
				syncMode: 'on-demand',
			}),
		);

		folders.startSyncImmediate();
		folders._state.syncedData.set('folder:alpha', {
			id: new RecordId('folder', 'alpha'),
			name: 'Alpha',
		});
		expect(folders.has('folder:alpha')).toBe(true);

		const tx = folders.delete(new RecordId('folder', 'alpha'));
		await tx.isPersisted.promise;

		expect(deleted).toEqual(['folder:alpha']);
		expect(folders.has('folder:alpha')).toBe(false);
	});

	it('deletes rows through the public live-query workflow', async () => {
		const deleted: string[] = [];
		const rows = [
			{
				id: new RecordId('folder', 'alpha'),
				name: 'Alpha',
			},
		];
		const db = {
			delete: async (id: RecordId) => {
				deleted.push(id.toString());
			},
			isFeatureSupported: () => false,
			query: async () => [rows],
		};

		const folders = createCollection(
			surrealCollectionOptions<{
				id: RecordId<'folder'>;
				name: string;
			}>({
				db: db as never,
				table: { name: 'folder' },
				queryClient: new QueryClient(),
				queryKey: ['folder', 'test', 'public'],
				syncMode: 'on-demand',
			}),
		);
		const liveFolders = createLiveQueryCollection((query) =>
			query.from({ folder: folders }),
		);

		await liveFolders.preload();
		expect(liveFolders.toArray).toHaveLength(1);
		expect(folders.has('folder:alpha')).toBe(true);

		const tx = folders.delete(new RecordId('folder', 'alpha'));
		await tx.isPersisted.promise;

		expect(deleted).toEqual(['folder:alpha']);
		expect(folders.has('folder:alpha')).toBe(false);
		expect(liveFolders.toArray).toHaveLength(0);
	});
});
