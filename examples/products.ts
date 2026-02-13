import { surrealCollectionOptions } from '../dist';

import { RecordId, Surreal, eq, or } from 'surrealdb';

import { createCollection } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/svelte-db';
import { QueryClient } from '@tanstack/svelte-query';

const db = new Surreal();
const queryClient = new QueryClient();

type Product = {
	id: RecordId<'product'>,
	name: string,
	price: number
}

const productsCollection = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products'],
		queryClient,
		table: {
			name: 'products',
			fields: ['name', 'price'], // Optional, or Default to SELECT *
		}
	})
);

const productsCollectionFilter = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products', 'filter'],
		queryClient,
		table: {
			name: 'products',
			fields: ['name', 'price'], // Optional, or Default to SELECT *
			where: eq('price', 100)
		}
	})
);


const productsCollectionAdvancedFilter = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products', 'advancedFilter'],
		queryClient,
		table: {
			name: 'products',
			fields: ['name', 'price'], // Optional, or Default to SELECT *
			where: or(
				eq('price', 100),
				eq('price', 200)
			)
		}
	})
);

const products = useLiveQuery((query) => query.from({ products: productsCollection }));

productsCollection.insert({
	// id field is optional
	name: 'test',
	price: 100,
});
