import type {
	CollectionConfig,
	DeleteMutationFnParams,
	InsertMutationFnParams,
	SyncConfig,
	UpdateMutationFnParams,
} from '@tanstack/db';
import { type Container, LoroDoc } from 'loro-crdt';
import { RecordId } from 'surrealdb';

import { manageTable } from './table';
import type { Id, SurrealCollectionConfig } from './types';

export function surrealCollectionOptions<
	T extends object = { [k: string]: never },
	S extends Record<string, Container> = { [k: string]: never },
>({
	id,
	getKey,
	useLoro = false,
	onError,
	...config
}: SurrealCollectionConfig<T>): CollectionConfig<T> {
	let loro: { doc: LoroDoc<S>; key?: string } | undefined;
	if (useLoro) loro = { doc: new LoroDoc(), key: id };

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

	// local snapshot for diffing
	let prevById = new Map<Id, T>();

	const buildMap = (rows: T[]) =>
		new Map<Id, T>(rows.map((r) => [getKey(r), r]));

	// TODO: naive deep compare; swap with a faster comparator
	const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

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
				// emit delete with the best available row shape
				write({ type: 'delete', value: prev });
			}
		}

		// advance snapshot
		prevById = currById;
	};

	const table = manageTable<T & { id: string }>(config.table);

	const sync: SyncConfig<T>['sync'] = ({
		begin,
		write,
		commit,
		markReady,
	}) => {
		let offLive: (() => void) | null = null;

		const start = async () => {
			try {
				const serverRows = await table.list();

				begin();

				if (useLoro) {
					for (const r of serverRows) loroPut(r);
					for (const r of loroToArray())
						write({ type: 'insert', value: r });

					const current = loroToArray();
					diffAndEmit(current, write);
				} else {
					for (const r of serverRows)
						write({ type: 'insert', value: r });

					diffAndEmit(serverRows, write);
				}

				commit();

				markReady();

				offLive = table.subscribe((evt) => {
					begin();
					try {
						if (evt.type === 'insert') {
							if (useLoro) loroPut(evt.row);
							write({ type: 'insert', value: evt.row });
							prevById.set(getKey(evt.row), evt.row);
						} else if (evt.type === 'update') {
							if (useLoro) loroPut(evt.row);
							write({ type: 'update', value: evt.row });
							prevById.set(getKey(evt.row), evt.row);
						} else if (evt.type === 'delete') {
							if (useLoro) loroRemove(getKey(evt.row));
							write({ type: 'delete', value: evt.row });
							prevById.delete(getKey(evt.row));
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

	const onInsert = async (p: InsertMutationFnParams<T>) => {
		for (const m of p.transaction.mutations) {
			if (m.type !== 'insert') continue;
			const row = m.modified;
			if (useLoro) loroPut(row);
			const rid = new RecordId(config.table.name, getKey(row));
			await table.upsert(rid, row);
		}
	};

	const onUpdate = async (p: UpdateMutationFnParams<T>) => {
		for (const m of p.transaction.mutations) {
			if (m.type !== 'update') continue;
			const id = m.key as Id;
			const merged = m.modified as T;
			if (useLoro) loroPut(merged);
			const recordId = new RecordId(config.table.name, id);
			await table.upsert(recordId, merged);
		}
	};

	const onDelete = async (p: DeleteMutationFnParams<T>) => {
		for (const m of p.transaction.mutations) {
			if (m.type !== 'delete') continue;
			const id = m.key as Id;
			if (useLoro) loroRemove(id);
			await table.remove(new RecordId(config.table.name, id));
		}
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
