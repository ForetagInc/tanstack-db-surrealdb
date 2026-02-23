import type { LoroDoc } from 'loro-crdt';
import type { Bytes } from './types';

export interface LoroDocLike {
	importUpdate(update: LoroDoc): void;
	exportUpdate(): Bytes;
	exportSnapshot(): Bytes;
}
