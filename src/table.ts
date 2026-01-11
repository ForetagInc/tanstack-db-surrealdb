import {
	and,
	eq,
	Features,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	type Surreal,
	Table,
} from 'surrealdb';

import type {
	Field,
	IdLike,
	LivePayload,
	QueryBuilder,
	SyncMode,
	TableOptions,
} from './types';

export function manageTable<T extends { id: IdLike }>(
	db: Surreal,
	useLoro: boolean,
	{ name, ...args }: TableOptions<T>,
	syncMode: SyncMode = 'eager',
) {
	const rawFields = args.fields ?? '*';
	const fields: Field<T>[] = rawFields === '*' ? ['*'] : [...rawFields];

	const cache = new Map<string, T>();
	let fullyLoaded = false;

	const pageSize = args.pageSize ?? 100;
	const initialPageSize = args.initialPageSize ?? Math.min(50, pageSize);

	let cursor = 0;
	let progressiveTask: Promise<void> | null = null;

	const idKey = (id: IdLike) => (typeof id === 'string' ? id : id.toString());

	const upsertCache = (rows: T[]) => {
		for (const row of rows) cache.set(idKey(row.id), row);
	};

	const removeFromCache = (id: IdLike) => {
		cache.delete(idKey(id));
	};

	const listCached = () => Array.from(cache.values());

	const buildWhere = () => {
		if (!useLoro) return args.where;
		return args.where
			? and(args.where, eq('sync_deleted', false))
			: eq('sync_deleted', false);
	};

	const buildQuery = (): QueryBuilder<T> => {
		let q = db.select<T>(new Table(name)) as unknown as QueryBuilder<T>;
		const cond = buildWhere();
		if (cond) q = q.where(cond);
		return q;
	};

	const applyPaging = (
		q: QueryBuilder<T>,
		start?: number,
		limit?: number,
	) => {
		if (typeof start === 'number' && q.start) q = q.start(start);
		if (typeof limit === 'number' && q.limit) q = q.limit(limit);
		return q;
	};

	const fetchAll = async () => {
		const rows = await buildQuery().fields(...fields);
		upsertCache(rows);
		fullyLoaded = true;
		return rows;
	};

	const fetchPage = async (opts?: { start?: number; limit?: number }) => {
		const q = applyPaging(
			buildQuery(),
			opts?.start ?? 0,
			opts?.limit ?? pageSize,
		);

		const rows = await q.fields(...fields);
		upsertCache(rows);

		if (rows.length < (opts?.limit ?? pageSize)) fullyLoaded = true;

		return rows;
	};

	const fetchById = async (id: RecordId) => {
		const key = idKey(id);
		const cached = cache.get(key);
		if (cached) return cached;

		const res = await db.select<T>(id);
		const row = Array.isArray(res) ? res[0] : res;

		if (!row) return null;
		if (useLoro && (row as { sync_deleted?: boolean }).sync_deleted)
			return null;

		cache.set(key, row);
		return row;
	};

	const loadMore = async (limit = pageSize) => {
		if (fullyLoaded) return { rows: [], done: true };

		const rows = await fetchPage({ start: cursor, limit });
		cursor += rows.length;

		const done = fullyLoaded || rows.length < limit;

		args.onProgress?.({
			table: name,
			loaded: cache.size,
			lastBatch: rows.length,
			done,
		});

		return { rows, done };
	};

	const startProgressive = () => {
		if (progressiveTask || fullyLoaded) return;

		progressiveTask = (async () => {
			if (cache.size === 0) await loadMore(initialPageSize);
			while (!fullyLoaded) {
				const { done } = await loadMore(pageSize);
				if (done) break;
			}
		})().finally(() => {
			progressiveTask = null;
		});
	};

	const listAll = () => fetchAll();

	const listActive = async () => {
		if (syncMode === 'eager') return fetchAll();

		if (syncMode === 'progressive') {
			if (cache.size === 0) await loadMore(initialPageSize);
			startProgressive();
			return listCached();
		}

		return listCached();
	};

	const create = async (data: T | Partial<T>) => {
		await db.create(new Table(name)).content(data);
	};

	const update = async (id: RecordId, data: T | Partial<T>) => {
		if (!useLoro) {
			await db.update(id).merge(data);
			return;
		}

		await db.update(id).merge({
			...data,
			sync_deleted: false,
			updated_at: new Date(),
		});
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
		removeFromCache(id);
	};

	const softDelete = async (id: RecordId) => {
		if (!useLoro) {
			await db.delete(id);
			removeFromCache(id);
			return;
		}

		await db.upsert(id).merge({
			sync_deleted: true,
			updated_at: new Date(),
		});

		removeFromCache(id);
	};

	const subscribe = (
		cb: (e: { type: 'insert' | 'update' | 'delete'; row: T }) => void,
	) => {
		let killed = false;
		let live: LiveSubscription | undefined;

		const on = (msg: LiveMessage) => {
			const { action, value } = msg as unknown as LivePayload<T>;

			if (action === 'KILLED') return;

			if (action === 'CREATE') {
				upsertCache([value]);
				cb({ type: 'insert', row: value });
				return;
			}

			if (action === 'UPDATE') {
				if (
					useLoro &&
					(value as { sync_deleted?: boolean }).sync_deleted
				) {
					removeFromCache(value.id);
					cb({ type: 'delete', row: { id: value.id } as T });
					return;
				}

				upsertCache([value]);
				cb({ type: 'update', row: value });
				return;
			}

			if (action === 'DELETE') {
				removeFromCache(value.id);
				cb({ type: 'delete', row: { id: value.id } as T });
			}
		};

		const start = async () => {
			if (!db.isFeatureSupported(Features.LiveQueries)) return;
			live = await db.live(new Table(name)).where(args.where);
			live.subscribe(on);
		};

		void start();

		return () => {
			if (killed) return;
			killed = true;
			if (live) void live.kill();
		};
	};

	return {
		listAll,
		listActive,
		listCached,
		fetchPage,
		fetchById,
		loadMore,
		create,
		update,
		remove,
		softDelete,
		subscribe,
		get isFullyLoaded() {
			return fullyLoaded;
		},
		get cachedCount() {
			return cache.size;
		},
	};
}
