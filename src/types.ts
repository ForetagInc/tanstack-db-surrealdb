import type { Expr, Surreal } from 'surrealdb';

export type Id = string;

export type SurrealObject<T> = T & {
	id: Id;
};

export type SurrealTable = {
	[field: string]: unknown;
};

export type SurrealField<I> = keyof I | (string & {});

export type SyncedRow<T> = SurrealObject<
	T & {
		sync_deleted?: boolean;
		updated_at?: Date;
	}
>;

export type TableOptions<T> = {
	db: Surreal;
	name: string;
	where?: Expr;
	fields?: SurrealField<T>;
};

export type SurrealCollectionConfig<T extends SurrealObject<object>> = {
	id?: string;
	// getKey: (row: T) => Id;
	table: TableOptions<T>;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
