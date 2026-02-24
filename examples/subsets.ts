import {
	and,
	createCollection,
	createLiveQueryCollection,
	eq,
	gte,
	lte,
} from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { Surreal } from 'surrealdb';

import { surrealCollectionOptions } from '../src';

const db = new Surreal();
const queryClient = new QueryClient();

type FileRow = {
	id: string;
	owner: string;
	name: string;
	updated_at: string;
};

export const files = createCollection(
	surrealCollectionOptions<FileRow>({
		db,
		table: { name: 'file' },
		queryClient,
		queryKey: ['file'],
		syncMode: 'on-demand',
	}),
);

export const ownerFiles = createLiveQueryCollection((q) =>
	q
		.from({ files })
		.where(({ files }) => eq(files.owner, 'account:1'))
		.select(({ files }) => files),
);

export const januaryFiles = createLiveQueryCollection((q) =>
	q
		.from({ files })
		.where(({ files }) =>
			and(
				gte(files.updated_at, '2026-01-01T00:00:00.000Z'),
				lte(files.updated_at, '2026-01-31T23:59:59.999Z'),
			),
		)
		.select(({ files }) => files),
);

await ownerFiles.preload();
await januaryFiles.preload();
