import { describe, expect, it } from 'bun:test';
import { RecordId } from 'surrealdb';
import { serializeSurrealSubsetOptions } from '../src/queryKey';

const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
const val = (value: unknown) => ({ type: 'val', value }) as const;
const eqExpr = (field: string, value: unknown) =>
	({ type: 'func', name: 'eq', args: [ref(field), val(value)] }) as const;

describe('serializeSurrealSubsetOptions', () => {
	it('distinguishes different RecordId values', () => {
		const a = serializeSurrealSubsetOptions({
			where: eqExpr('owner', new RecordId('account', 'a')) as never,
		});
		const b = serializeSurrealSubsetOptions({
			where: eqExpr('owner', new RecordId('account', 'b')) as never,
		});

		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it('normalizes string and RecordId values to the same key', () => {
		const fromString = serializeSurrealSubsetOptions({
			where: eqExpr('owner', 'account:a') as never,
		});
		const fromRecordId = serializeSurrealSubsetOptions({
			where: eqExpr('owner', new RecordId('account', 'a')) as never,
		});

		expect(fromString).toBe(fromRecordId);
	});

});
