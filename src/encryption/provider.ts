import type { Bytes, EncryptedEnvelope } from '../types';

export type EncryptInput = {
	plaintext: Bytes;
	aad?: Bytes;
	v?: number;
	alg?: string;
	kid?: string;
};

export type DecryptInput = {
	envelope: EncryptedEnvelope;
	aad?: Bytes;
};

export interface CryptoProvider {
	encrypt(input: EncryptInput): Promise<EncryptedEnvelope>;
	decrypt(input: DecryptInput): Promise<Bytes>;
}
