import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	splitting: false,
	treeshake: true,
	external: [
		'surrealdb',
		'loro-crdt',
		'@tanstack/db',
		'@tanstack/db-sqlite-persistence-core',
		'@tanstack/query-core',
		'@tanstack/query-db-collection',
	],
});
