import { describe, expect, it } from 'bun:test';
import { DateTime, RecordId } from 'surrealdb';

import {
	asCanonicalRecordIdString,
	normalizeRecordIdLikeFields,
	normalizeRecordIdLikeValueDeep,
	normalizeRecordIdLikeValue,
	stripOuterQuotes,
	toNativeRecordIdLikeValue,
	toRecordKeyString,
	toRecordId,
	toRecordIdString,
} from '../src/id';

const cjsSurreal = require('surrealdb') as {
	RecordId: new (table: string, id: string) => unknown;
};
const CjsRecordId = cjsSurreal.RecordId;

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

	it('does not treat arbitrary objects as record ids', () => {
		const byShape = normalizeRecordIdLikeValue({
			table: 'profile',
			id: 'abc',
		});
		expect(byShape).toEqual({
			table: 'profile',
			id: 'abc',
		});

		const byString = normalizeRecordIdLikeValue({
			toString: () => 'profile:def',
		});
		expect(typeof byString).toBe('object');
		expect(byString instanceof RecordId).toBe(false);
	});

	it('normalizes cross-runtime Surreal RecordId instances (CJS/ESM)', () => {
		const cjsRid = new CjsRecordId('account', 'cross-runtime');
		expect(cjsRid instanceof RecordId).toBe(false);

		const normalized = normalizeRecordIdLikeValue(cjsRid);
		expect(normalized).toBe(cjsRid);
		expect(asCanonicalRecordIdString(normalized)).toBe('account:cross-runtime');

		const native = toNativeRecordIdLikeValue(cjsRid);
		expect(native instanceof RecordId).toBe(true);
		expect(toRecordIdString(native as RecordId)).toBe('account:cross-runtime');
	});

	it('normalizes record-id-like fields in an object', () => {
		const out = normalizeRecordIdLikeFields({
			id: 'products:1',
			name: 'desk',
		});
		expect(out.id instanceof RecordId).toBe(true);
		expect(out.name).toBe('desk');
	});

	it('interns equivalent RecordId instances to a shared reference', () => {
		const a = new RecordId('account', 'same');
		const b = new RecordId('account', 'same');
		const normalizedA = normalizeRecordIdLikeValue(a) as RecordId;
		const normalizedB = normalizeRecordIdLikeValue(b) as RecordId;
		expect(normalizedA).toBe(normalizedB);
	});

	it('deep-normalizes nested record-id-like values', () => {
		const out = normalizeRecordIdLikeValueDeep({
			owner: 'account:abc',
			meta: { reviewer: new RecordId('account', 'abc') },
		});
		const normalized = out as {
			owner: unknown;
			meta: { reviewer: unknown };
		};

		expect(normalized.owner instanceof RecordId).toBe(true);
		expect(normalized.meta.reviewer instanceof RecordId).toBe(true);
		expect(normalized.owner).toBe(normalized.meta.reviewer);
	});

	it('normalizes wrapped ids like { id: RecordId|string }', () => {
		const wrapped = {
			id: 'account:wrapped',
		};
		const out = normalizeRecordIdLikeValue(wrapped);
		expect(out instanceof RecordId).toBe(true);
		expect(String(out)).toBe('account:wrapped');

		const wrappedNative = {
			id: new RecordId('account', 'wrapped'),
		};
		const outNative = normalizeRecordIdLikeValue(wrappedNative);
		expect(outNative instanceof RecordId).toBe(true);
		expect(String(outNative)).toBe('account:wrapped');
	});

	it('preserves Date and Surreal DateTime fields while normalizing id-like fields', () => {
		const jsDate = new Date('2026-01-01T00:00:00.000Z');
		const surrealDate = new DateTime(new Date('2026-01-02T00:00:00.000Z'));
		const out = normalizeRecordIdLikeFields({
			id: 'products:1',
			start_at: jsDate,
			end_at: surrealDate,
		});

		expect(out.id instanceof RecordId).toBe(true);
		expect(out.start_at).toBe(jsDate);
		expect(out.end_at).toBe(surrealDate);
		expect(out.end_at instanceof DateTime).toBe(true);
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
		expect(toRecordIdString(new RecordId('products', '1'))).toBe('products:1');
	});

	it('normalizes record key variants to the same key part', () => {
		const key = 'e2d546ed-ff34-4b34-a313-97badfa6a86b';
		const variants = [
			`calendar_event:${key}`,
			`calendar_event:⟨${key}⟩`,
			`calendar_event:<${key}>`,
			`calendar_event:\`${key}\``,
			`'calendar_event:${key}'`,
			`"calendar_event:${key}"`,
		];

		for (const variant of variants) {
			expect(toRecordKeyString(variant)).toBe(key);
		}

		expect(toRecordKeyString(new RecordId('calendar_event', key))).toBe(key);
	});

	it('normalizes full record-id variants to canonical table:key form', () => {
		const key = 'e2d546ed-ff34-4b34-a313-97badfa6a86b';
		const variants = [
			`calendar_event:${key}`,
			`calendar_event:⟨${key}⟩`,
			`calendar_event:<${key}>`,
			`calendar_event:\`${key}\``,
			`'calendar_event:${key}'`,
			`"calendar_event:${key}"`,
		];

		for (const variant of variants) {
			expect(toRecordIdString(variant)).toBe(`calendar_event:${key}`);
		}

		expect(toRecordIdString(new RecordId('calendar_event', key))).toBe(
			`calendar_event:${key}`,
		);
	});
});
