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
		'@tanstack/query-core',
		'@tanstack/query-db-collection',
	],
});
