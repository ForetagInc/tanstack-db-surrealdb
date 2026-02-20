import type { LoadSubsetOptions } from '@tanstack/db';
import { RecordId } from 'surrealdb';
import {
	asCanonicalRecordIdString,
	normalizeRecordIdLikeValue,
	toRecordIdString,
} from './id';

type BasicExpression = NonNullable<LoadSubsetOptions['where']>;

const serializeValue = (value: unknown): unknown => {
	const canonicalRecordId = asCanonicalRecordIdString(value);
	if (canonicalRecordId) {
		return {
			__type: 'recordid',
			value: canonicalRecordId,
		};
	}

	const normalized = normalizeRecordIdLikeValue(value);
	if (normalized instanceof RecordId) {
		return {
			__type: 'recordid',
			value: toRecordIdString(normalized),
		};
	}

	if (normalized === undefined) {
		return { __type: 'undefined' };
	}
	if (typeof normalized === 'number') {
		if (Number.isNaN(normalized)) return { __type: 'nan' };
		if (normalized === Number.POSITIVE_INFINITY) {
			return { __type: 'infinity', sign: 1 };
		}
		if (normalized === Number.NEGATIVE_INFINITY) {
			return { __type: 'infinity', sign: -1 };
		}
	}

	if (
		normalized === null ||
		typeof normalized === 'string' ||
		typeof normalized === 'number' ||
		typeof normalized === 'boolean'
	) {
		return normalized;
	}

	if (normalized instanceof Date) {
		return { __type: 'date', value: normalized.toJSON() };
	}

	if (Array.isArray(normalized)) {
		return normalized.map((item) => serializeValue(item));
	}

	if (typeof normalized === 'object') {
		const entries = Object.entries(
			normalized as Record<string, unknown>,
		).sort(([a], [b]) => a.localeCompare(b));
		return Object.fromEntries(
			entries.map(([key, item]) => [key, serializeValue(item)]),
		);
	}

	return normalized;
};

const serializeExpression = (expr: BasicExpression | undefined): unknown => {
	if (!expr) return null;

	switch (expr.type) {
		case 'val':
			return {
				type: 'val',
				value: serializeValue(expr.value),
			};
		case 'ref':
			return {
				type: 'ref',
				path: [...expr.path],
			};
		case 'func':
			return {
				type: 'func',
				name: expr.name,
				args: expr.args.map((arg) =>
					serializeExpression(arg as BasicExpression),
				),
			};
		default:
			return null;
	}
};

export const serializeSurrealSubsetOptions = (
	options: LoadSubsetOptions | undefined,
): string | undefined => {
	if (!options) return undefined;

	const out: Record<string, unknown> = {};
	if (options.where) out.where = serializeExpression(options.where);
	if (options.orderBy?.length) {
		out.orderBy = options.orderBy.map((clause) => ({
			expression: serializeExpression(
				clause.expression as BasicExpression,
			),
			direction: clause.compareOptions.direction,
			nulls: clause.compareOptions.nulls,
			stringSort: clause.compareOptions.stringSort,
			locale: clause.compareOptions.locale,
			localeOptions: clause.compareOptions.localeOptions,
		}));
	}
	if (options.limit !== undefined) out.limit = options.limit;
	if (options.offset !== undefined) out.offset = options.offset;

	return Object.keys(out).length ? JSON.stringify(out) : undefined;
};
