import type { AADContext, EncryptedEnvelope } from '../types';
import { toBytes } from '../util';

const ENVELOPE_FIELDS = [
	'version',
	'algorithm',
	'key_id',
	'nonce',
	'ciphertext',
] as const;

export function defaultAad(ctx: AADContext): Uint8Array {
	if (ctx.kind === 'base') return toBytes(`${ctx.table}:${ctx.id}`);
	const base = ctx.baseTable ?? ctx.table;
	return toBytes(`${ctx.table}:${base}:${ctx.id}`);
}

export const toEnvelope = (
	value: Record<string, unknown>,
): EncryptedEnvelope | null => {
	const version = value.version;
	const algorithm = value.algorithm;
	const keyId = value.key_id;
	const nonce = value.nonce;
	const ciphertext = value.ciphertext;
	if (
		typeof version !== 'number' ||
		typeof algorithm !== 'string' ||
		typeof keyId !== 'string' ||
		typeof nonce !== 'string' ||
		typeof ciphertext !== 'string'
	) {
		return null;
	}
	return {
		v: version,
		alg: algorithm,
		kid: keyId,
		n: nonce,
		ct: ciphertext,
	};
};

export const toStoredEnvelope = (
	envelope: EncryptedEnvelope,
): Record<string, unknown> => ({
	version: envelope.v,
	algorithm: envelope.alg,
	key_id: envelope.kid,
	nonce: envelope.n,
	ciphertext: envelope.ct,
});

export const stripEnvelopeFields = (
	value: Record<string, unknown>,
): Record<string, unknown> => {
	const copy = { ...value };
	for (const key of ENVELOPE_FIELDS) delete copy[key];
	return copy;
};
