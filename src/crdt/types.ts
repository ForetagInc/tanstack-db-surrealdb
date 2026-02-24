import type { LoroDoc } from 'loro-crdt';
import type { LocalChange } from '../types';

export interface CRDTProfileAdapter<T extends object> {
	materialize: (doc: LoroDoc, id: string) => T;
	applyLocalChange: (doc: LoroDoc, change: LocalChange<T>) => void;
}
