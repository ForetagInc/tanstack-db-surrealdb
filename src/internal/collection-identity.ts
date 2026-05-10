import type { OperationConfig, Transaction } from '@tanstack/db';
import { hashKey } from '@tanstack/query-core';
import { asCanonicalRecordIdString } from '../id';

const SURREAL_COLLECTION_ID_PREFIX = 'surreal';

type DeletePatchableCollection = {
	state: Map<unknown, unknown>;
	delete: (
		keys: unknown[] | unknown,
		config?: OperationConfig,
	) => Transaction<Record<string, never>>;
};

const patchedCollections = new WeakSet<object>();

const normalizeDeleteKeyAgainstState = (
	state: Map<unknown, unknown>,
	key: unknown,
): unknown => {
	if (state.has(key)) return key;
	const canonical = asCanonicalRecordIdString(key);
	if (!canonical) return key;
	return state.has(canonical) ? canonical : key;
};

export const patchCollectionDeleteForRecordIds = (
	collection: unknown,
): void => {
	if (!collection || typeof collection !== 'object') return;
	if (patchedCollections.has(collection)) return;
	const candidate = collection as Partial<DeletePatchableCollection>;
	if (typeof candidate.delete !== 'function') return;
	const originalDelete = candidate.delete.bind(collection);
	Object.defineProperty(collection, 'delete', {
		configurable: true,
		writable: true,
		value: (
			keys: unknown[] | unknown,
			config?: OperationConfig,
		): Transaction<Record<string, never>> => {
			const state =
				(collection as DeletePatchableCollection).state ??
				new Map<unknown, unknown>();
			const normalizedKeys = Array.isArray(keys)
				? keys.map((key) => normalizeDeleteKeyAgainstState(state, key))
				: normalizeDeleteKeyAgainstState(state, keys);
			return originalDelete(normalizedKeys, config);
		},
	});
	patchedCollections.add(collection);
};

export const deriveCollectionId = (
	tableName: string,
	queryKey: readonly unknown[],
): string =>
	`${SURREAL_COLLECTION_ID_PREFIX}:${tableName}:${hashKey(queryKey)}`;
