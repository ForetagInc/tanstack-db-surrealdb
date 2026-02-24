import type {
	AADContext,
	Bytes,
	EncryptedEnvelope,
	SurrealE2EEOptions,
} from '../types';
import type { CryptoProvider } from './provider';

/**
 * @deprecated Use SurrealE2EEOptions from ../types.
 */
export interface E2EEConfig<TItem extends object> {
	enabled: boolean;
	serialize?: (item: TItem) => Bytes;
	deserialize?: (bytes: Bytes) => TItem;
	crypto: CryptoProvider;
	fields?: {
		ciphertext: string;
		nonce: string;
		version: string;
	};
	aad?: (ctx: { table: string; id: string }) => Bytes;
}

export type EncryptionEnvelope = EncryptedEnvelope;
export type EncryptionAADContext = AADContext;
export type AdapterE2EEOptions = SurrealE2EEOptions;
