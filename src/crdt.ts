import type { LoroDoc } from 'loro-crdt';
import type { LocalChange } from './types';
import type { CRDTProfileAdapter } from './crdt/types';

export type LoroProfile = 'json' | 'richtext';

const toRecord = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null
		? (value as Record<string, unknown>)
		: {};

export const materializeLoroJson = <T extends object>(
	doc: LoroDoc,
	id: string,
): T => {
	const root = toRecord(doc.getMap('root').toJSON());
	return {
		id,
		...root,
	} as unknown as T;
};

export const applyLoroJsonChange = <T extends object>(
	doc: LoroDoc,
	change: LocalChange<T>,
): void => {
	const root = doc.getMap('root');
	if (change.type === 'delete') {
		root.set('deleted', true);
		return;
	}
	const value = toRecord(change.value);
	for (const [key, fieldValue] of Object.entries(value)) {
		if (key === 'id') continue;
		root.set(key, fieldValue);
	}
};

export const materializeLoroRichtext = <T extends object>(
	doc: LoroDoc,
	id: string,
): T => {
	const metadata = toRecord(doc.getMap('root').toJSON());
	const content = doc.getText('content').toString();
	return {
		id,
		content,
		...metadata,
	} as unknown as T;
};

export const applyLoroRichtextChange = <T extends object>(
	doc: LoroDoc,
	change: LocalChange<T>,
): void => {
	const text = doc.getText('content');
	const metadata = doc.getMap('root');
	if (change.type === 'delete') {
		metadata.set('deleted', true);
		return;
	}
	const value = toRecord(change.value);
	for (const [key, fieldValue] of Object.entries(value)) {
		if (key === 'id') continue;
		if (key === 'content') {
			if (typeof fieldValue === 'string') text.update(fieldValue);
			continue;
		}
		metadata.set(key, fieldValue);
	}
};

export const createLoroProfile = <T extends object = Record<string, unknown>>(
	profile: LoroProfile,
): CRDTProfileAdapter<T> => {
	if (profile === 'richtext') {
		return {
			materialize: materializeLoroRichtext as CRDTProfileAdapter<T>['materialize'],
			applyLocalChange:
				applyLoroRichtextChange as CRDTProfileAdapter<T>['applyLocalChange'],
		};
	}

	return {
		materialize: materializeLoroJson as CRDTProfileAdapter<T>['materialize'],
		applyLocalChange:
			applyLoroJsonChange as CRDTProfileAdapter<T>['applyLocalChange'],
	};
};
