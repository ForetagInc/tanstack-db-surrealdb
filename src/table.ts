import {
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	Table,
	Uuid,
} from 'surrealdb';
import type { Id, TableOptions } from './types';

export function manageTable<T extends { id: Id }>({
	db,
	name,
	where,
}: TableOptions) {
	const list = async (): Promise<T[]> => {
		if (!where) {
			const response = (await db.select<T>(new Table(name))) ?? [];
			return Array.isArray(response) ? response : [response];
		}

		const [response] = await db
			.query(where.query, where.bindings)
			.collect<[T[]]>();

		return response;
	};

	const upsert = async (id: RecordId, data: T | Partial<T>) => {
		await db.upsert(id).merge(data);
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
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
			} else {
				const [id] = await db
					.query(
						`LIVE SELECT * FROM ${name} WHERE ${where.query}`,
						where.bindings,
					)
					.collect<[string]>();

				live = await db.liveOf(new Uuid(id));
			}

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
		list,
		upsert,
		remove,
		subscribe,
	};
}
