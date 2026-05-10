import { Table } from 'surrealdb';
import type { TableLike, TableOptions } from '../types';

const isTableObject = (value: unknown): value is TableOptions =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	typeof (value as { name: unknown }).name === 'string';

export const toTableOptions = (table: TableLike): TableOptions => {
	if (typeof table === 'string') return { name: table };
	if (table instanceof Table) return { name: table.name };
	if (isTableObject(table)) return table;
	throw new Error('Expected table as string, Table, or { name }.');
};

export const toTableResource = (table: TableLike): Table => {
	const normalized = toTableOptions(table);
	return new Table(normalized.name);
};

export const tableNameOf = (table: TableLike): string =>
	toTableOptions(table).name;
