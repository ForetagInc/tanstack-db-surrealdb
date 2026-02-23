import type { Bytes } from '../types';
import type { CryptoProvider } from './provider';

export interface E2EEConfig<TItem extends object> {
	enabled: boolean;

	serialize?: (item: TItem) => Bytes;
	deserialize?: (bytes: Bytes) => TItem;

	crypto: CryptoProvider;

	/**
	 * Field names in Surreal Record used to store encrypted payload.
	 */
	fields?: {
		ciphertext: string;
		nonce: string;
		version: string;
	};

	/**
	 * Additional authenticated data to be included in the encryption process.
	 */
	aad?: (ctx: { table: string; id: string }) => Bytes;
}
