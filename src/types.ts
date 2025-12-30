import type { BoundQuery, ExprLike, RecordId, Surreal } from 'surrealdb';

export type WithId<T> = T & {
	id: string | RecordId;
};

export type SyncedTable<T> = WithId<
	T & {
		sync_deleted?: boolean;
		updated_at?: Date;
	}
>;

export type TableOptions<T> = {
	name: string;
	where?: ExprLike | BoundQuery;
	fields?: (keyof T)[];
};

export type SurrealCollectionConfig<T extends { id: string | RecordId }> = {
	id?: string;
	// getKey: (row: T) => Id;
	db: Surreal;
	table: TableOptions<T>;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
