import { surrealCollectionOptions } from '../dist';

import { Surreal } from 'surrealdb';

import { createCollection } from '@tanstack/db';

const db = new Surreal();

type Product = {
	id: string,
	name: string,
	price: number
}

const productsCollection = createCollection<Product>(surrealCollectionOptions({
	table: {
		db,
		name: 'products',
	}
}));

productsCollection.insert({
	id: 'product:1',
	name: 'test',
	price: 100,
});
