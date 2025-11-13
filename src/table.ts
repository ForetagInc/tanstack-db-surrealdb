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
import type { TableOptions } from './types';

export function manageTable<T extends { id: string | RecordId }>(
	db: Surreal,
	useLoro: boolean,
	{ name, ...args }: TableOptions<T>,
) {
	const fields = args.fields ?? '*';

	const listAll = async (): Promise<T[]> => {
		return (await db
			.select<T>(new Table(name))
			.where(args.where)
			.fields(...fields)) as T[];
	};

	const listActive = async (): Promise<T[]> => {
		if (!useLoro) return listAll();

		return (await db
			.select<T>(new Table(name))
			.where(and(args.where, eq('sync_deleted', false)))
			.fields(...fields)) as T[];
	};

	const create = async (data: T | Partial<T>) => {
		await db.create(new Table(name)).content(data);
	};

	const update = async (id: RecordId, data: T | Partial<T>) => {
		if (useLoro) {
			await db.update(id).merge({
				...data,
				sync_deleted: false,
				updated_at: Date.now(),
			});
		} else {
			await db.update(id).merge({
				...data,
			});
		}
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
	};

	const softDelete = async (id: RecordId) => {
		if (useLoro) {
			// CRDT tombstone
			await db.update(id).merge({
				sync_deleted: true,
				updated_at: Date.now(),
			});
		} else {
			// Non-CRDT: just hard delete
			await db.delete(id);
		}
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
			const isLiveSupported = db.isFeatureSupported(Features.LiveQueries);

			if (isLiveSupported) {
				live = await db.live(new Table(name)).where(args.where);
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
		create,
		update,
		remove,
		softDelete,
		subscribe,
	};
}
