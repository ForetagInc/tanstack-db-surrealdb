import type { LoroDoc } from 'loro-crdt';
import type { Table } from 'surrealdb';
import type { Bytes } from '../types';

export interface LoroDocLike {
	importUpdate(update: LoroDoc): void;
	exportUpdate(): Bytes;
	exportSnapshot(): Bytes;
}

export interface CRDTConfig<TItem extends object> {
	enabled: boolean;

	updatesTables: Table;

	createDoc: (id: string) => LoroDocLike;
}
