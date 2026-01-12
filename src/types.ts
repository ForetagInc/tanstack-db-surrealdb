import type { QueryClient } from '@tanstack/query-core';
import type { ExprLike, RecordId, Surreal } from 'surrealdb';

export type WithId<T> = T & { id: string | RecordId };

export type SyncedTable<T> = WithId<
	T & {
		sync_deleted?: boolean;
		updated_at?: Date | number | string;
	}
>;

export type SurrealField<T> = Extract<keyof T, string> | (string & {});
export type FieldList<T> = '*' | ReadonlyArray<SurrealField<T>>;

export type SurrealSubset = {
	where?: ExprLike;
	orderBy?: string | readonly string[];
	limit?: number;
	offset?: number;
};

export type TableOptions<T> = {
	name: string;
	fields?: FieldList<T>;
	where?: ExprLike; // base where applied always
};

export type SyncMode = 'eager' | 'on-demand';

export type SurrealCollectionConfig<T extends { id: string | RecordId }> = {
	id?: string;
	db: Surreal;
	table: TableOptions<T>;

	syncMode?: SyncMode;

	queryKey: readonly unknown[];
	queryClient?: QueryClient;

	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
