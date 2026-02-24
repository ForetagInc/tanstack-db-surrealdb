import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	CollectionConfig,
	DeleteMutationFn,
	DeleteMutationFnParams,
	InsertMutationFn,
	InsertMutationFnParams,
	LoadSubsetOptions,
	OperationConfig,
	StandardSchema,
	SyncConfig,
	Transaction,
	UpdateMutationFn,
	UpdateMutationFnParams,
	UtilsRecord,
} from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { LoroDoc } from 'loro-crdt';
import { Features, RecordId, Table } from 'surrealdb';
import { createLoroProfile } from './crdt';
import {
	normalizeRecordIdLikeFields,
	normalizeRecordIdLikeValueDeep,
	toRecordId,
	toRecordIdString,
	toRecordKeyString,
} from './id';
import { manageTable } from './table';
import type {
	AADContext,
	AdapterSyncMode,
	EncryptedEnvelope,
	LocalChange,
	SurrealCollectionOptions,
	SurrealCollectionOptionsReturn,
	SyncedTable,
	TableLike,
	TableOptions,
} from './types';
import { fromBase64, fromBytes, toBase64, toBytes } from './util';

export * from './crdt';
export * from './encryption';
export { toRecordKeyString } from './id';
export * from './types';

const TEMP_ID_PREFIX = '__temp__';
const ENVELOPE_FIELDS = [
	'version',
	'algorithm',
	'key_id',
	'nonce',
	'ciphertext',
] as const;
const NOOP = () => {};

type Cleanup = () => void;

type MutationInput<T extends { id: string | RecordId }> = Omit<T, 'id'> & {
	id?: T['id'];
};

type QueryWriteUtils = {
	writeUpsert?: (data: unknown) => void;
	writeDelete?: (key: string) => void;
};

type CRDTUpdateRow = {
	doc: string | RecordId;
	ts?: string | Date;
	update_bytes?: string;
	snapshot_bytes?: string;
	version?: number;
	algorithm?: string;
	key_id?: string;
	nonce?: string;
	ciphertext?: string;
	actor?: string;
};

type LiveMessageLike = {
	action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
	value: Record<string, unknown>;
};

type LiveSubscriptionLike = {
	isAlive?: boolean;
	subscribe: (cb: (msg: LiveMessageLike) => void | Promise<void>) => void;
	kill: () => Promise<void>;
};

const isTableObject = (value: unknown): value is TableOptions =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	typeof (value as { name: unknown }).name === 'string';

const toTableOptions = (table: TableLike): TableOptions => {
	if (typeof table === 'string') return { name: table };
	if (table instanceof Table) return { name: table.name };
	if (isTableObject(table)) return table;
	throw new Error('Expected table as string, Table, or { name }.');
};

const toTableResource = (table: TableLike): Table => {
	const normalized = toTableOptions(table);
	return new Table(normalized.name);
};

const tableNameOf = (table: TableLike): string => toTableOptions(table).name;

const getWriteUtils = (utils: unknown): QueryWriteUtils =>
	typeof utils === 'object' && utils !== null
		? (utils as QueryWriteUtils)
		: {};

const firstRow = <T>(result: T | T[] | null | undefined): T | undefined => {
	if (!result) return undefined;
	if (Array.isArray(result)) return result[0];
	return result;
};

const omitUndefined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
	Object.fromEntries(
		Object.entries(obj).filter(([, value]) => value !== undefined),
	) as Partial<T>;

const createTempRecordId = (tableName: string): RecordId => {
	const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return new RecordId(tableName, `${TEMP_ID_PREFIX}${suffix}`);
};

const isTempId = (id: string | RecordId, tableName: string): boolean => {
	const normalized = toRecordIdString(id);
	const key = normalized.startsWith(`${tableName}:`)
		? normalized.slice(tableName.length + 1)
		: normalized;
	return key.startsWith(TEMP_ID_PREFIX);
};

const toEnvelope = (
	value: Record<string, unknown>,
): EncryptedEnvelope | null => {
	const version = value.version;
	const algorithm = value.algorithm;
	const keyId = value.key_id;
	const nonce = value.nonce;
	const ciphertext = value.ciphertext;
	if (
		typeof version !== 'number' ||
		typeof algorithm !== 'string' ||
		typeof keyId !== 'string' ||
		typeof nonce !== 'string' ||
		typeof ciphertext !== 'string'
	) {
		return null;
	}
	return {
		v: version,
		alg: algorithm,
		kid: keyId,
		n: nonce,
		ct: ciphertext,
	};
};

const toStoredEnvelope = (
	envelope: EncryptedEnvelope,
): Record<string, unknown> => ({
	version: envelope.v,
	algorithm: envelope.alg,
	key_id: envelope.kid,
	nonce: envelope.n,
	ciphertext: envelope.ct,
});

const stripEnvelopeFields = (
	value: Record<string, unknown>,
): Record<string, unknown> => {
	const copy = { ...value };
	for (const key of ENVELOPE_FIELDS) delete copy[key];
	return copy;
};

const toRecordArray = <T>(rows: T | T[] | null | undefined): T[] => {
	if (!rows) return [];
	return Array.isArray(rows) ? rows : [rows];
};

async function queryRows<T>(
	db: {
		query: (
			sql: string,
			bindings?: Record<string, unknown>,
		) => Promise<unknown>;
	},
	sql: string,
	bindings?: Record<string, unknown>,
): Promise<T[]> {
	const result = await db.query(sql, bindings ?? {});
	if (Array.isArray(result)) {
		const first = result[0];
		if (Array.isArray(first)) return first as T[];
		return [];
	}
	return [];
}

function createInsertSchema<T extends { id: string | RecordId }>(
	tableName: string,
): StandardSchemaV1<MutationInput<T>, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'tanstack-db-surrealdb',
			validate: (value: unknown) => {
				if (
					!value ||
					typeof value !== 'object' ||
					Array.isArray(value)
				) {
					return {
						issues: [{ message: 'Insert data must be an object.' }],
					};
				}

				const data = normalizeRecordIdLikeFields({
					...(value as Record<string, unknown>),
				}) as MutationInput<T>;

				if (!data.id)
					data.id = createTempRecordId(tableName) as T['id'];

				return { value: data as T };
			},
			types: undefined,
		},
	};
}

function defaultAad(ctx: AADContext): Uint8Array {
	if (ctx.kind === 'base') return toBytes(`${ctx.table}:${ctx.id}`);
	const base = ctx.baseTable ?? ctx.table;
	return toBytes(`${ctx.table}:${base}:${ctx.id}`);
}

const syncModeFrom = (syncMode: AdapterSyncMode | undefined): AdapterSyncMode =>
	syncMode ?? 'eager';

const subsetCacheKey = (subset: LoadSubsetOptions): string =>
	JSON.stringify(subset, (_key, value) => {
		if (value instanceof Date) return value.toISOString();
		if (value instanceof RecordId) return toRecordIdString(value);
		if (typeof value === 'function') return undefined;
		if (
			value &&
			typeof value === 'object' &&
			'table' in (value as Record<string, unknown>) &&
			'id' in (value as Record<string, unknown>)
		) {
			try {
				return toRecordIdString(String(value));
			} catch {
				return value;
			}
		}
		return value;
	});

type BaseSyncRuntime<T extends { id: string | RecordId }> = {
	startRealtime: () => Promise<void>;
	cleanup: () => void;
	loadSubset: (subset: LoadSubsetOptions) => Promise<void>;
	unloadSubset: (subset: LoadSubsetOptions) => void;
};

function modernSurrealCollectionOptions<T extends SyncedTable<object>>(
	config: SurrealCollectionOptions<T>,
): SurrealCollectionOptionsReturn<T> {
	const {
		db,
		table,
		queryClient,
		queryKey,
		onError,
		e2ee,
		crdt,
		syncMode: inputSyncMode,
	} = config;

	if (!queryClient || !queryKey) {
		throw new Error('queryClient and queryKey are required.');
	}

	const syncMode = syncModeFrom(inputSyncMode);
	const isOnDemandLike =
		syncMode === 'on-demand' || syncMode === 'progressive';
	const isStrictOnDemand = syncMode === 'on-demand';
	const queryDrivenSyncMode: 'eager' | 'on-demand' = isOnDemandLike
		? 'on-demand'
		: 'eager';
	const tableOptions = toTableOptions(table);
	const tableName = tableOptions.name;
	const tableResource = toTableResource(table);
	const subsetIds = new Map<string, Set<string>>();
	const activeOnDemandIds = new Set<string>();

	const e2eeEnabled = e2ee?.enabled === true;
	const crdtEnabled = crdt?.enabled === true;
	const defaultCrdtProfile = crdtEnabled
		? createLoroProfile<T>(crdt.profile)
		: undefined;
	const materializeCrdt =
		crdt?.materialize ?? defaultCrdtProfile?.materialize;
	const applyCrdtLocalChange =
		crdt?.applyLocalChange ?? defaultCrdtProfile?.applyLocalChange;
	if (crdtEnabled && (!materializeCrdt || !applyCrdtLocalChange)) {
		throw new Error(
			'CRDT profile adapter is missing materialize/applyLocalChange handlers.',
		);
	}

	const tableAccess = manageTable<T>(db, tableOptions);
	const docs = new Map<string, LoroDoc>();

	const aadFor = (ctx: AADContext): Uint8Array =>
		(e2ee?.aad ?? defaultAad)(ctx);

	const getKey = (row: { id: string | RecordId }) => toRecordIdString(row.id);
	const normalizeMutationId = (id: string | RecordId): RecordId =>
		toRecordId(tableName, id);

	const normalizeRow = (row: T): T => {
		const normalized = normalizeRecordIdLikeValueDeep(row) as T;
		return {
			...normalized,
			id: normalizeMutationId(normalized.id),
		} as T;
	};

	const decodeBaseRow = async (row: Record<string, unknown>): Promise<T> => {
		if (!e2eeEnabled) {
			return normalizeRow(row as T);
		}

		const envelope = toEnvelope(row);
		if (!envelope) return normalizeRow(row as T);
		const id = toRecordKeyString(row.id as string | RecordId);
		const bytes = await e2ee.crypto.decrypt({
			envelope,
			aad: aadFor({ table: tableName, id, kind: 'base' }),
		});
		const payload = fromBytes<Record<string, unknown>>(bytes, true);
		const merged = {
			...stripEnvelopeFields(row),
			...(payload as Record<string, unknown>),
			id: normalizeMutationId(row.id as string | RecordId),
		} as T;
		return normalizeRow(merged);
	};

	const encodeBaseRow = async (
		row: Record<string, unknown>,
		id: string,
	): Promise<Record<string, unknown>> => {
		if (!e2eeEnabled) return row;
		const envelope = await e2ee.crypto.encrypt({
			plaintext: toBytes(row),
			aad: aadFor({ table: tableName, id, kind: 'base' }),
		});
		return toStoredEnvelope(envelope);
	};

	const updatesTableName = crdtEnabled
		? tableNameOf(crdt.updatesTable)
		: undefined;
	const updatesTable = crdtEnabled
		? toTableResource(crdt.updatesTable)
		: undefined;
	const snapshotsTableName =
		crdtEnabled && crdt.snapshotsTable
			? tableNameOf(crdt.snapshotsTable)
			: undefined;
	const snapshotsTable =
		crdtEnabled && crdt.snapshotsTable
			? toTableResource(crdt.snapshotsTable)
			: undefined;

	const getDoc = (id: string): LoroDoc => {
		const existing = docs.get(id);
		if (existing) return existing;
		const doc = new LoroDoc();
		docs.set(id, doc);
		return doc;
	};

	const docRef = (id: string): RecordId => new RecordId(tableName, id);
	const idFromDocRef = (doc: string | RecordId): string =>
		toRecordKeyString(doc);

	const resolveActor = (
		id: string,
		change?: LocalChange<T>,
	): string | undefined => {
		if (!crdtEnabled) return undefined;
		const candidate = crdt.actor ?? crdt.localActorId;
		if (typeof candidate === 'function') {
			return candidate({ id, change });
		}
		return candidate;
	};

	const decodeUpdateBytes = async (
		row: CRDTUpdateRow,
		kind: 'update' | 'snapshot',
	): Promise<Uint8Array> => {
		if (!e2eeEnabled) {
			if (kind === 'snapshot') {
				const snapshot = row.snapshot_bytes;
				if (!snapshot) return new Uint8Array();
				return fromBase64(snapshot);
			}
			const update = row.update_bytes;
			if (!update) return new Uint8Array();
			return fromBase64(update);
		}
		const envelope = toEnvelope(row as unknown as Record<string, unknown>);
		if (!envelope) return new Uint8Array();
		const id = idFromDocRef(row.doc);
		return e2ee.crypto.decrypt({
			envelope,
			aad: aadFor({
				table:
					kind === 'snapshot'
						? (snapshotsTableName ?? tableName)
						: (updatesTableName ?? tableName),
				baseTable: tableName,
				id,
				kind,
			}),
		});
	};

	const encodeUpdatePayload = async (
		bytes: Uint8Array,
		id: string,
		kind: 'update' | 'snapshot',
	): Promise<Record<string, unknown>> => {
		if (!e2eeEnabled) {
			if (kind === 'snapshot') return { snapshot_bytes: toBase64(bytes) };
			return { update_bytes: toBase64(bytes) };
		}

		const targetTable =
			kind === 'snapshot' ? snapshotsTableName : updatesTableName;
		const envelope = await e2ee.crypto.encrypt({
			plaintext: bytes,
			aad: aadFor({
				table: targetTable ?? tableName,
				baseTable: tableName,
				id,
				kind,
			}),
		});
		return toStoredEnvelope(envelope);
	};

	const persistCrdtUpdate = async (
		id: string,
		bytes: Uint8Array,
		change?: LocalChange<T>,
	) => {
		if (!crdtEnabled || !updatesTable) return;
		const payload = await encodeUpdatePayload(bytes, id, 'update');
		const actor = resolveActor(id, change);
		const row = {
			doc: docRef(id),
			ts: new Date().toISOString(),
			...(actor ? { actor } : {}),
			...payload,
		};
		await db.create(updatesTable).content(row);
	};

	const persistMaterialized = async (materialized: T) => {
		if (!crdtEnabled || crdt.persistMaterializedView !== true) return;
		const id = toRecordKeyString(materialized.id);
		if (!e2eeEnabled) {
			const { id: _ignoredId, ...rest } = materialized as Record<
				string,
				unknown
			>;
			await db.upsert(normalizeMutationId(materialized.id)).merge(rest);
			return;
		}

		const payload = await encodeBaseRow(
			omitUndefined({
				...(materialized as Record<string, unknown>),
				id: undefined,
			}),
			id,
		);
		await db.upsert(normalizeMutationId(materialized.id)).merge(payload);
	};

	const hydratePlainRows = async (
		rows: Array<Record<string, unknown>>,
		write: (
			change:
				| { type: 'insert' | 'update'; value: T }
				| { type: 'delete'; key: string },
		) => void,
		begin: () => void,
		commit: () => void,
		type: 'insert' | 'update' = 'insert',
	) => {
		if (!rows.length) return;
		begin();
		try {
			for (const row of rows) {
				const decoded = await decodeBaseRow(row);
				write({ type, value: decoded });
			}
		} finally {
			commit();
		}
	};

	const hydrateCrdtDoc = async (
		id: string,
		write: (
			change:
				| { type: 'insert' | 'update'; value: T }
				| { type: 'delete'; key: string },
		) => void,
		begin: () => void,
		commit: () => void,
		writeType: 'insert' | 'update' = 'insert',
	) => {
		if (!crdtEnabled || !updatesTableName) return;
		const doc = getDoc(id);
		let since: string | undefined;

		if (snapshotsTableName) {
			const snapshots = await queryRows<CRDTUpdateRow>(
				db,
				`SELECT * FROM type::table($table) WHERE doc = $doc ORDER BY ts DESC LIMIT 1;`,
				{
					table: snapshotsTableName,
					doc: docRef(id),
				},
			);
			const snapshot = snapshots[0];
			if (snapshot) {
				const bytes = await decodeUpdateBytes(snapshot, 'snapshot');
				if (bytes.byteLength) doc.import(bytes);
				since =
					typeof snapshot.ts === 'string'
						? snapshot.ts
						: snapshot.ts instanceof Date
							? snapshot.ts.toISOString()
							: undefined;
			}
		}

		const updates = await queryRows<CRDTUpdateRow>(
			db,
			since
				? `SELECT * FROM type::table($table) WHERE doc = $doc AND ts > $since ORDER BY ts ASC;`
				: `SELECT * FROM type::table($table) WHERE doc = $doc ORDER BY ts ASC;`,
			{
				table: updatesTableName,
				doc: docRef(id),
				since,
			},
		);

		for (const update of updates) {
			const bytes = await decodeUpdateBytes(update, 'update');
			if (!bytes.byteLength) continue;
			doc.import(bytes);
		}

		const materialized = normalizeRow(materializeCrdt(doc, id));
		begin();
		try {
			write({ type: writeType, value: materialized });
		} finally {
			commit();
		}
	};

	const updateActiveOnDemandIds = () => {
		activeOnDemandIds.clear();
		for (const ids of subsetIds.values()) {
			for (const id of ids) activeOnDemandIds.add(id);
		}
	};

	const createSyncRuntime = (
		ctx: Parameters<SyncConfig<T>['sync']>[0],
	): BaseSyncRuntime<T> => {
		let cleanupBaseLive: Cleanup = NOOP;
		let cleanupUpdateLive: Cleanup = NOOP;
		let killed = false;

		const ensureBaseLive = async () => {
			if (cleanupBaseLive !== NOOP) return;
			if (!db.isFeatureSupported?.(Features.LiveQueries)) return;
			const live = (await db.live(
				tableResource,
			)) as unknown as LiveSubscriptionLike;
			if (killed) {
				await live.kill();
				return;
			}
			live.subscribe(async (message) => {
				if (message.action === 'KILLED') return;
				const row = message.value as Record<string, unknown>;
				const id = toRecordKeyString(row.id as string | RecordId);

				const wasVisible = activeOnDemandIds.has(id);
				if (
					isStrictOnDemand &&
					!wasVisible &&
					message.action !== 'DELETE'
				)
					return;

				if (message.action === 'DELETE') {
					for (const ids of subsetIds.values()) ids.delete(id);
					updateActiveOnDemandIds();
					if (isStrictOnDemand && !wasVisible) return;
					ctx.begin();
					try {
						ctx.write({
							type: 'delete',
							key: `${tableName}:${id}`,
						});
					} finally {
						ctx.commit();
					}
					return;
				}

				const decoded = await decodeBaseRow(row);
				ctx.begin();
				try {
					ctx.write({
						type: message.action === 'CREATE' ? 'insert' : 'update',
						value: decoded,
					});
				} finally {
					ctx.commit();
				}
			});
			cleanupBaseLive = () => {
				void live.kill().catch(() => undefined);
				cleanupBaseLive = NOOP;
			};
		};

		const ensureUpdateLive = async () => {
			if (!crdtEnabled || !updatesTable) return;
			if (cleanupUpdateLive !== NOOP) return;
			if (!db.isFeatureSupported?.(Features.LiveQueries)) return;

			const live = (await db.live(
				updatesTable,
			)) as unknown as LiveSubscriptionLike;
			if (killed) {
				await live.kill();
				return;
			}

			live.subscribe(async (message) => {
				if (message.action === 'KILLED') return;
				if (message.action === 'DELETE') return;

				const value = message.value as unknown as CRDTUpdateRow;
				const id = idFromDocRef(value.doc);

				if (value.actor && value.actor === resolveActor(id)) return;

				if (isStrictOnDemand && !activeOnDemandIds.has(id)) return;

				const doc = getDoc(id);
				const bytes = await decodeUpdateBytes(value, 'update');
				if (!bytes.byteLength) return;
				doc.import(bytes);
				const materialized = normalizeRow(materializeCrdt(doc, id));
				ctx.begin();
				try {
					ctx.write({ type: 'update', value: materialized });
				} finally {
					ctx.commit();
				}
			});

			cleanupUpdateLive = () => {
				void live.kill().catch(() => undefined);
				cleanupUpdateLive = NOOP;
			};
		};

		const loadSubset = async (subset: LoadSubsetOptions) => {
			if (!isOnDemandLike) return;
			const key = subsetCacheKey(subset);
			const rows = await tableAccess.loadSubset(subset);
			const ids = new Set(
				(rows as unknown as Array<Record<string, unknown>>).map((row) =>
					toRecordKeyString(row.id as string | RecordId),
				),
			);
			subsetIds.set(key, ids);
			updateActiveOnDemandIds();

			if (!crdtEnabled) {
				await hydratePlainRows(
					rows as unknown as Array<Record<string, unknown>>,
					ctx.write,
					ctx.begin,
					ctx.commit,
					'insert',
				);
				await ensureBaseLive();
				return;
			}

			for (const id of ids) {
				await hydrateCrdtDoc(
					id,
					ctx.write,
					ctx.begin,
					ctx.commit,
					'insert',
				);
			}
			await ensureUpdateLive();
		};

		const unloadSubset = (subset: LoadSubsetOptions) => {
			if (!isOnDemandLike) return;
			const key = subsetCacheKey(subset);
			subsetIds.delete(key);
			updateActiveOnDemandIds();
			if (subsetIds.size === 0) {
				cleanupBaseLive();
				cleanupUpdateLive();
			}
		};

		const startRealtime = async () => {
			if (!crdtEnabled) {
				await ensureBaseLive();
				return;
			}
			await ensureUpdateLive();
		};

		const cleanup = () => {
			killed = true;
			subsetIds.clear();
			updateActiveOnDemandIds();
			cleanupBaseLive();
			cleanupUpdateLive();
		};

		return {
			startRealtime,
			cleanup,
			loadSubset,
			unloadSubset,
		};
	};

	const base = queryCollectionOptions({
		schema: createInsertSchema<T>(tableName),
		getKey,
		queryKey,
		queryClient,
		syncMode: queryDrivenSyncMode,
		queryFn: async ({ meta }) => {
			try {
				if (isOnDemandLike && !meta?.loadSubsetOptions) {
					return [] as T[];
				}

				if (!crdtEnabled) {
					if (!isOnDemandLike) {
						const rows = await toRecordArray(
							await db.select(tableResource),
						);
						const decoded = await Promise.all(
							rows.map((row) =>
								decodeBaseRow(row as Record<string, unknown>),
							),
						);
						return decoded;
					}

					const rows = await tableAccess.loadSubset(
						meta?.loadSubsetOptions,
					);
					const decoded = await Promise.all(
						(rows as unknown as Array<Record<string, unknown>>).map(
							(row) => decodeBaseRow(row),
						),
					);
					return decoded;
				}

				if (isOnDemandLike) return [] as T[];

				if (!updatesTableName) return [] as T[];
				const updates = await queryRows<CRDTUpdateRow>(
					db,
					`SELECT * FROM type::table($table) ORDER BY ts ASC;`,
					{ table: updatesTableName },
				);
				for (const update of updates) {
					const id = idFromDocRef(update.doc);
					const doc = getDoc(id);
					const bytes = await decodeUpdateBytes(update, 'update');
					if (!bytes.byteLength) continue;
					doc.import(bytes);
				}

				return [...docs.entries()].map(([id, doc]) =>
					normalizeRow(materializeCrdt(doc, id)),
				);
			} catch (error) {
				onError?.(error);
				return [] as T[];
			}
		},
		onInsert: (async (params: InsertMutationFnParams<T>) => {
			const out: T[] = [];
			const writeUtils = getWriteUtils(params.collection.utils);
			for (const mutation of params.transaction.mutations) {
				if (mutation.type !== 'insert') continue;

				const normalized = normalizeRow(mutation.modified as T);
				if (!crdtEnabled) {
					const idKey = toRecordKeyString(normalized.id);
					const payload = omitUndefined({
						...(normalized as Record<string, unknown>),
						id: undefined,
					});
					const recordPayload = await encodeBaseRow(payload, idKey);

					if (isTempId(normalized.id, tableName)) {
						const created = await db
							.create(tableResource)
							.content(recordPayload);
						const createdRow = firstRow(
							toRecordArray(created as unknown as T | T[]),
						);
						const createdId =
							createdRow &&
							(createdRow as Record<string, unknown>).id
								? ((createdRow as Record<string, unknown>).id as
										| string
										| RecordId)
								: normalized.id;
						const resolved = {
							...normalized,
							id: normalizeMutationId(createdId),
						} as T;
						out.push(resolved);
						writeUtils.writeUpsert?.(resolved);
						continue;
					}

					await db.insert(tableResource, {
						id: normalizeMutationId(normalized.id),
						...recordPayload,
					});
					out.push(normalized);
					writeUtils.writeUpsert?.(normalized);
					continue;
				}

				const id = toRecordKeyString(normalized.id);
				const doc = getDoc(id);
				const vv = doc.oplogVersion();
				const localChange: LocalChange<T> = {
					type: 'insert',
					value: normalized,
				};
				applyCrdtLocalChange(doc, localChange);
				const bytes = doc.export({ mode: 'update', from: vv });
				await persistCrdtUpdate(id, bytes, localChange);
				const materialized = normalizeRow(materializeCrdt(doc, id));
				await persistMaterialized(materialized);
				out.push(materialized);
				writeUtils.writeUpsert?.(materialized);
			}

			return out as unknown as StandardSchema<T>;
		}) as InsertMutationFn<T, string, UtilsRecord, StandardSchema<T>>,
		onUpdate: (async (params: UpdateMutationFnParams<T>) => {
			const writeUtils = getWriteUtils(params.collection.utils);
			for (const mutation of params.transaction.mutations) {
				if (mutation.type !== 'update') continue;
				const mutationId = normalizeMutationId(
					mutation.key as RecordId | string,
				);
				const normalizedModified = omitUndefined(
					normalizeRecordIdLikeFields({
						...(mutation.modified as Record<string, unknown>),
					}) as Record<string, unknown>,
				);
				const normalized = normalizeRow({
					...(normalizedModified as Partial<T>),
					id: mutationId,
				} as T);

				if (!crdtEnabled) {
					if (!e2eeEnabled) {
						await db.update(mutationId).merge(normalizedModified);
						writeUtils.writeUpsert?.(normalized);
						continue;
					}

					const current = await db.select(mutationId);
					const currentRows = toRecordArray(
						current as unknown as
							| Record<string, unknown>
							| Array<Record<string, unknown>>,
					);
					const currentRow = currentRows[0];
					const decodedCurrent = currentRow
						? await decodeBaseRow(currentRow)
						: ({ id: mutationId } as T);
					const merged = {
						...(decodedCurrent as Record<string, unknown>),
						...(normalizedModified as Record<string, unknown>),
					};
					delete merged.id;
					const encoded = await encodeBaseRow(
						omitUndefined(merged),
						toRecordKeyString(mutationId),
					);
					await db.update(mutationId).merge(encoded);
					writeUtils.writeUpsert?.(
						normalizeRow({ ...decodedCurrent, ...merged } as T),
					);
					continue;
				}

				const id = toRecordKeyString(mutationId);
				const doc = getDoc(id);
				const vv = doc.oplogVersion();
				const localChange: LocalChange<T> = {
					type: 'update',
					value: normalized,
				};
				applyCrdtLocalChange(doc, localChange);
				const bytes = doc.export({ mode: 'update', from: vv });
				await persistCrdtUpdate(id, bytes, localChange);
				const materialized = normalizeRow(materializeCrdt(doc, id));
				await persistMaterialized(materialized);
				writeUtils.writeUpsert?.(materialized);
			}
			return { refetch: false } as unknown as StandardSchema<T>;
		}) as UpdateMutationFn<T, string, UtilsRecord, StandardSchema<T>>,
		onDelete: (async (params: DeleteMutationFnParams<T>) => {
			const writeUtils = getWriteUtils(params.collection.utils);
			for (const mutation of params.transaction.mutations) {
				if (mutation.type !== 'delete') continue;
				const mutationId = normalizeMutationId(
					mutation.key as RecordId | string,
				);
				const id = toRecordKeyString(mutationId);
				if (!crdtEnabled) {
					await db.delete(mutationId);
					writeUtils.writeDelete?.(`${tableName}:${id}`);
					continue;
				}

				const doc = getDoc(id);
				const vv = doc.oplogVersion();
				const localChange: LocalChange<T> = {
					type: 'delete',
					value: { id: mutationId } as T,
				};
				applyCrdtLocalChange(doc, localChange);
				const bytes = doc.export({ mode: 'update', from: vv });
				await persistCrdtUpdate(id, bytes, localChange);
				writeUtils.writeDelete?.(`${tableName}:${id}`);
			}
			return { refetch: false } as unknown as StandardSchema<T>;
		}) as DeleteMutationFn<T, string, UtilsRecord, StandardSchema<T>>,
	} as never) as SurrealCollectionOptionsReturn<T>;

	const baseSync = base.sync?.sync;
	const sync = baseSync
		? {
				sync: (ctx: Parameters<NonNullable<typeof baseSync>>[0]) => {
					const canRunBaseSync =
						typeof (ctx.collection as { on?: unknown })?.on ===
						'function';
					const baseResult = canRunBaseSync
						? baseSync(ctx)
						: undefined;
					const baseCleanup =
						typeof baseResult === 'function'
							? baseResult
							: typeof baseResult === 'object' &&
									baseResult &&
									'cleanup' in baseResult &&
									typeof (
										baseResult as {
											cleanup?: unknown;
										}
									).cleanup === 'function'
								? (
										baseResult as {
											cleanup: Cleanup;
										}
									).cleanup
								: NOOP;
					const runtime = createSyncRuntime(
						ctx as Parameters<SyncConfig<T>['sync']>[0],
					);

					const start = async () => {
						if (!isOnDemandLike) {
							if (!crdtEnabled) {
								const rows = toRecordArray(
									await db.select(tableResource),
								) as Array<Record<string, unknown>>;
								await hydratePlainRows(
									rows,
									ctx.write,
									ctx.begin,
									ctx.commit,
									'insert',
								);
								await runtime.startRealtime();
								ctx.markReady();
								return;
							}

							if (updatesTableName) {
								const updates = await queryRows<CRDTUpdateRow>(
									db,
									`SELECT * FROM type::table($table) ORDER BY ts ASC;`,
									{ table: updatesTableName },
								);
								for (const update of updates) {
									const id = idFromDocRef(update.doc);
									const doc = getDoc(id);
									const bytes = await decodeUpdateBytes(
										update,
										'update',
									);
									if (!bytes.byteLength) continue;
									doc.import(bytes);
								}
								ctx.begin();
								try {
									for (const [id, doc] of docs.entries()) {
										ctx.write({
											type: 'insert',
											value: normalizeRow(
												materializeCrdt(doc, id),
											),
										});
									}
								} finally {
									ctx.commit();
								}
								await runtime.startRealtime();
							}
							ctx.markReady();
							return;
						}

						ctx.markReady();
						if (syncMode === 'progressive') {
							void runtime
								.loadSubset({})
								.catch((error) => onError?.(error));
						}
					};

					void start().catch((error) => onError?.(error));

					return {
						cleanup: () => {
							runtime.cleanup();
							baseCleanup();
						},
						loadSubset: async (subset) => {
							await runtime.loadSubset(subset);
						},
						unloadSubset: (subset) => {
							runtime.unloadSubset(subset);
						},
					};
				},
			}
		: undefined;

	return {
		...base,
		sync: sync ?? base.sync,
	} as SurrealCollectionOptionsReturn<T>;
}

export function surrealCollectionOptions<T extends SyncedTable<object>>(
	config: SurrealCollectionOptions<T>,
): CollectionConfig<
	T,
	string,
	StandardSchemaV1<MutationInput<T>, T>,
	UtilsRecord
> & {
	schema: StandardSchemaV1<MutationInput<T>, T>;
	utils: UtilsRecord;
} {
	return modernSurrealCollectionOptions(config);
}

declare module '@tanstack/db' {
	interface Collection<
		T extends object = Record<string, unknown>,
		TKey extends string | number = string | number,
		TUtils extends UtilsRecord = UtilsRecord,
		TSchema extends StandardSchemaV1 = StandardSchemaV1,
		TInsertInput extends object = T,
	> {
		delete(
			keys: Array<TKey | RecordId | string> | TKey | RecordId | string,
			config?: OperationConfig,
		): Transaction<any>;
	}
}
