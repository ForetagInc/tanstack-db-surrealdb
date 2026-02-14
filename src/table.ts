import {
	and,
	type ExprLike,
	eq,
	Features,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	type Surreal,
	Table,
} from 'surrealdb';
import { toRecordId } from './id';
import type {
	FieldList,
	SurrealField,
	SurrealSubset,
	TableOptions,
} from './types';

const normalizeFields = <T>(
	raw: FieldList<T> | undefined,
): ReadonlyArray<SurrealField<T>> => {
	if (!raw || raw === '*') return ['*' as SurrealField<T>];
	return raw;
};

const joinOrderBy = (
	o: string | readonly string[] | undefined,
): string | undefined => {
	if (!o) return undefined;
	return typeof o === 'string' ? o : o.join(', ');
};

type QueryResult<T> = T[] | null;

export function manageTable<T extends { id: string | RecordId }>(
	db: Surreal,
	useLoro: boolean,
	{ name, ...args }: TableOptions<T>,
) {
	const fields = normalizeFields<T>(args.fields);
	const selectFields = fields.join(', ');
	const table = new Table(name);
	const aliveWhere = useLoro ? eq('sync_deleted', false) : undefined;
	const baseWhere = aliveWhere
		? (args.where ? and(args.where, aliveWhere) : aliveWhere)
		: args.where;
	const listAllSql = `SELECT ${selectFields} FROM type::table($table)${
		baseWhere ? ' WHERE $where' : ''
	};`;

	const getBaseWhere = (): ExprLike | undefined => baseWhere;

	const listAll = async (): Promise<T[]> => {
		const where = getBaseWhere();
		const [res] = await db.query<[QueryResult<T>]>(listAllSql, {
			table: name,
			where,
		});
		return res ?? [];
	};

	const loadSubset = async (subset?: SurrealSubset): Promise<T[]> => {
		const b = getBaseWhere();
		const w = subset?.where;
		const where = b && w ? and(b, w) : (b ?? w);

		const whereSql = where ? ' WHERE $where' : '';
		const order = joinOrderBy(subset?.orderBy);
		const orderSql = order ? ` ORDER BY ${order}` : '';
		const limitSql =
			typeof subset?.limit === 'number' ? ' LIMIT $limit' : '';
		const startSql =
			typeof subset?.offset === 'number' ? ' START $offset' : '';

		const sql = `SELECT ${selectFields} FROM type::table($table)${whereSql}${orderSql}${limitSql}${startSql};`;

		const [res] = await db.query<[QueryResult<T>]>(sql, {
			table: name,
			where,
			limit: subset?.limit,
			offset: subset?.offset,
		});

		return res ?? [];
	};

	const create = async (data: T | Partial<T>) => {
		const id = (data as Partial<T> & { id?: string | RecordId }).id;
		if (!id) {
			await db.create(table).content(data);
			return;
		}

		const payload = { ...(data as Record<string, unknown>) };
		payload.id = toRecordId(name, id);
		await db.insert(table, payload);
	};

	const update = async (id: RecordId, data: T | Partial<T>) => {
		if (!useLoro) {
			await db.update(id).merge(data);
			return;
		}
		await db.update(id).merge({
			...data,
			sync_deleted: false,
			updated_at: Date.now(),
		});
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
	};

	const softDelete = async (id: RecordId) => {
		if (!useLoro) {
			await db.delete(id);
			return;
		}
		await db.upsert(id).merge({
			sync_deleted: true,
			updated_at: Date.now(),
		});
	};

	const subscribe = (
		cb: (e: { type: 'insert' | 'update' | 'delete'; row: T }) => void,
	) => {
		let killed = false;
		let live: LiveSubscription | undefined;

		const on = (msg: LiveMessage) => {
			const { action, value } = msg as unknown as {
				action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
				value: T & { id: string | RecordId };
			};

			if (action === 'KILLED') return;

			if (action === 'CREATE') cb({ type: 'insert', row: value });
			else if (action === 'UPDATE') cb({ type: 'update', row: value });
			else if (action === 'DELETE')
				cb({ type: 'delete', row: { id: value.id } as T });
		};

		const start = async () => {
			if (!db.isFeatureSupported(Features.LiveQueries)) return;
			live = await db.live(table).where(args.where);
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
		loadSubset,
		create,
		update,
		remove,
		softDelete,
		subscribe,
	};
}
