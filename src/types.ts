import type { LoadSubsetOptions } from '@tanstack/db';
import type { QueryClient } from '@tanstack/query-core';
import type { RecordId, Surreal } from 'surrealdb';

export type WithId<T> = T & { id: string | RecordId };

export type SyncedTable<T> = WithId<
	T & {
		sync_deleted?: boolean;
		updated_at?: Date | number | string;
	}
>;

export type SurrealSubset = LoadSubsetOptions;

export type TableOptions = {
	name: string;
	relation?: boolean;
};

export type SyncMode = 'eager' | 'on-demand';

export type SurrealCollectionConfig = {
	id?: string;
	db: Surreal;
	table: TableOptions;

	syncMode?: SyncMode;

	queryKey: readonly unknown[];
	queryClient: QueryClient;

	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
