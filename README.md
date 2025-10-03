# TanstackDB SurrealDB Collections

Add Offline / Local First Caching & Syncing to your SurrealDB app with TanstackDB and Loro (CRDTs).

- Local / Offline first applications with SurrealDB with CRDTs
- Works with Web, PWA / Desktop or Native (WASM based)
- Support for React, Svelte, Vue and any Framework!


## Installation

### NPM
```sh
# NPM
npm install @foretag/tanstack-db-surrealdb
# Bun
bun install @foretag/tanstack-db-surrealdb
```

### JSR
```sh
# NPM
npx jsr add @foretag/tanstack-db-surrealdb
# Bun
bunx jsr add @foretag/tanstack-db-surrealdb
```

## Usage
```ts
// db.ts
import { Surreal } from 'surrealdb';

export const db = new Surreal();
await db.connect('ws://localhost:8000/rpc');
await db.use({ ns: 'ns', db: 'db' });

// collections/products.ts
import { expr, eq } from 'surrealdb';
import { db } from '../db';
import { createCollection } from '@tanstack/db';
import { surrealCollectionOptions } from '@foretag/tanstack-db-surrealdb';

// Collection Type, could also be generated
type Product = {
	id: string;
	name: string;
	price: number;
};

export const products = createCollection(
	surrealCollection<Product>({
		id: 'products',
		useLoro: true, // Optional if you need CRDTs
		getKey: (collection) => collection.id,
		table: {
			db,
			name: 'products',
			where: expr(eq('store', '123'))
		},
	});
)
```

## Vite / Next.JS

### Vite
```sh
bun install vite-plugin-wasm vite-plugin-top-level-await -D
```

`vite.config.ts`

```ts
// Plugins
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [...otherConfigures, wasm(), topLevelAwait()],
});
```

### NextJS
`next.config.js`

```ts
module.exports = {
	webpack: function (config) {
		config.experiments = {
			layers: true,
			asyncWebAssembly: true,
		};
		return config;
	},
};
```

## CRDTs

If you need to use CRDTs for your application consider adding the following fields to the specific tables and set `useLoro: true` for the respective table. Please note these fields are opinionated, therefore fixed and required:

```sql
DEFINE FIELD OVERWRITE sync_deleted ON <table>
	TYPE bool
	DEFAULT false
	COMMENT 'Tombstone for CRDTs';

DEFINE FIELD OVERWRITE updated_at ON <table>
	TYPE datetime
	VALUE time::now();
```

> While using SurrealDB as a Web Database, please remember to allow `SELECT` & `UPDATE` permissions for the `sync_deleted` and `updated_at` fields for the respective access.

## FAQ

<details>
	<summary><strong>When do I need CRDTs?</strong></summary>
	<p>In most cases Tanstack DB is sufficient to handle CRUD operations. However, if you need to implement a distributed system that are offline first, CRDTs are the way to go. Think: Google Docs, Figma Pages, Notion Blocks etc.</p>
</details>

<details>
	<summary><strong>How do I achieve type safety?</strong></summary>
	<p>Using Codegen tools that generate types from your SurrealDB Schema, this means you don't have to manually maintain types for each Collection.</p>
</details>

<details>
	<summary><strong>Can I use GraphQL alongside this Library?</strong></summary>
	<p>GraphQL workflow is in the works as SurrealDB's own implementation of the GraphQL protocol matures, we'll be able to provide a seamless integration. Since this library only targets TanstackDB, you can also use GraphQL for direct querying through Tanstack Query.</p>
</details>

<details>
	<summary><strong>Can I reduce the package sizes?</strong></summary>
	<p>They can be reduced, but these steps are very unique based on use-case. Loro ships a WASM binary thats 3-4 MB in size, it's one of the tradeoffs of using this approach. The maintainers up-stream are working on reducing the size of the WASM binary.</p>
</details>
