import type {
	CollectionConfig,
	DeleteMutationFn,
	DeleteMutationFnParams,
	InsertMutationFn,
	InsertMutationFnParams,
	StandardSchema,
	SyncConfig,
	UpdateMutationFn,
	UpdateMutationFnParams,
	UtilsRecord,
} from '@tanstack/db';
import { type Container, LoroDoc } from 'loro-crdt';
import { Features, RecordId } from 'surrealdb';

import { manageTable } from './table';
import type { SurrealCollectionConfig, SyncedTable } from './types';

const DEFAULT_INITIAL_PAGE_SIZE = 50;
const LOCAL_ID_VERIFY_CHUNK = 500;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const stableStringify = (value: unknown): string => {
	const toJson = (v: unknown): Json => {
		if (v === null) return null;
		if (
			typeof v === 'string' ||
			typeof v === 'number' ||
			typeof v === 'boolean'
		)
			return v;

		if (v instanceof Date) return v.toISOString();

		if (Array.isArray(v)) return v.map(toJson);

		if (typeof v === 'object') {
			const o = v as Record<string, unknown>;
			const keys = Object.keys(o).sort();
			const out: Record<string, Json> = {};
			for (const k of keys) out[k] = toJson(o[k]);
			return out;
		}

		return String(v);
	};

	return JSON.stringify(toJson(value));
};

const chunk = <T>(arr: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
};

export function surrealCollectionOptions<
	T extends SyncedTable<object>,
	S extends Record<string, Container> = { [k: string]: never },
>({
	id,
	useLoro = false,
	onError,
	db,
	syncMode,
	...config
}: SurrealCollectionConfig<T>): CollectionConfig<
	T,
	string | number,
	never,
	UtilsRecord
> {
	let loro: { doc: LoroDoc<S>; key?: string } | undefined;
	if (useLoro) loro = { doc: new LoroDoc(), key: id };

	const keyOf = (rid: RecordId | string): string =>
		typeof rid === 'string' ? rid : rid.toString();

	const getKey = (row: { id: string | RecordId }) => keyOf(row.id);

	const loroKey = loro?.key ?? id ?? 'surreal';
	const loroMap = useLoro ? (loro?.doc?.getMap?.(loroKey) ?? null) : null;

	const loroToArray = (): T[] => {
		if (!loroMap) return [];
		const json = loroMap.toJSON?.() ?? {};
		return Object.values(json) as T[];
	};

	const loroPutMany = (rows: T[]) => {
		if (!loroMap || rows.length === 0) return;
		for (const row of rows) loroMap.set(getKey(row), row as unknown);
		loro?.doc?.commit?.();
	};

	const loroRemoveMany = (ids: string[]) => {
		if (!loroMap || ids.length === 0) return;
		for (const id of ids) loroMap.delete(id);
		loro?.doc?.commit?.();
	};

	const loroRemove = (id: string) => loroRemoveMany([id]);

	type PushOp =
		| { kind: 'create'; row: T }
		| { kind: 'update'; row: T }
		| { kind: 'delete'; id: string; updated_at: Date };

	const pushQueue: PushOp[] = [];

	const enqueuePush = (op: PushOp) => {
		if (!useLoro) return;
		pushQueue.push(op);
	};

	const flushPushQueue = async () => {
		if (!useLoro) return;

		const ops = pushQueue.splice(0, pushQueue.length);
		for (const op of ops) {
			if (op.kind === 'create') {
				await table.create(op.row);
			} else if (op.kind === 'update') {
				const rid = new RecordId(
					config.table.name,
					op.row.id.toString(),
				);
				await table.update(rid, op.row);
			} else {
				const rid = new RecordId(config.table.name, op.id);
				await table.softDelete(rid);
			}
		}
	};

	const newer = (a?: Date, b?: Date) =>
		(a?.getTime() ?? -1) > (b?.getTime() ?? -1);

	const fetchServerByLocalIds = async (ids: string[]): Promise<T[]> => {
		if (ids.length === 0) return [];

		const tableName = config.table.name;
		const parts = chunk(ids, LOCAL_ID_VERIFY_CHUNK);
		const out: T[] = [];

		for (const p of parts) {
			const [res] = await db.query<[T[]]>(
				'SELECT * FROM type::table($table) WHERE id IN $ids',
				{
					table: tableName,
					ids: p.map((x) => new RecordId(tableName, x)),
				},
			);
			if (res) out.push(...res);
		}

		return out;
	};

	const dedupeById = (rows: T[]) => {
		const m = new Map<string, T>();
		for (const r of rows) m.set(getKey(r), r);
		return Array.from(m.values());
	};

	let prevById = new Map<string, T>();
	const buildMap = (rows: T[]) => new Map(rows.map((r) => [getKey(r), r]));

	const same = (a: SyncedTable<T>, b: SyncedTable<T>) => {
		if (useLoro) {
			return (
				(a.sync_deleted ?? false) === (b.sync_deleted ?? false) &&
				(a.updated_at?.getTime() ?? 0) ===
					(b.updated_at?.getTime() ?? 0)
			);
		}

		return stableStringify(a) === stableStringify(b);
	};

	const diffAndEmit = (
		currentRows: T[],
		write: (arg: {
			type: 'insert' | 'update' | 'delete';
			value: T;
		}) => void,
	) => {
		const currById = buildMap(currentRows);

		for (const [id, row] of currById) {
			const prev = prevById.get(id);
			if (!prev) write({ type: 'insert', value: row });
			else if (!same(prev, row)) write({ type: 'update', value: row });
		}

		for (const [id, prev] of prevById) {
			if (!currById.has(id)) write({ type: 'delete', value: prev });
		}

		prevById = currById;
	};

	const reconcileBoot = (
		serverRows: T[],
		write: (evt: {
			type: 'insert' | 'update' | 'delete';
			value: T;
		}) => void,
	) => {
		const localRows = loroToArray();
		const serverById = new Map(serverRows.map((r) => [getKey(r), r]));
		const localById = new Map(localRows.map((r) => [getKey(r), r]));
		const ids = new Set([...serverById.keys(), ...localById.keys()]);
		const current: T[] = [];

		const toRemove: string[] = [];
		const toPut: T[] = [];

		const applyLocal = (row: T | undefined) => {
			if (!row) return;
			if (row.sync_deleted) toRemove.push(getKey(row));
			else toPut.push(row);
		};

		for (const id of ids) {
			const s = serverById.get(id);
			const l = localById.get(id);

			if (s && l) {
				const sDeleted = s.sync_deleted ?? false;
				const lDeleted = l.sync_deleted ?? false;
				const sUpdated = s.updated_at;
				const lUpdated = l.updated_at;

				if (sDeleted && lDeleted) {
					applyLocal(s);
					current.push(s);
				} else if (sDeleted && !lDeleted) {
					applyLocal(s);
					current.push(s);
				} else if (!sDeleted && lDeleted) {
					if (newer(lUpdated, sUpdated)) {
						enqueuePush({
							kind: 'delete',
							id,
							updated_at: lUpdated ?? new Date(),
						});
						applyLocal(l);
						current.push(l);
					} else {
						applyLocal(s);
						current.push(s);
					}
				} else {
					if (newer(lUpdated, sUpdated)) {
						enqueuePush({ kind: 'update', row: l });
						applyLocal(l);
						current.push(l);
					} else {
						applyLocal(s);
						current.push(s);
					}
				}
			} else if (s && !l) {
				applyLocal(s);
				current.push(s);
			} else if (!s && l) {
				const lDeleted = l.sync_deleted ?? false;
				const lUpdated = l.updated_at;

				if (lDeleted) {
					enqueuePush({
						kind: 'delete',
						id,
						updated_at: lUpdated ?? new Date(),
					});
					applyLocal(l);
					current.push(l);
				} else {
					enqueuePush({ kind: 'create', row: l });
					applyLocal(l);
					current.push(l);
				}
			}
		}

		loroRemoveMany(toRemove);
		loroPutMany(toPut);

		diffAndEmit(current, write);
	};

	const table = manageTable<T>(db, useLoro, config.table, syncMode);
	const now = () => new Date();

	const sync: SyncConfig<T, string | number>['sync'] = ({
		begin,
		write,
		commit,
		markReady,
	}) => {
		if (!db.isFeatureSupported(Features.LiveQueries)) {
			markReady();
			return () => {};
		}

		let offLive: (() => void) | null = null;

		let work = Promise.resolve();
		const enqueueWork = (fn: () => void | Promise<void>) => {
			work = work.then(fn).catch((e) => onError?.(e));
			return work;
		};

		const makeTombstone = (id: string): T =>
			({
				id: new RecordId(config.table.name, id).toString(),
				updated_at: now(),
				sync_deleted: true,
			}) as T;

		const start = async () => {
			try {
				let serverRows: T[];

				if (syncMode === 'eager') {
					serverRows = await table.listAll();
				} else if (syncMode === 'progressive') {
					const first = await table.loadMore(
						config.table.initialPageSize ??
							DEFAULT_INITIAL_PAGE_SIZE,
					);
					serverRows = first.rows;
				} else {
					serverRows = await table.listActive();
				}

				await enqueueWork(async () => {
					begin();

					if (useLoro) {
						const localIds = loroToArray().map(getKey);

						const verifiedServerRows =
							syncMode === 'eager'
								? serverRows
								: dedupeById([
										...serverRows,
										...(await fetchServerByLocalIds(
											localIds,
										)),
									]);

						reconcileBoot(verifiedServerRows, write);
					} else {
						diffAndEmit(serverRows, write);
					}

					commit();
					markReady();
				});

				if (syncMode === 'progressive') {
					void (async () => {
						while (!table.isFullyLoaded) {
							const { rows } = await table.loadMore();
							if (rows.length === 0) break;

							await enqueueWork(async () => {
								begin();
								try {
									if (useLoro) loroPutMany(rows);
									diffAndEmit(rows, write);
								} finally {
									commit();
								}
							});
						}
					})().catch((e) => onError?.(e));
				}

				await flushPushQueue();

				offLive = table.subscribe((evt) => {
					void enqueueWork(async () => {
						begin();
						try {
							if (
								evt.type === 'insert' ||
								evt.type === 'update'
							) {
								const row = evt.row as T;
								const deleted = useLoro
									? (row.sync_deleted ?? false)
									: false;

								if (deleted) {
									if (useLoro) loroRemove(getKey(row));
									const prev =
										prevById.get(getKey(row)) ??
										makeTombstone(getKey(row));
									write({ type: 'delete', value: prev });
									prevById.delete(getKey(row));
								} else {
									if (useLoro) loroPutMany([row]);
									const had = prevById.has(getKey(row));
									write({
										type: had ? 'update' : 'insert',
										value: row,
									});
									prevById.set(getKey(row), row);
								}
							} else {
								const rid = getKey(evt.row);
								if (useLoro) loroRemove(rid);
								const prev =
									prevById.get(rid) ?? makeTombstone(rid);
								write({ type: 'delete', value: prev });
								prevById.delete(rid);
							}
						} finally {
							commit();
						}
					});
				});
			} catch (e) {
				onError?.(e);
				markReady();
			}
		};

		void start();

		return () => {
			if (offLive) offLive();
		};
	};

	const onInsert: InsertMutationFn<
		T,
		string,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: InsertMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];

		for (const m of p.transaction.mutations) {
			if (m.type !== 'insert') continue;

			const base = { ...m.modified } as T;

			const row = useLoro
				? ({ ...base, updated_at: now(), sync_deleted: false } as T)
				: base;

			if (useLoro) loroPutMany([row]);
			await table.create(row);
			resultRows.push(row);
		}

		return resultRows as unknown as StandardSchema<T>;
	};

	const onUpdate: UpdateMutationFn<
		T,
		string,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: UpdateMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];

		for (const m of p.transaction.mutations) {
			if (m.type !== 'update') continue;
			const id = m.key as RecordId;

			const base = { ...(m.modified as T), id } as T;

			const merged = useLoro
				? ({ ...base, updated_at: now() } as T)
				: base;

			if (useLoro) loroPutMany([merged]);
			const rid = new RecordId(config.table.name, keyOf(id));
			await table.update(rid, merged);
			resultRows.push(merged);
		}

		return resultRows as unknown as StandardSchema<T>;
	};

	const onDelete: DeleteMutationFn<
		T,
		string,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: DeleteMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];

		for (const m of p.transaction.mutations) {
			if (m.type !== 'delete') continue;
			const id = m.key as RecordId;

			if (useLoro) loroRemove(keyOf(id));
			await table.softDelete(new RecordId(config.table.name, keyOf(id)));
		}

		return resultRows as unknown as StandardSchema<T>;
	};

	return {
		id,
		getKey,
		sync: { sync },
		onInsert,
		onDelete,
		onUpdate,
	};
}
