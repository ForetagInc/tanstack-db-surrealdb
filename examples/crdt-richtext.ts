import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId, Surreal } from 'surrealdb';

import { surrealCollectionOptions } from '../src';

const db = new Surreal();
const queryClient = new QueryClient();

type Doc = {
	id: string | RecordId;
	title?: string;
	content: string;
};

export const docs = createCollection(
	surrealCollectionOptions<Doc>({
		db,
		table: { name: 'doc' },
		queryClient,
		queryKey: ['doc'],
		syncMode: 'on-demand',
		crdt: {
			enabled: true,
			profile: 'richtext',
			updatesTable: { name: 'crdt_update' },
			snapshotsTable: { name: 'crdt_snapshot' },
			actor: ({ id }) =>
				id.startsWith('team-a') ? 'device:team-a:abc' : 'device:team-b:abc',
		},
	}),
);
