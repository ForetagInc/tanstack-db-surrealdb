import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	CollectionConfig,
	LoadSubsetOptions,
	UtilsRecord,
} from '@tanstack/db';
import type { QueryClient } from '@tanstack/query-core';
import type { LoroDoc } from 'loro-crdt';
import type { RecordId, Surreal, Table } from 'surrealdb';

import type { CryptoProvider } from './encryption';

export type Bytes = Uint8Array;

export type WithId<T> = T & { id: string | RecordId };

export type SyncedTable<T> = WithId<
	T & {
		sync_deleted?: boolean;
		updated_at?: Date | number | string;
	}
>;

export type TableOptions = {
	name: string;
	relation?: boolean;
};

export type TableLike = Table | TableOptions | string;

export type SurrealSubset = LoadSubsetOptions;

export type EncryptedEnvelope = {
	v: number;
	alg: string;
	kid: string;
	n: string;
	ct: string;
};

export type EnvelopeKind = 'base' | 'update' | 'snapshot';

export type AADContext = {
	table: string;
	id: string;
	kind: EnvelopeKind;
	baseTable?: string;
};

export type SurrealE2EEOptions = {
	enabled: boolean;
	crypto: CryptoProvider;
	aad?: (ctx: AADContext) => Bytes;
};

export type LocalChange<T> = {
	type: 'insert' | 'update' | 'delete';
	value: T;
};

export type CRDTActorContext<T> = {
	id: string;
	change?: LocalChange<T>;
};

export type SurrealCRDTOptions<T extends object> = {
	enabled: boolean;
	profile: 'json' | 'richtext';
	updatesTable: TableLike;
	snapshotsTable?: TableLike;
	materialize?: (doc: LoroDoc, id: string) => T;
	applyLocalChange?: (doc: LoroDoc, change: LocalChange<T>) => void;
	persistMaterializedView?: boolean;
	actor?: string | ((ctx: CRDTActorContext<T>) => string | undefined);
	/** @deprecated Use `actor` instead. */
	localActorId?: string;
};

export type AdapterSyncMode = 'eager' | 'on-demand' | 'progressive';

export type SurrealCollectionOptions<T extends object> = Omit<
	CollectionConfig<T>,
	'onInsert' | 'onUpdate' | 'onDelete' | 'sync' | 'getKey' | 'syncMode'
> & {
	db: Surreal;
	table: TableLike;
	queryKey: readonly unknown[];
	queryClient: QueryClient;
	syncMode?: AdapterSyncMode;
	e2ee?: SurrealE2EEOptions;
	crdt?: SurrealCRDTOptions<T>;
	onError?: (error: unknown) => void;
};

export type SurrealCollectionOptionsReturn<T extends { id: string | RecordId }> =
	CollectionConfig<
		T,
		string,
		StandardSchemaV1<Omit<T, 'id'> & { id?: T['id'] }, T>,
		UtilsRecord
	> & {
		schema: StandardSchemaV1<Omit<T, 'id'> & { id?: T['id'] }, T>;
		utils: UtilsRecord;
	};
