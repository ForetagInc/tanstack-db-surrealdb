import { RecordId } from 'surrealdb';

export const stripOuterQuotes = (value: string): string => {
	const trimmed = value.trim();
	const isSingleQuoted =
		trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
	const isDoubleQuoted =
		trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2;
	return isSingleQuoted || isDoubleQuoted ? trimmed.slice(1, -1) : trimmed;
};

export const toRecordIdString = (rid: RecordId | string): string =>
	typeof rid === 'string'
		? stripOuterQuotes(rid)
		: stripOuterQuotes(rid.toString());

const isRecordIdString = (value: string): boolean => {
	const idx = value.indexOf(':');
	return idx > 0 && idx < value.length - 1;
};

const parseRecordIdString = (value: string): RecordId | undefined => {
	if (!isRecordIdString(value)) return undefined;

	const idx = value.indexOf(':');
	const table = value.slice(0, idx).trim();
	const key = value.slice(idx + 1).trim();
	if (!table || !key) return undefined;

	return new RecordId(table, key);
};

export const normalizeRecordIdLikeValue = (value: unknown): unknown => {
	if (value instanceof RecordId) return value;
	if (typeof value !== 'string') return value;

	const trimmed = value.trim();
	const unquoted = stripOuterQuotes(trimmed);

	const parsed =
		parseRecordIdString(unquoted) ??
		(unquoted === trimmed ? undefined : parseRecordIdString(trimmed));
	if (parsed) return parsed;

	// Keep original value shape if it isn't record-id-like
	return value;
};

export const normalizeRecordIdLikeFields = <T extends Record<string, unknown>>(
	data: T,
): T => {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) {
		out[k] = normalizeRecordIdLikeValue(v);
	}
	return out as T;
};

export const toRecordId = (
	tableName: string,
	id: RecordId | string,
): RecordId => {
	if (id instanceof RecordId) return id;

	const normalized = toRecordIdString(id);
	const prefixed = `${tableName}:`;
	const key = normalized.startsWith(prefixed)
		? normalized.slice(prefixed.length)
		: normalized;
	return new RecordId(tableName, key);
};
