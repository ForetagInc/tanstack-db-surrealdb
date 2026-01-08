import type { ExprLike, RecordId, Surreal } from 'surrealdb';

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
	fields?: (keyof T)[];
	where?: ExprLike;
};

export type SurrealCollectionConfig<T extends { id: string | RecordId }> = {
	id?: string;
	db: Surreal;
	table: TableOptions<T>;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
