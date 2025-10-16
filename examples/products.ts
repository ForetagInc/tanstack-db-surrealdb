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

const productsCollection = createCollection<Product>(surrealCollectionOptions({
	db,
	table: {
		name: 'products',
		fields: ['name' , 'price'], // Optional, or Default to SELECT *
	}
}));

const products = useLiveQuery((query) => query.from({ products: productsCollection }));

productsCollection.insert({
	id: 'product:1',
	name: 'test',
	price: 100,
});
