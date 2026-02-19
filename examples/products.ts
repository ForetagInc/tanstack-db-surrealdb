import { surrealCollectionOptions } from '../dist';

import { RecordId, Surreal } from 'surrealdb';

import { createCollection, eq, or } from '@tanstack/db';
import { useLiveQuery } from '@tanstack/react-db';
import { QueryClient } from '@tanstack/react-query';

const db = new Surreal();
const queryClient = new QueryClient();

type Product = {
	id: RecordId<'product'>;
	name: string;
	price: number;
};

const productsCollection = createCollection(
	surrealCollectionOptions<Product>({
		db,
		queryKey: ['products'],
		queryClient,
		table: { name: 'products' },
	}),
);

const products = useLiveQuery((query) =>
	query.from({ products: productsCollection }).select(({ products }) => ({
		id: products.id,
	})),
);

const filteredProducts = useLiveQuery((query) =>
	query
		.from({ products: productsCollection })
		.where(({ products }) =>
			or(eq(products.price, 100), eq(products.price, 200)),
		),
);

void filteredProducts;

productsCollection.insert({
	// id field is optional
	name: 'test',
	price: 100,
});
