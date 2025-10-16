import {
	and,
	type ExprCtx,
	eq,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	type Surreal,
	Table,
	Uuid,
} from 'surrealdb';
import type { SyncedRow, TableOptions } from './types';

export function manageTable<T extends SyncedRow>(
	db: Surreal,
	{ name, ...args }: TableOptions<T>,
) {
	const fields = args.fields?.join(', ') ?? '*';

	const listAll = async (): Promise<T[]> => {
		return await db
			.select<T>(new Table(name))
			.where(args.where)
			.fields(fields);
	};

	const listActive = async (): Promise<T[]> => {
		return await db
			.select<T>(new Table(name))
			.where(and(args.where, eq('sync_deleted', false)))
			.fields(fields);
	};

	const upsert = async (id: RecordId, data: T | Partial<T>) => {
		await db.upsert(id).merge({
			...data,
			sync_deleted: false,
			updated_at: Date.now(),
		});
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
	};

	const softDelete = async (id: RecordId) => {
		await db.upsert(id).merge({
			sync_deleted: true,
			updated_at: Date.now(),
		});
	};

	const subscribe = (
		cb: (e: { type: 'insert' | 'update' | 'delete'; row: T }) => void,
	): (() => void) => {
		let killed = false;
		let live: undefined | LiveSubscription;

		const on = ({ action, value }: LiveMessage) => {
			if (action === 'KILLED') return;
			if (action === 'CREATE') cb({ type: 'insert', row: value as T });
			else if (action === 'UPDATE')
				cb({ type: 'update', row: value as T });
			else if (action === 'DELETE')
				cb({ type: 'delete', row: { id: value.id } as T });
		};

		const start = async () => {
			if (!args.where) {
				live = await db.live(new Table(name));
				live.subscribe(on);
			} else {
				const ctx: ExprCtx = {
					def() {
						return '';
					},
				};

				const [id] = await db
					.query(
						`LIVE SELECT * FROM ${name} WHERE ${args.where.toSQL(ctx)}`,
					)
					.collect<[string]>();
				live = await db.liveOf(new Uuid(id));
				live.subscribe(on);
			}
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
		upsert,
		remove,
		softDelete,
		subscribe,
	};
}
