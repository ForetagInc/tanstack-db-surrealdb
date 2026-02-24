import { surrealCollectionOptions } from '../src';

import { eq } from '@tanstack/db';
import { Surreal } from 'surrealdb';

import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/react-query'; // can also be '@tanstack/svelte-query' etc.
import { useLiveQuery } from '@tanstack/react-db';

const db = new Surreal();
const queryClient = new QueryClient();

type Product = {
	id: string;
	name: string;
	price: number;
	category?: string;
};

const productsCollection = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products'],
		queryClient,
		syncMode: 'on-demand', // [Optional] defaults to 'eager'
		table: { name: 'products' },
	}),
);

const products = useLiveQuery((query) =>
	query
		.from({ products: productsCollection })
		.where(({ products }) => eq(products.category, 'books')),
);

productsCollection.insert({
	// id field is optional
	name: 'test',
	price: 100,
});
