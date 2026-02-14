import { describe, expect, it } from 'bun:test';
import { RecordId } from 'surrealdb';

import {
	normalizeRecordIdLikeFields,
	normalizeRecordIdLikeValue,
	stripOuterQuotes,
	toRecordId,
	toRecordIdString,
} from '../src/id';

describe('id helpers', () => {
	it('strips matching single or double quotes only', () => {
		expect(stripOuterQuotes("'products:1'")).toBe('products:1');
		expect(stripOuterQuotes('"products:1"')).toBe('products:1');
		expect(stripOuterQuotes('products:1')).toBe('products:1');
	});

	it('normalizes record-id-like strings and leaves other values untouched', () => {
		const normalized = normalizeRecordIdLikeValue('products:1');
		expect(normalized instanceof RecordId).toBe(true);
		expect((normalized as RecordId).toString()).toBe('products:⟨1⟩');

		const plain = normalizeRecordIdLikeValue('hello');
		expect(plain).toBe('hello');
	});

	it('normalizes record-id-like fields in an object', () => {
		const out = normalizeRecordIdLikeFields({
			id: 'products:1',
			name: 'desk',
		});
		expect(out.id instanceof RecordId).toBe(true);
		expect(out.name).toBe('desk');
	});

	it('converts RecordId and strings into table-scoped RecordIds', () => {
		const fromPlain = toRecordId('products', '1');
		expect(fromPlain.toString()).toBe('products:⟨1⟩');

		const fromPrefixed = toRecordId('products', 'products:1');
		expect(fromPrefixed.toString()).toBe('products:⟨1⟩');

		const rid = new RecordId('products', '2');
		expect(toRecordId('products', rid)).toBe(rid);
	});

	it('normalizes RecordId|string to stable string form', () => {
		expect(toRecordIdString("'products:1'")).toBe('products:1');
		expect(toRecordIdString(new RecordId('products', '1'))).toBe(
			'products:⟨1⟩',
		);
	});
});
