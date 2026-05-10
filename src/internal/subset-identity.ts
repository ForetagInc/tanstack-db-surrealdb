import type { LoadSubsetOptions, SyncConfig } from '@tanstack/db';
import { RecordId } from 'surrealdb';
import {
	asCanonicalRecordIdString,
	preferRecordIdLikeIdentity,
	preferRecordIdLikeIdentityDeep,
	toRecordIdString,
} from '../id';
import { isPlainObject } from './records';

export const subsetCacheKey = (subset: LoadSubsetOptions): string => {
	const seen = new WeakSet<object>();
	return (
		JSON.stringify(subset, (_key, value) => {
			if (value instanceof Date) return value.toISOString();
			if (value instanceof RecordId) return toRecordIdString(value);
			if (typeof value === 'bigint') return value.toString();
			if (typeof value === 'function')
				return `[fn:${value.name || 'anonymous'}]`;

			if (value && typeof value === 'object') {
				const canonical = asCanonicalRecordIdString(value);
				if (canonical) return canonical;

				if (seen.has(value as object)) return '[Circular]';
				seen.add(value as object);
			}

			return value;
		}) ?? ''
	);
};

const normalizeSubsetValuesInPlace = (
	value: unknown,
	seen: WeakSet<object> = new WeakSet<object>(),
	preferredByCanonical: Map<string, unknown> = new Map(),
): Map<string, unknown> => {
	if (Array.isArray(value)) {
		for (const entry of value) {
			normalizeSubsetValuesInPlace(entry, seen, preferredByCanonical);
		}
		return preferredByCanonical;
	}

	if (!value || typeof value !== 'object') return preferredByCanonical;
	if (seen.has(value as object)) return preferredByCanonical;
	seen.add(value as object);
	const obj = value as Record<string, unknown>;

	if (obj.type === 'val' && 'value' in obj) {
		const canonical = asCanonicalRecordIdString(obj.value);
		if (canonical) {
			const preferred = preferRecordIdLikeIdentity(obj.value);
			obj.value = preferred;
			preferredByCanonical.set(canonical, preferred);
		} else {
			obj.value = preferRecordIdLikeIdentityDeep(obj.value);
		}
	}

	for (const child of Object.values(obj)) {
		normalizeSubsetValuesInPlace(child, seen, preferredByCanonical);
	}

	return preferredByCanonical;
};

export const primeRecordIdIdentityFromSubset = (
	subset?: LoadSubsetOptions,
): Map<string, unknown> => {
	if (!subset) return new Map();
	return normalizeSubsetValuesInPlace(subset);
};

const rebindRecordIdIdentityDeep = (
	value: unknown,
	preferredByCanonical: Map<string, unknown>,
): { value: unknown; changed: boolean } => {
	const canonical = asCanonicalRecordIdString(value);
	if (canonical && preferredByCanonical.has(canonical)) {
		const preferred = preferredByCanonical.get(canonical);
		return {
			value: preferred,
			changed: value !== preferred,
		};
	}

	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((entry) => {
			const rebound = rebindRecordIdIdentityDeep(
				entry,
				preferredByCanonical,
			);
			changed = changed || rebound.changed;
			return rebound.value;
		});
		return changed
			? { value: out, changed: true }
			: { value, changed: false };
	}

	if (!isPlainObject(value)) return { value, changed: false };

	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const rebound = rebindRecordIdIdentityDeep(entry, preferredByCanonical);
		if (rebound.changed) changed = true;
		out[key] = rebound.value;
	}
	return changed ? { value: out, changed: true } : { value, changed: false };
};

export const applyPreferredRecordIdIdentityToCollection = <
	T extends { id: string | RecordId },
>(
	ctx: Parameters<SyncConfig<T>['sync']>[0],
	preferredByCanonical: Map<string, unknown>,
): void => {
	if (!preferredByCanonical.size) return;
	const collection = ctx.collection as {
		entries?: () => Iterable<[string | number, T]>;
	};
	if (!collection || typeof collection.entries !== 'function') return;

	const rebound: T[] = [];
	for (const [, row] of collection.entries()) {
		const updated = rebindRecordIdIdentityDeep(row, preferredByCanonical);
		if (!updated.changed) continue;
		rebound.push(updated.value as T);
	}
	if (!rebound.length) return;

	ctx.begin();
	try {
		for (const row of rebound) {
			// RecordId objects can look deep-equal; delete+insert refreshes indexes.
			ctx.write({
				type: 'delete',
				value: { id: row.id } as unknown as T,
			});
			ctx.write({ type: 'insert', value: row });
		}
	} finally {
		ctx.commit();
	}
	const collectionWithInternals = collection as {
		_indexes?: {
			indexes?: Map<
				number,
				{ build?: (entries: Iterable<[string | number, T]>) => void }
			>;
		};
		_state?: {
			entries?: () => Iterable<[string | number, T]>;
		};
	};
	const entries = collectionWithInternals._state?.entries?.();
	const indexes = collectionWithInternals._indexes?.indexes;
	if (entries && indexes) {
		for (const index of indexes.values()) {
			index.build?.(entries);
		}
	}
};
