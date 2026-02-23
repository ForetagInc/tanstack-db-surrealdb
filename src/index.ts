import type { CollectionConfig, SyncConfig } from '@tanstack/db';
import type { LoroDoc } from 'loro-crdt';
import type { Surreal, Table } from 'surrealdb';

import type { E2EEConfig } from './encryption';

interface SurrealCollectionConfig<TItem extends object>
	extends Omit<
		CollectionConfig<TItem>,
		'onInsert' | 'onUpdate' | 'onDelete'
	> {
	db: Surreal;
	table: Table;
	kind?: 'edge';
	e2ee?: E2EEConfig<TItem>;
	crdt?: boolean;
}

export const surrealCollectionOptions = <TItem extends object>({
	db,
	table,
	crdt,
	kind,
	e2ee,
}: SurrealCollectionConfig<TItem>) => {
	let state: 'connected' | 'uninitialized' | 'disconnected' = 'uninitialized';

	const e2eeFields = {
		ciphertext: 'encryption',
		version: 'encryption_version',
		nonce: 'nonce',
	};

	const docs = new Map<string, LoroDoc>();

	const sync: SyncConfig<TItem>['sync'] = async ({
		begin,
		write,
		commit,
		markReady,
		collection,
	}) => {
		async function init() {
			async function hydrate() {
				const rows = await db.select(table);
				begin();
			}

			async function subscribe() {
				const connection = await db.live(table);

				if (!connection.isAlive) state = 'disconnected';
				else state = 'connected';

				connection.subscribe(async ({ action, value }) => {
					if (action === 'KILLED') {
						await connection.kill();
						state = 'disconnected';
						return;
					}

					begin();
					write({
						type: surrealActionMapType(action),
						value: value as TItem,
					});
					commit();
				});
			}
		}

		init();

		const onInsert: CollectionConfig<TItem>['onInsert'] = async ({
			transaction,
		}) => {};

		const onUpdate: CollectionConfig<TItem>['onUpdate'] = async ({
			transaction,
		}) => {};

		const onDelete: CollectionConfig<TItem>['onDelete'] = async ({
			transaction,
		}) => {};

		return () => {};
	};
};
