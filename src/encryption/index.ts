import { fromBase64, toBase64 } from '../util';
import type { Bytes, EncryptedEnvelope } from '../types';
import type { CryptoProvider, DecryptInput, EncryptInput } from './provider';

export * from './provider';
export * from './types';

type KeyResolver = (kid: string) => Promise<CryptoKey> | CryptoKey;

type WebCryptoAESGCMOptions = {
	alg?: string;
	version?: number;
	kid?: string;
	resolveKey?: KeyResolver;
};

const DEFAULT_ALG = 'AES-256-GCM';
const DEFAULT_KID = 'default';
const DEFAULT_VERSION = 1;

const resolveCrypto = (): Crypto => {
	if (typeof globalThis.crypto !== 'undefined') return globalThis.crypto;
	throw new Error('Web Crypto API is not available in this runtime.');
};

const toCryptoBytes = (value: Bytes): Uint8Array => new Uint8Array(value);

export class WebCryptoAESGCM implements CryptoProvider {
	private readonly alg: string;
	private readonly version: number;
	private readonly kid: string;
	private readonly resolveKey: KeyResolver;

	constructor(key: CryptoKey, options: WebCryptoAESGCMOptions = {}) {
		this.alg = options.alg ?? DEFAULT_ALG;
		this.version = options.version ?? DEFAULT_VERSION;
		this.kid = options.kid ?? DEFAULT_KID;
		this.resolveKey =
			options.resolveKey ??
			((incomingKid) => {
				if (incomingKid !== this.kid) {
					throw new Error(`No key configured for kid '${incomingKid}'.`);
				}
				return key;
			});
	}

	static async fromRawKey(
		rawKey: Bytes,
		options: Omit<WebCryptoAESGCMOptions, 'resolveKey'> = {},
	) {
		const key = await resolveCrypto().subtle.importKey(
			'raw',
			toCryptoBytes(rawKey) as never,
			'AES-GCM',
			false,
			['encrypt', 'decrypt'],
		);

		return new WebCryptoAESGCM(key, options);
	}

	private async keyFor(kid: string): Promise<CryptoKey> {
		return await this.resolveKey(kid);
	}

	async encrypt(input: EncryptInput): Promise<EncryptedEnvelope> {
		const crypto = resolveCrypto();
		const alg = input.alg ?? this.alg;
		const kid = input.kid ?? this.kid;
		const v = input.v ?? this.version;
		const nonce = crypto.getRandomValues(new Uint8Array(12));
		const key = await this.keyFor(kid);
		const ct = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv: nonce,
					additionalData: input.aad
						? (toCryptoBytes(input.aad) as never)
						: undefined,
				},
				key,
				toCryptoBytes(input.plaintext) as never,
			),
		);

		return {
			v,
			alg,
			kid,
			n: toBase64(nonce),
			ct: toBase64(ct),
		};
	}

	async decrypt({ envelope, aad }: DecryptInput): Promise<Bytes> {
		if (envelope.alg !== this.alg) {
			throw new Error(
				`Unsupported envelope algorithm '${envelope.alg}'. Expected '${this.alg}'.`,
			);
		}

		const key = await this.keyFor(envelope.kid);
		const crypto = resolveCrypto();
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: toCryptoBytes(fromBase64(envelope.n)) as never,
				additionalData: aad ? (toCryptoBytes(aad) as never) : undefined,
			},
			key,
			toCryptoBytes(fromBase64(envelope.ct)) as never,
		);

		return new Uint8Array(plaintext);
	}
}
