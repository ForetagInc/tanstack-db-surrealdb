import { eq, type IR, or } from '@tanstack/db';
import { RecordId } from 'surrealdb';
import { normalizeRecordIdLikeValue, toRecordIdString } from './id';

type RecordIdLike = RecordId | string;

const parseRecordIdLike = (
	value: RecordIdLike,
): { table: string; id: string } => {
	const normalized = normalizeRecordIdLikeValue(value);
	if (normalized instanceof RecordId) {
		return {
			table: String(normalized.table),
			id: String(normalized.id),
		};
	}

	const str = toRecordIdString(String(normalized));
	const idx = str.indexOf(':');
	if (idx <= 0 || idx >= str.length - 1) {
		throw new Error(
			`Expected a record id in 'table:id' format, received '${String(value)}'.`,
		);
	}

	return {
		table: str.slice(0, idx),
		id: str.slice(idx + 1),
	};
};

export const eqRecordId = (
	field: unknown,
	value: RecordIdLike,
): IR.BasicExpression<boolean> => {
	const parsed = parseRecordIdLike(value);
	// biome-ignore lint/suspicious/noExplicitAny: TanStack query refs are proxy-typed at call sites.
	const fieldRef = field as any;
	const canonical = `${parsed.table}:${parsed.id}`;
	return or(eq(fieldRef, canonical), eq(fieldRef.id, parsed.id));
};
