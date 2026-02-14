import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	CollectionConfig,
	DeleteMutationFn,
	DeleteMutationFnParams,
	InsertMutationFn,
	InsertMutationFnParams,
	StandardSchema,
	UpdateMutationFn,
	UpdateMutationFnParams,
	UtilsRecord,
} from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { type Container, LoroDoc } from 'loro-crdt';
import { Features, RecordId } from 'surrealdb';

import {
	normalizeRecordIdLikeFields,
	toRecordId,
	toRecordIdString,
	toRecordKeyString,
} from './id';
import { manageTable } from './table';
import type {
	SurrealCollectionConfig,
	SurrealSubset,
	SyncedTable,
} from './types';

type Cleanup = () => void;

type MutationInput<T extends { id: string | RecordId }> = Omit<T, 'id'> & {
	id?: T['id'];
};

type SurrealCollectionOptionsReturn<T extends { id: string | RecordId }> =
	CollectionConfig<
		T,
		string,
		StandardSchemaV1<MutationInput<T>, T>,
		UtilsRecord
	> & {
		schema: StandardSchemaV1<MutationInput<T>, T>;
		utils: UtilsRecord;
	};

export type { SurrealSubset } from './types';

type SyncReturn =
	| undefined
	| Cleanup
	| {
			cleanup?: Cleanup;
			unsubscribe?: Cleanup;
			dispose?: Cleanup;
			loadSubset?: unknown; // keep unknown; Only pass through
	  };

const TEMP_ID_PREFIX = '__temp__';
const NOOP: Cleanup = () => {};

const disableRefetch = <R>(value: R): R => {
	if (value && typeof value === 'object') {
		Object.assign(value as object, { refetch: false });
	}
	return value;
};

const createTempRecordId = (tableName: string): RecordId => {
	const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return new RecordId(tableName, `${TEMP_ID_PREFIX}${suffix}`);
};

const isTempId = (id: string | RecordId, tableName: string): boolean => {
	if (id instanceof RecordId) {
		const recordKey = (id as unknown as { id?: unknown }).id;
		return (
			typeof recordKey === 'string' && recordKey.startsWith(TEMP_ID_PREFIX)
		);
	}

	const raw = toRecordIdString(id);
	const key = raw.startsWith(`${tableName}:`)
		? raw.slice(tableName.length + 1)
		: raw;
	return key.startsWith(TEMP_ID_PREFIX);
};

function toCleanup(res: SyncReturn): Cleanup {
	if (!res) return NOOP;
	if (typeof res === 'function') return res;

	const cleanup = res.cleanup ?? res.unsubscribe ?? res.dispose;

	return typeof cleanup === 'function' ? cleanup : NOOP;
}

function hasLoadSubset(
	res: SyncReturn,
): res is { loadSubset: unknown } & Record<string, unknown> {
	return typeof res === 'object' && res !== null && 'loadSubset' in res;
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

				if (!data.id) data.id = createTempRecordId(tableName) as T['id'];

				return { value: data as T };
			},
			types: undefined,
		},
	};
}

export function surrealCollectionOptions<
	T extends SyncedTable<object>,
	S extends Record<string, Container> = { [k: string]: never },
>({
	id,
	useLoro = false,
	onError,
	db,
	queryClient,
	queryKey,
	syncMode = 'eager',
	...config
}: SurrealCollectionConfig<T>): CollectionConfig<
	T,
	string,
	StandardSchemaV1<MutationInput<T>, T>,
	UtilsRecord
> & {
	schema: StandardSchemaV1<MutationInput<T>, T>;
	utils: UtilsRecord;
} {
	let loro: { doc: LoroDoc<S>; key?: string } | undefined;
	if (useLoro) loro = { doc: new LoroDoc(), key: id };

	const table = manageTable<T>(db, useLoro, config.table);

	const keyOf = (rid: RecordId | string): string => toRecordKeyString(rid);

	const getKey = (row: { id: string | RecordId }) => keyOf(row.id);
	const normalizeMutationId = (rid: RecordId | string): RecordId =>
		toRecordId(config.table.name, rid);

	const loroKey = loro?.key ?? id ?? 'surreal';
	const loroMap = useLoro ? (loro?.doc?.getMap?.(loroKey) ?? null) : null;
	const commitLoro = () => {
		loro?.doc?.commit?.();
	};

	const loroPut = (row: T, commit = true) => {
		if (!loroMap) return;
		loroMap.set(getKey(row), row as unknown);
		if (commit) commitLoro();
	};

	const loroRemove = (idStr: string, commit = true) => {
		if (!loroMap) return;
		loroMap.delete(idStr);
		if (commit) commitLoro();
	};

	const mergeLocalOverServer = (serverRows: T[]): T[] => {
		if (!useLoro || !loroMap) return serverRows;

		const localJson = (loroMap.toJSON?.() ?? {}) as Record<string, T>;

		const out: T[] = [];
		for (const s of serverRows) {
			const idStr = getKey(s);
			const l = localJson[idStr];

			if (!l) {
				out.push(s);
				continue;
			}

			if ((l.sync_deleted ?? false) === true) continue;
			out.push(l);
		}

		return out;
	};

	const base = queryCollectionOptions({
		schema: createInsertSchema<T>(config.table.name),
		getKey,

		queryKey,
		queryClient,

		syncMode,

		queryFn: async ({ meta }) => {
			try {
				const subset =
					syncMode === 'on-demand'
						? (meta.surrealSubset as SurrealSubset | undefined)
						: undefined;

				const rows =
					syncMode === 'eager'
						? await table.listAll()
						: await table.loadSubset(subset);

				return mergeLocalOverServer(rows);
			} catch (e) {
				onError?.(e);
				return [];
			}
		},

		onInsert: (async (p: InsertMutationFnParams<T>) => {
			const now = new Date();

			const resultRows: T[] = [];
			let shouldCommitLoro = false;
			for (const m of p.transaction.mutations) {
				if (m.type !== 'insert') continue;

				const baseRow = { ...m.modified } as T;

				const row = useLoro
					? ({
							...baseRow,
							updated_at: now,
							sync_deleted: false,
						} as T)
					: baseRow;

				if (useLoro) {
					loroPut(row, false);
					shouldCommitLoro = true;
				}
				if (isTempId(row.id, config.table.name)) {
					const tempKey = keyOf(row.id);
					const { id: _id, ...payload } = row as Record<
						string,
						unknown
					>;
					const persisted = await table.create(payload as Partial<T>);
					const resolvedRow =
						persisted && persisted.id
							? ({ ...row, ...persisted, id: persisted.id } as T)
							: row;

					if (useLoro && persisted?.id) {
						loroRemove(tempKey, false);
						loroPut(resolvedRow, false);
					}
					resultRows.push(resolvedRow);
				} else {
					const persisted = await table.create(row);
					resultRows.push((persisted ? { ...row, ...persisted } : row) as T);
				}
			}
			if (shouldCommitLoro) commitLoro();

			return disableRefetch(
				resultRows as unknown as StandardSchema<T>,
			);
		}) as InsertMutationFn<T, string, UtilsRecord, StandardSchema<T>>,

		onUpdate: (async (p: UpdateMutationFnParams<T>) => {
			const now = new Date();

			const resultRows: T[] = [];
			let shouldCommitLoro = false;
			for (const m of p.transaction.mutations) {
				if (m.type !== 'update') continue;

				const idKey = m.key as RecordId;
				const normalizedModified = normalizeRecordIdLikeFields({
					...(m.modified as Record<string, unknown>),
				}) as Partial<T>;
				const baseRow = { ...normalizedModified, id: idKey } as T;

				const row = useLoro
					? ({ ...baseRow, updated_at: now } as T)
					: baseRow;

				if (useLoro) {
					loroPut(row, false);
					shouldCommitLoro = true;
				}

				await table.update(normalizeMutationId(idKey), row);

				resultRows.push(row);
			}
			if (shouldCommitLoro) commitLoro();

			return disableRefetch(
				resultRows as unknown as StandardSchema<T>,
			);
		}) as UpdateMutationFn<T, string, UtilsRecord, StandardSchema<T>>,

		onDelete: (async (p: DeleteMutationFnParams<T>) => {
			let shouldCommitLoro = false;
			for (const m of p.transaction.mutations) {
				if (m.type !== 'delete') continue;

				const idKey = m.key as RecordId;
				if (useLoro) {
					loroRemove(keyOf(idKey), false);
					shouldCommitLoro = true;
				}

				await table.softDelete(normalizeMutationId(idKey));
			}
			if (shouldCommitLoro) commitLoro();

			return disableRefetch([] as unknown as StandardSchema<T>);
		}) as DeleteMutationFn<T, string, UtilsRecord, StandardSchema<T>>,
	} as never) as SurrealCollectionOptionsReturn<T>;

	// LIVE updates -> invalidate all subsets under base queryKey
	const baseSync = base.sync?.sync;

	const sync = baseSync
		? {
				sync: (ctx: Parameters<NonNullable<typeof baseSync>>[0]) => {
					// IMPORTANT: call baseSync exactly once
					const baseRes = baseSync(ctx) as SyncReturn;
					const baseCleanup = toCleanup(baseRes);

					// If live queries aren't supported, return the base result untouched
					if (!db.isFeatureSupported(Features.LiveQueries)) {
						return baseRes as unknown as ReturnType<
							NonNullable<typeof baseSync>
						>;
					}

					const offLive = table.subscribe((evt) => {
						if (useLoro) {
							if (evt.type === 'delete') {
								loroRemove(getKey(evt.row));
							} else {
								loroPut(evt.row);
							}
						}

						void queryClient
							.invalidateQueries({ queryKey, exact: false })
							.catch((e) => onError?.(e));
					});

					// Preserve base return shape, just wrap cleanup
					if (hasLoadSubset(baseRes)) {
						// on-demand mode relies on this being present
						const resObj = baseRes as Record<string, unknown>;
						return {
							...resObj,
							cleanup: () => {
								offLive();
								baseCleanup();
							},
						} as unknown as ReturnType<
							NonNullable<typeof baseSync>
						>;
					}

					// eager mode usually returns a cleanup function
					return (() => {
						offLive();
						baseCleanup();
					}) as unknown as ReturnType<NonNullable<typeof baseSync>>;
				},
			}
		: undefined;

	return {
		...base,
		sync: sync ?? base.sync,
	} as SurrealCollectionOptionsReturn<T>;
}
