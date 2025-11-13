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
import { RecordId } from 'surrealdb';

import { manageTable } from './table';
import type { SurrealCollectionConfig, SyncedTable } from './types';

export function surrealCollectionOptions<
	T extends SyncedTable<object>,
	S extends Record<string, Container> = { [k: string]: never },
>({
	id,
	useLoro = false,
	onError,
	db,
	...config
}: SurrealCollectionConfig<T>): CollectionConfig<
	T,
	string | number,
	never,
	UtilsRecord
> {
	let loro: { doc: LoroDoc<S>; key?: string } | undefined;
	if (useLoro) loro = { doc: new LoroDoc(), key: id };

	const keyOf = (id: RecordId | string): string =>
		typeof id === 'string' ? id : id.toString();

	const getKey = (row: { id: string | RecordId }) => keyOf(row.id);

	const loroKey = loro?.key ?? id ?? 'surreal';
	const loroMap = useLoro ? (loro?.doc?.getMap?.(loroKey) ?? null) : null;

	const loroToArray = (): T[] => {
		if (!loroMap) return [];
		const json = loroMap.toJSON?.() ?? {};
		return Object.values(json) as T[];
	};

	const loroPut = (row: T) => {
		if (!loroMap) return;
		loroMap.set(getKey(row), row as unknown);
		loro?.doc?.commit?.();
	};

	const loroRemove = (id: string) => {
		if (!loroMap) return;
		loroMap.delete(id);
		loro?.doc?.commit?.();
	};

	// ------------------------------------------------------------
	// CRDT push queue (only really used when useLoro === true)
	// ------------------------------------------------------------

	type PushOp<T> =
		| { kind: 'create'; row: T }
		| { kind: 'update'; row: T }
		| { kind: 'delete'; id: string; updated_at: Date };

	const pushQueue: PushOp<T>[] = [];

	const enqueuePush = (op: PushOp<T>) => {
		if (!useLoro) return; // no-op for non-CRDT tables
		pushQueue.push(op);
	};

	const flushPushQueue = async () => {
		if (!useLoro) return;
		const ops = pushQueue.splice(0, pushQueue.length);
		for (const op of ops) {
			if (op.kind === 'create') {
				await table.create(op.row);
			}
			if (op.kind === 'update') {
				const rid = new RecordId(
					config.table.name,
					op.row.id.toString(),
				);
				await table.update(rid, op.row);
			}
			if (op.kind === 'delete') {
				const rid = new RecordId(config.table.name, op.id.toString());
				await table.softDelete(rid);
			}
		}
	};

	const newer = (a?: Date, b?: Date) =>
		(a?.getTime() ?? -1) > (b?.getTime() ?? -1);

	// ------------------------------------------------------------
	// CRDT reconcile (only used when useLoro === true)
	// ------------------------------------------------------------

	const reconcileBoot = (
		serverRows: T[],
		write: (evt: {
			type: 'insert' | 'update' | 'delete';
			value: T;
		}) => void,
	) => {
		if (!useLoro) {
			// Should never be called when useLoro is false, but guard anyway
			diffAndEmit(serverRows, write);
			return;
		}

		const localRows = loroToArray();
		const serverById = new Map(serverRows.map((r) => [getKey(r), r]));
		const localById = new Map(localRows.map((r) => [getKey(r), r]));
		const ids = new Set([...serverById.keys(), ...localById.keys()]);
		const current: T[] = [];

		const applyLocal = (row: T | undefined) => {
			if (!row) return;
			if (row.sync_deleted) loroRemove(getKey(row));
			else loroPut(row);
		};

		for (const id of ids) {
			const s = serverById.get(id);
			const l = localById.get(id);

			if (s && l) {
				const sDeleted = s.sync_deleted ?? false;
				const lDeleted = l.sync_deleted ?? false;
				const sUpdated = s.updated_at as Date | undefined;
				const lUpdated = l.updated_at as Date | undefined;

				if (sDeleted && lDeleted) {
					// both deleted → keep tombstone, ensure local reflects deleted
					applyLocal(s);
					current.push(s);
				} else if (sDeleted && !lDeleted) {
					// server deleted, local not → server wins
					applyLocal(s);
					current.push(s);
				} else if (!sDeleted && lDeleted) {
					// local deleted, server not → compare updatedAt
					if (newer(lUpdated, sUpdated)) {
						// local wins → push tombstone
						enqueuePush({
							kind: 'delete',
							id,
							updated_at: lUpdated ?? new Date(),
						});
						applyLocal(l);
						current.push(l);
					} else {
						// server wins → restore locally
						applyLocal(s);
						current.push(s);
					}
				} else {
					// both alive → pick newer
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
				// server only
				applyLocal(s);
				current.push(s);
			} else if (!s && l) {
				// local only
				const lDeleted = l.sync_deleted ?? false;
				const lUpdated = l.updated_at as Date | undefined;

				if (lDeleted) {
					// local tombstone: push delete to server
					enqueuePush({
						kind: 'delete',
						id,
						updated_at: lUpdated ?? new Date(),
					});
					applyLocal(l);
					current.push(l);
				} else {
					// local new row: push create
					enqueuePush({ kind: 'create', row: l });
					applyLocal(l);
					current.push(l);
				}
			}
		}

		diffAndEmit(current, write);
	};

	// ------------------------------------------------------------
	// diffing snapshot
	// ------------------------------------------------------------

	let prevById = new Map<string, T>();
	const buildMap = (rows: T[]) => new Map(rows.map((r) => [getKey(r), r]));

	// Naive deep compare; CRDT fields only matter when useLoro is true
	const same = (a: SyncedTable<T>, b: SyncedTable<T>) => {
		if (useLoro) {
			const aUpdated = a.updated_at as Date | undefined;
			const bUpdated = b.updated_at as Date | undefined;
			const aDeleted = a.sync_deleted ?? false;
			const bDeleted = b.sync_deleted ?? false;

			return (
				aDeleted === bDeleted &&
				(aUpdated?.getTime() ?? 0) === (bUpdated?.getTime() ?? 0) &&
				JSON.stringify({
					...a,
					updated_at: undefined,
					sync_deleted: undefined,
				}) ===
					JSON.stringify({
						...b,
						updated_at: undefined,
						sync_deleted: undefined,
					})
			);
		}

		// Non-CRDT tables: just shallow-ish JSON compare
		return JSON.stringify(a) === JSON.stringify(b);
	};

	const diffAndEmit = (
		currentRows: T[],
		write: (arg: {
			type: 'insert' | 'update' | 'delete';
			value: T;
		}) => void,
	) => {
		const currById = buildMap(currentRows);

		// inserts & updates
		for (const [id, row] of currById) {
			const prev = prevById.get(id);
			if (!prev) {
				write({ type: 'insert', value: row });
			} else if (!same(prev, row)) {
				write({ type: 'update', value: row });
			}
		}

		// deletes
		for (const [id, prev] of prevById) {
			if (!currById.has(id)) {
				write({ type: 'delete', value: prev });
			}
		}

		prevById = currById;
	};

	const table = manageTable<T>(db, useLoro, config.table);
	const now = () => new Date();

	// ------------------------------------------------------------
	// sync
	// ------------------------------------------------------------

	const sync: SyncConfig<T, string | number>['sync'] = ({
		begin,
		write,
		commit,
		markReady,
	}) => {
		let offLive: (() => void) | null = null;

		const makeTombstone = (id: string): T =>
			({
				id: new RecordId(config.table.name, id).toString(),
				updated_at: now(),
				sync_deleted: true,
			}) as T;

		const start = async () => {
			try {
				const serverRows = await table.listAll();

				begin();

				if (useLoro) {
					reconcileBoot(serverRows, write);
				} else {
					// Non-CRDT tables: server is authoritative
					diffAndEmit(serverRows, write);
				}

				commit();
				markReady();

				// Only has work when useLoro === true
				await flushPushQueue();

				offLive = table.subscribe((evt) => {
					begin();
					try {
						if (evt.type === 'insert' || evt.type === 'update') {
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
								if (useLoro) loroPut(row);
								const had = prevById.has(getKey(row));
								write({
									type: had ? 'update' : 'insert',
									value: row,
								});
								prevById.set(getKey(row), row);
							}
						} else if (evt.type === 'delete') {
							const id = getKey(evt.row);
							if (useLoro) loroRemove(id);
							const prev = prevById.get(id) ?? makeTombstone(id);
							write({ type: 'delete', value: prev });
							prevById.delete(id);
						}
					} finally {
						commit();
					}
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

	// ------------------------------------------------------------
	// mutations
	// ------------------------------------------------------------

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
				? ({
						...base,
						updated_at: now(),
						sync_deleted: false,
					} as T)
				: base;

			if (useLoro) loroPut(row);
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
				? ({
						...base,
						updated_at: now(),
					} as T)
				: base;

			if (useLoro) loroPut(merged);
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
			if (useLoro) {
				loroRemove(keyOf(id));
				// You might also want to persist a tombstone here for CRDT tables
				// e.g. table.update(..., { sync_deleted: true, updated_at: now() })
			}
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
