import { parseOrderByExpression, parseWhereExpression } from '@tanstack/db';
import {
	Features,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	type Surreal,
	Table,
} from 'surrealdb';
import { normalizeRecordIdLikeValue, toRecordId } from './id';
import type { SurrealSubset, TableOptions } from './types';

type QueryResult<T> = T[] | null;
type RowResult<T> = T | T[] | null;
type FieldPath = Array<string | number>;
type SqlFragment = { sql: string };

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const firstRow = <T>(res: RowResult<T>): T | undefined => {
	if (!res) return undefined;
	if (Array.isArray(res)) return res[0];
	return res;
};

const toFieldPath = (value: unknown): FieldPath => {
	if (!Array.isArray(value)) {
		throw new Error('Expected a field path array in where expression.');
	}
	return value as FieldPath;
};

const quoteIdentifier = (segment: string): string => {
	if (IDENTIFIER_RE.test(segment)) return segment;
	return `\`${segment.replaceAll('`', '\\`')}\``;
};

const formatFieldPath = (path: FieldPath): string => {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			out += `[${segment}]`;
			continue;
		}
		const next = quoteIdentifier(segment);
		out = out ? `${out}.${next}` : next;
	}
	return out;
};

const isReferencePathCandidate = (value: unknown): value is FieldPath =>
	Array.isArray(value) &&
	value.length > 0 &&
	typeof value[0] === 'string' &&
	value.every(
		(segment) => typeof segment === 'string' || typeof segment === 'number',
	);

const mapRelationPath = (path: FieldPath, relation?: boolean): FieldPath => {
	if (!relation) return path;
	if (path[0] === 'from') return ['in', ...path.slice(1)];
	if (path[0] === 'to') return ['out', ...path.slice(1)];
	return path;
};

const normalizeFilterValue = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeFilterValue(item));
	}
	return normalizeRecordIdLikeValue(value);
};

const toSqlFragment = (value: unknown): SqlFragment => {
	if (
		typeof value === 'object' &&
		value !== null &&
		'sql' in value &&
		typeof (value as { sql: unknown }).sql === 'string'
	) {
		return value as SqlFragment;
	}
	throw new Error('Unsupported where expression node.');
};

const joinLogical = (op: 'AND' | 'OR', args: Array<unknown>): SqlFragment => {
	const parts = args.map(toSqlFragment).map((frag) => frag.sql);
	if (parts.length === 0) {
		return { sql: op === 'AND' ? 'true' : 'false' };
	}
	if (parts.length === 1) return { sql: parts[0] };
	return {
		sql: parts.map((part) => `(${part})`).join(` ${op} `),
	};
};

const buildSubsetQuery = (
	table: TableOptions,
	useLoro: boolean,
	subset?: SurrealSubset,
): { sql: string; params: Record<string, unknown> } => {
	let paramIdx = 0;
	const params: Record<string, unknown> = { table: table.name };
	const nextParam = (value: unknown): string => {
		const key = `p${paramIdx++}`;
		params[key] = value;
		return `$${key}`;
	};
	const comparison = (
		fieldPath: unknown,
		op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE',
		value: unknown,
	): SqlFragment => {
		const field = formatFieldPath(
			mapRelationPath(toFieldPath(fieldPath), table.relation),
		);

		if (value === undefined) {
			if (op === '=') return { sql: `${field} IS NONE` };
			if (op === '!=') return { sql: `${field} IS NOT NONE` };
			throw new Error(
				`Cannot compare field '${field}' with undefined using '${op}'.`,
			);
		}

		if (isReferencePathCandidate(value)) {
			// Subset predicates should compare against concrete values.
			throw new Error(
				'Got a field reference on the right side of a where comparison. Pass a concrete value (string/RecordId), not a reactive proxy/path.',
			);
		}
		return {
			sql: `${field} ${op} ${nextParam(normalizeFilterValue(value))}`,
		};
	};
	const whereSqlFrom = (
		expr: NonNullable<SurrealSubset['where']>,
	): string => {
		const fragment = parseWhereExpression<SqlFragment>(expr, {
			handlers: {
				and: (...args) => joinLogical('AND', args),
				or: (...args) => joinLogical('OR', args),
				not: (arg) => ({ sql: `NOT (${toSqlFragment(arg).sql})` }),
				eq: (field, value) => comparison(field, '=', value),
				gt: (field, value) => comparison(field, '>', value),
				gte: (field, value) => comparison(field, '>=', value),
				lt: (field, value) => comparison(field, '<', value),
				lte: (field, value) => comparison(field, '<=', value),
				like: (field, value) => comparison(field, 'LIKE', value),
				ilike: (field, value) => {
					const f = formatFieldPath(
						mapRelationPath(toFieldPath(field), table.relation),
					);
					const p = nextParam(normalizeFilterValue(value));
					return {
						sql: `string::lower(${f}) LIKE string::lower(${p})`,
					};
				},
				in: (field, value) => {
					const f = formatFieldPath(
						mapRelationPath(toFieldPath(field), table.relation),
					);
					if (Array.isArray(value) && value.length === 0) {
						return { sql: 'false' };
					}
					return {
						sql: `${f} IN ${nextParam(normalizeFilterValue(value))}`,
					};
				},
				isNull: (field) => ({
					sql: `${formatFieldPath(
						mapRelationPath(toFieldPath(field), table.relation),
					)} IS NULL`,
				}),
				isUndefined: (field) => ({
					sql: `${formatFieldPath(
						mapRelationPath(toFieldPath(field), table.relation),
					)} IS NONE`,
				}),
			},
			onUnknownOperator: (op) => {
				throw new Error(
					`Unsupported where operator '${op}' for SurrealQL translation.`,
				);
			},
		});

		if (!fragment) return '';
		return fragment.sql;
	};

	const whereParts: string[] = [];
	if (subset?.where) {
		const parsed = whereSqlFrom(subset.where);
		if (parsed) whereParts.push(parsed);
	}
	if (subset?.cursor?.whereFrom) {
		const cursorWhere = whereSqlFrom(subset.cursor.whereFrom);
		if (cursorWhere) whereParts.push(cursorWhere);
	}
	if (useLoro) whereParts.push('sync_deleted = false');

	const whereSql = whereParts.length
		? ` WHERE ${whereParts.map((part) => `(${part})`).join(' AND ')}`
		: '';

	const order = parseOrderByExpression(subset?.orderBy);
	const orderSql = order.length
		? ` ORDER BY ${order
				.map(
					(clause) =>
						`${formatFieldPath(
							mapRelationPath(clause.field, table.relation),
						)} ${clause.direction.toUpperCase()}`,
				)
				.join(', ')}`
		: '';
	const limitSql =
		typeof subset?.limit === 'number'
			? ` LIMIT ${nextParam(subset.limit)}`
			: '';
	const offsetSql =
		typeof subset?.offset === 'number'
			? ` START ${nextParam(subset.offset)}`
			: '';

	return {
		sql: `SELECT * FROM type::table($table)${whereSql}${orderSql}${limitSql}${offsetSql};`,
		params,
	};
};

export function manageTable<T extends { id: string | RecordId }>(
	db: Surreal,
	useLoro: boolean,
	config: TableOptions,
) {
	const { name } = config;
	const table = new Table(name);

	const listAll = async (): Promise<T[]> => {
		return loadSubset();
	};

	const loadSubset = async (subset?: SurrealSubset): Promise<T[]> => {
		const { sql, params } = buildSubsetQuery(config, useLoro, subset);
		const [res] = await db.query<[QueryResult<T>]>(sql, params);

		return res ?? [];
	};

	const create = async (data: T | Partial<T>): Promise<T | undefined> => {
		const id = (data as Partial<T> & { id?: string | RecordId }).id;
		if (!id) {
			const created = await db.create(table).content(data);
			return firstRow(created as RowResult<T>);
		}

		const payload = { ...(data as Record<string, unknown>) };
		payload.id = toRecordId(name, id);
		const inserted = await db.insert(table, payload);
		return firstRow(inserted as RowResult<T>);
	};

	const update = async (id: RecordId, data: T | Partial<T>) => {
		const { id: _ignoredId, ...rest } = data as Record<string, unknown>;
		if (!useLoro) {
			await db.update(id).merge(rest);
			return;
		}
		await db.update(id).merge({
			...rest,
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
			live = await db.live(table);
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
