import { surrealCollectionOptions } from '../dist';

import { Surreal } from 'surrealdb';

import { createCollection } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/svelte-db';

const db = new Surreal();

type Product = {
	id: string,
	name: string,
	price: number
}

const productsWithSyncModeCollection = createCollection<Product>(surrealCollectionOptions({
	db,
	syncMode: 'on-demand', // [Optional] 'eager' | 'on-demand' | 'progressive' - defaults to 'eager'
	table: {
		name: 'products',
		fields: ['name', 'price'], // [Optional] Defaults to SELECT *
		pageSize: 50, // [Optional] Defaults to 50
		initialPageSize: 100, // [Optional] Defaults to 100
		onProgress: ({ table, loaded, lastBatch, done }) => {} // [Optional]
	}
}));

const products = useLiveQuery((query) => query.from({ products: productsWithSyncModeCollection }));

productsWithSyncModeCollection.insert({
	id: 'product:1',
	name: 'test',
	price: 100,
});
