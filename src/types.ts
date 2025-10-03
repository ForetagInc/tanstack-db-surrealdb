import type { Expr, Surreal } from 'surrealdb';

export type Id = string;

export type SurrealObject<T> = T & {
	id: Id;
};

export type SurrealTable = {
	[field: string]: unknown;
};

export type SyncedRow = SurrealObject<{
	sync_deleted: boolean;
	updated_at: Date;
}>;

export type TableOptions = {
	db: Surreal;
	name: string;
	where?: Expr;
};

export type SurrealCollectionConfig<T extends SyncedRow> = {
	id?: string;
	getKey: (row: T) => Id;
	table: TableOptions;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
