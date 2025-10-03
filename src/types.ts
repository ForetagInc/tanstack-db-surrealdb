import type { Surreal } from 'surrealdb';

export type Id = string;

export type SurrealObject<T> = T & {
	id: Id;
};

export type SurrealTable = {
	[field: string]: unknown;
};

export type TableOptions = {
	db: Surreal;
	name: string;
	where?: {
		query: string;
		bindings?: Record<string, unknown>;
	};
};

export type SurrealCollectionConfig<T extends {}> = {
	id?: string;
	getKey: (row: T) => string;
	table: TableOptions;
	useLoro?: boolean;
	onError?: (e: unknown) => void;
};
