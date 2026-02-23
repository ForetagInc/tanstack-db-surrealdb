import type { LiveAction } from 'surrealdb';
import type { Bytes } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBytes<T extends string | JSON>(value: T): Bytes {
	if (typeof value === 'string') return encoder.encode(value);
	if (typeof value === 'object') return encoder.encode(JSON.stringify(value));
}

export function fromBytes<T>(bytes: Bytes, deserialize = false): T | string {
	if (deserialize) return JSON.parse(decoder.decode(bytes)) as T;
	return decoder.decode(bytes);
}

export function toBase64(bytes: Bytes): string {
	return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(base64: string): Bytes {
	const bin = atob(base64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

export function surrealActionMapType(
	action: LiveAction,
): 'insert' | 'update' | 'delete' {
	switch (action) {
		case 'CREATE':
			return 'insert';
		case 'UPDATE':
			return 'update';
		case 'DELETE':
			return 'delete';
		default:
			// KILLED handled elsewhere
			return 'update';
	}
}
