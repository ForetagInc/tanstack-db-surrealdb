import type { Bytes } from '../types';

export interface CryptoProvider {
	encrypt(
		plaintext: Bytes,
		aad?: Bytes,
	): Promise<{ ciphertext: Bytes; nonce: Bytes; version: number }>;

	decrypt(
		payload: {
			ciphertext: Bytes;
			nonce: Bytes;
			version: number;
		},
		aad?: Bytes,
	): Promise<Bytes>;
}
