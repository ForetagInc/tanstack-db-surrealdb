import { surrealCollectionOptions, type SurrealSubset } from '../dist';

import { eq, Surreal } from 'surrealdb';

import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/react-query'; // can also be '@tanstack/svelte-query' etc.
import { useLiveQuery } from '@tanstack/react-db';

const db = new Surreal();
const queryClient = new QueryClient();

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

const productsCollection = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products', subset],
		queryClient,
		syncMode: 'on-demand', // [Optional] 'eager' | 'on-demand' - defaults to 'eager'
		table: {
			name: 'products',
			fields: ['name', 'price'], // [Optional] Defaults to SELECT *
		},
	})
);

const products = useLiveQuery((query) => query.from({ products: productsCollection }));

productsCollection.insert({
	// id field is optional
	name: 'test',
	price: 100,
});
