import { surrealCollectionOptions, type SurrealSubset } from '../dist';

import { eq, Surreal } from 'surrealdb';

import { createCollection } from '@tanstack/db';
// import { QueryClient } from '@tanstack/query-core'; // can also be '@tanstack/react-query' or '@tanstack/svelte-query'
import { useLiveQuery } from '@tanstack/svelte-db';

const db = new Surreal();

type Product = {
	id: string,
	name: string,
	price: number,
	category?: string,
}

// const queryClient = new QueryClient();

// Subsets [Optional]
const subset: SurrealSubset = {
	where: eq('category', 'books'),
	orderBy: 'created_at DESC',
	limit: 25,
	offset: 50,
};

const productsCollection = createCollection<Product>(surrealCollectionOptions({
	db,
	queryKey: ['products', subset],
	// queryClient, // [Optional]
	syncMode: 'on-demand', // [Optional] 'eager' | 'on-demand' - defaults to 'eager'
	table: {
		name: 'products',
		fields: ['name', 'price'], // [Optional] Defaults to SELECT *
	},
}));

const products = useLiveQuery((query) => query.from({ products: productsCollection }));

productsCollection.insert({
	id: 'product:1',
	name: 'test',
	price: 100,
});
