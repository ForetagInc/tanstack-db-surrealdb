import type { Bytes } from '../types';
import type { CryptoProvider } from './provider';

export * from './provider';
export * from './types';

export class WebCryptoAESGCM implements CryptoProvider {
	constructor(private key: CryptoKey) {}

	static async fromRawKey(rawKey: Bytes) {
		const key = await crypto.subtle.importKey(
			'raw',
			rawKey,
			'AES-GCM',
			false,
			['encrypt', 'decrypt'],
		);

		return new WebCryptoAESGCM(key);
	}

	async encrypt(plaintext: Bytes, aad?: Bytes) {
		const nonce = crypto.getRandomValues(new Uint8Array(12));

		const ciphertext = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: aad },
				this.key,
				plaintext,
			),
		);

		return {
			ciphertext,
			nonce,
			version: 1,
		};
	}

	async decrypt(
		{
			ciphertext,
			nonce,
		}: {
			ciphertext: Bytes;
			nonce: Bytes;
		},
		aad?: Bytes,
	) {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: nonce,
					additionalData: aad,
				},
				this.key,
				ciphertext,
			),
		);
	}
}
