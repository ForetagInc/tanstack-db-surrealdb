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
import type { Id, SurrealCollectionConfig, SyncedRow } from './types';

export function surrealCollectionOptions<
	T extends SyncedRow,
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

	const getKey = (row: T) => row.id;

	const loroKey = loro?.key ?? id ?? 'surreal';
	const loroMap = useLoro ? (loro?.doc?.getMap?.(loroKey) ?? null) : null;

	const loroToArray = (): T[] => {
		if (!loroMap) return [];
		const json = loroMap.toJSON?.() ?? {};
		return Object.values(json) as T[];
	};

	const loroPut = (row: T) => {
		if (!loroMap) return;
		loroMap.set(String(getKey(row)), row as unknown);
		loro?.doc?.commit?.();
	};

	const loroRemove = (id: Id) => {
		if (!loroMap) return;
		loroMap.delete(String(id));
		loro?.doc?.commit?.();
	};

	type PushOp<T> =
		| { kind: 'upsert'; row: T }
		| { kind: 'delete'; id: Id; updated_at: Date };

	const flushPushQueue = async () => {
		const ops = pushQueue.splice(0, pushQueue.length);
		for (const op of ops) {
			if (op.kind === 'upsert') {
				const rid = new RecordId(config.table.name, op.row.id);
				await table.upsert(rid, op.row);
			} else {
				const rid = new RecordId(config.table.name, op.id);
				await table.softDelete(rid);
			}
		}
	};

	const pushQueue: PushOp<T>[] = [];

	const enqueuePush = (op: PushOp<T>) => pushQueue.push(op);

	const newer = (a?: Date, b?: Date) =>
		(a?.getTime() ?? -1) > (b?.getTime() ?? -1);

	const reconcileBoot = (
		serverRows: T[],
		write: (evt: {
			type: 'insert' | 'update' | 'delete';
			value: T;
		}) => void,
	) => {
		const localRows = useLoro ? loroToArray() : [];
		const serverById = new Map<Id, T>(
			serverRows.map((r) => [getKey(r), r]),
		);
		const localById = new Map<Id, T>(localRows.map((r) => [getKey(r), r]));
		const ids = new Set<Id>([...serverById.keys(), ...localById.keys()]);
		// Results to emit + set prevById
		const current: T[] = [];

		const applyLocal = (row: T | undefined) => {
			if (!useLoro || !row) return;
			if (row.sync_deleted) loroRemove(row.id);
			else loroPut(row);
		};

		for (const id of ids) {
			const s = serverById.get(id);
			const l = localById.get(id);

			if (s && l) {
				if (s.sync_deleted && l.sync_deleted) {
					// both deleted → keep tombstone, ensure local reflects deleted
					applyLocal(s); // or l; both deleted
					current.push(s);
				} else if (s.sync_deleted && !l.sync_deleted) {
					// server deleted, local not → server wins
					applyLocal(s);
					current.push(s); // tombstone present for diff delete
				} else if (!s.sync_deleted && l.sync_deleted) {
					// local deleted, server not → compare updatedAt
					if (newer(l.updated_at, s.updated_at)) {
						// local wins → push tombstone
						enqueuePush({
							kind: 'delete',
							id,
							updated_at: l.updated_at,
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
					if (newer(l.updated_at, s.updated_at)) {
						enqueuePush({ kind: 'upsert', row: l });
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
				if (l.sync_deleted) {
					// local tombstone: push delete to server
					enqueuePush({
						kind: 'delete',
						id,
						updated_at: l.updated_at,
					});
					applyLocal(l);
					current.push(l);
				} else {
					// local new row: push upsert
					enqueuePush({ kind: 'upsert', row: l });
					applyLocal(l);
					current.push(l);
				}
			}
		}

		// Emit minimal changes vs prevById and advance snapshot
		diffAndEmit(current, write);
	};

	// local snapshot for diffing
	let prevById = new Map<Id, T>();

	const buildMap = (rows: T[]) =>
		new Map<Id, T>(rows.map((r) => [getKey(r), r]));

	// TODO: naive deep compare; swap with a faster comparator
	const same = (a: T, b: T) =>
		a.sync_deleted === b.sync_deleted &&
		a.updated_at.getTime() === b.updated_at.getTime() &&
		JSON.stringify({
			...a,
			updated_at: undefined,
			sync_deleted: undefined,
		}) ===
			JSON.stringify({
				...b,
				updated_at: undefined,
				sync_deleted: undefined,
			});

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

		// advance snapshot
		prevById = currById;
	};

	const table = manageTable<T & { id: string }>(db, config.table);

	const sync: SyncConfig<T, string | number>['sync'] = ({
		begin,
		write,
		commit,
		markReady,
	}) => {
		let offLive: (() => void) | null = null;

		const makeTombstone = (id: Id): T =>
			({ id, updated_at: new Date(), sync_deleted: true }) as T;

		const start = async () => {
			try {
				const serverRows = await table.listAll();

				begin();

				if (useLoro) reconcileBoot(serverRows, write);
				// If not using Loro, then pure server authoritative + diff
				else diffAndEmit(serverRows, write);

				commit();
				markReady();

				// Process local-wins pushes AFTER we’ve marked ready
				// TODO: throttle/batch this.
				await flushPushQueue();

				offLive = table.subscribe((evt) => {
					begin();
					try {
						if (evt.type === 'insert' || evt.type === 'update') {
							const row = evt.row as T;
							if (row.sync_deleted) {
								if (useLoro) loroRemove(row.id);
								const prev =
									prevById.get(row.id) ??
									makeTombstone(row.id);
								write({ type: 'delete', value: prev });
								prevById.delete(row.id);
							} else {
								if (useLoro) loroPut(row);
								const had = prevById.has(row.id);
								write({
									type: had ? 'update' : 'insert',
									value: row,
								});
								prevById.set(row.id, row);
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

	const now = () => new Date();

	const onInsert: InsertMutationFn<
		T,
		Id,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: InsertMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];
		for (const m of p.transaction.mutations) {
			if (m.type !== 'insert') continue;
			const row = {
				...m.modified,
				updated_at: now(),
				deleted: false,
			} as T;
			if (useLoro) loroPut(row);
			const rid = new RecordId(config.table.name, row.id);
			await table.upsert(rid, row);
			resultRows.push(row);
		}

		return resultRows as unknown as StandardSchema<T>;
	};

	const onUpdate: UpdateMutationFn<
		T,
		Id,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: UpdateMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];
		for (const m of p.transaction.mutations) {
			if (m.type !== 'update') continue;
			const id = m.key as Id;
			const merged = { ...(m.modified as T), id, updated_at: now() } as T;
			if (useLoro) loroPut(merged);
			const rid = new RecordId(config.table.name, id);
			await table.upsert(rid, merged);
			resultRows.push(merged);
		}

		return resultRows as unknown as StandardSchema<T>;
	};

	const onDelete: DeleteMutationFn<
		T,
		Id,
		UtilsRecord,
		StandardSchema<T>
	> = async (p: DeleteMutationFnParams<T>): Promise<StandardSchema<T>> => {
		const resultRows: T[] = [];
		for (const m of p.transaction.mutations) {
			if (m.type !== 'delete') continue;
			const id = m.key as Id;
			if (useLoro) loroRemove(id);
			await table.softDelete(new RecordId(config.table.name, id));
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
