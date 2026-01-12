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

import { manageTable } from './table';
import type {
	SurrealCollectionConfig,
	SurrealSubset,
	SyncedTable,
} from './types';

type Cleanup = () => void;

export { SurrealSubset } from './types';

type SyncReturn =
	| void
	| Cleanup
	| {
			cleanup?: Cleanup;
			unsubscribe?: Cleanup;
			dispose?: Cleanup;
			loadSubset?: unknown; // keep unknown; Only pass through
	  };

function toCleanup(res: SyncReturn): Cleanup {
	if (!res) return () => {};
	if (typeof res === 'function') return res;

	const cleanup = res.cleanup ?? res.unsubscribe ?? res.dispose;

	return typeof cleanup === 'function' ? cleanup : () => {};
}

function hasLoadSubset(
	res: SyncReturn,
): res is { loadSubset: unknown } & Record<string, unknown> {
	return typeof res === 'object' && res !== null && 'loadSubset' in res;
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
	string | number,
	never,
	UtilsRecord
> {
	let loro: { doc: LoroDoc<S>; key?: string } | undefined;
	if (useLoro) loro = { doc: new LoroDoc(), key: id };

	const table = manageTable<T>(db, useLoro, config.table);

	const keyOf = (rid: RecordId | string): string =>
		typeof rid === 'string' ? rid : rid.toString();

	const getKey = (row: { id: string | RecordId }) => keyOf(row.id);

	const loroKey = loro?.key ?? id ?? 'surreal';
	const loroMap = useLoro ? (loro?.doc?.getMap?.(loroKey) ?? null) : null;

	const loroPut = (row: T) => {
		if (!loroMap) return;
		loroMap.set(getKey(row), row as unknown);
		loro?.doc?.commit?.();
	};

	const loroRemove = (idStr: string) => {
		if (!loroMap) return;
		loroMap.delete(idStr);
		loro?.doc?.commit?.();
	};

	const mergeLocalOverServer = (serverRows: T[]): T[] => {
		if (!useLoro || !loroMap) return serverRows;

		const localJson = loroMap.toJSON?.() ?? {};
		const localById = new Map<string, T>(
			Object.values(localJson).map((r) => [getKey(r as T), r as T]),
		);

		const out: T[] = [];
		for (const s of serverRows) {
			const idStr = getKey(s);
			const l = localById.get(idStr);

			if (!l) {
				out.push(s);
				continue;
			}

			if ((l.sync_deleted ?? false) === true) continue;
			out.push(l);
		}

		return out;
	};

	const base = queryCollectionOptions<T>({
		getKey: (row) => getKey(row),

		queryKey,
		queryClient,

		syncMode,

		queryFn: async ({ meta }) => {
			try {
				const subset =
					syncMode === 'on-demand'
						? (meta['surrealSubset'] as SurrealSubset | undefined)
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
			const now = () => new Date();

			const resultRows: T[] = [];
			for (const m of p.transaction.mutations) {
				if (m.type !== 'insert') continue;

				const baseRow = { ...m.modified } as T;

				const row = useLoro
					? ({
							...baseRow,
							updated_at: now(),
							sync_deleted: false,
						} as T)
					: baseRow;

				if (useLoro) loroPut(row);
				await table.create(row);
				resultRows.push(row);
			}

			return resultRows as unknown as StandardSchema<T>;
		}) as InsertMutationFn<T, string, UtilsRecord, StandardSchema<T>>,

		onUpdate: (async (p: UpdateMutationFnParams<T>) => {
			const now = () => new Date();

			const resultRows: T[] = [];
			for (const m of p.transaction.mutations) {
				if (m.type !== 'update') continue;

				const idKey = m.key as RecordId;
				const baseRow = { ...(m.modified as T), id: idKey } as T;

				const row = useLoro
					? ({ ...baseRow, updated_at: now() } as T)
					: baseRow;

				if (useLoro) loroPut(row);

				await table.update(
					new RecordId(config.table.name, keyOf(idKey)),
					row,
				);

				resultRows.push(row);
			}

			return resultRows as unknown as StandardSchema<T>;
		}) as UpdateMutationFn<T, string, UtilsRecord, StandardSchema<T>>,

		onDelete: (async (p: DeleteMutationFnParams<T>) => {
			for (const m of p.transaction.mutations) {
				if (m.type !== 'delete') continue;

				const idKey = m.key as RecordId;
				if (useLoro) loroRemove(keyOf(idKey));

				await table.softDelete(
					new RecordId(config.table.name, keyOf(idKey)),
				);
			}

			return [] as unknown as StandardSchema<T>;
		}) as DeleteMutationFn<T, string, UtilsRecord, StandardSchema<T>>,
	});

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
	};
}
