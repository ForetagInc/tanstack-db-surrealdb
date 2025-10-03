import {
	and,
	type ExprCtx,
	eq,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	Table,
	Uuid,
} from 'surrealdb';
import type { SyncedRow, TableOptions } from './types';

export function manageTable<T extends SyncedRow>({
	db,
	name,
	where,
}: TableOptions) {
	const listAll = async (): Promise<T[]> => {
		if (!where) {
			const res = (await db.select<T>(new Table(name))) ?? [];
			return Array.isArray(res) ? res : [res];
		}

		return await db.select<T>(new Table(name)).where(where);
	};

	const listActive = async (): Promise<T[]> => {
		return await db
			.select<T>(new Table(name))
			.where(and(where, eq('sync_deleted', false)));
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
			if (!where) {
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
						`LIVE SELECT * FROM ${name} WHERE ${where.toSQL(ctx)}`,
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
