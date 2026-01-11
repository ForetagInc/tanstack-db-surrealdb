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

export type MaybeSynced = { sync_deleted?: boolean };

export type SyncMode = 'eager' | 'on-demand' | 'progressive';

export type SurrealCollectionConfig<T extends { id: string | RecordId }> = {
	id?: string;
	db: Surreal;
	table: TableOptions<T>;
	syncMode?: SyncMode;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};

export type IdLike = string | RecordId;

export type Field<I> = keyof I | (string & {});
export type FieldList<I> = '*' | ReadonlyArray<Field<I>>;

export type TableOptions<T> = {
	name: string;
	fields?: FieldList<T>;
	where?: ExprLike;
	pageSize?: number;
	initialPageSize?: number;
	onProgress?: (info: {
		table: string;
		loaded: number;
		lastBatch: number;
		done: boolean;
	}) => void;
};

export type QueryBuilder<T> = {
	where: (cond: unknown) => QueryBuilder<T>;
	fields: (...f: Field<T>[]) => Promise<T[]>;
	start?: (n: number) => QueryBuilder<T>;
	limit?: (n: number) => QueryBuilder<T>;
};

export type LivePayload<T> = {
	action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
	value: T & { id: IdLike };
};
