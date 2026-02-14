import { RecordId } from 'surrealdb';

export const stripOuterQuotes = (value: string): string => {
	const trimmed = value.trim();
	const isSingleQuoted =
		trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2;
	const isDoubleQuoted =
		trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2;
	const isBacktickQuoted =
		trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2;
	return isSingleQuoted || isDoubleQuoted || isBacktickQuoted
		? trimmed.slice(1, -1)
		: trimmed;
};

export const toRecordIdString = (rid: RecordId | string): string => {
	const raw =
		typeof rid === 'string' ? stripOuterQuotes(rid) : rid.toString();
	const trimmed = stripOuterQuotes(raw).trim();
	const idx = trimmed.indexOf(':');
	if (idx <= 0 || idx >= trimmed.length - 1) return trimmed;

	const table = trimmed.slice(0, idx).trim();
	const key = stripOuterQuotes(trimmed.slice(idx + 1).trim());
	if (!table || !key) return trimmed;
	return `${table}:${key}`;
};

const stripAngleBrackets = (value: string): string => {
	const trimmed = value.trim();
	const isSurrealAngles =
		trimmed.startsWith('⟨') && trimmed.endsWith('⟩') && trimmed.length >= 2;
	const isAsciiAngles =
		trimmed.startsWith('<') && trimmed.endsWith('>') && trimmed.length >= 2;
	return isSurrealAngles || isAsciiAngles
		? trimmed.slice(1, -1).trim()
		: trimmed;
};

export const toRecordKeyString = (rid: RecordId | string): string => {
	const normalized = toRecordIdString(rid);
	const idx = normalized.indexOf(':');
	const rawKey = idx > 0 ? normalized.slice(idx + 1) : normalized;
	return stripOuterQuotes(stripAngleBrackets(stripOuterQuotes(rawKey.trim())));
};

const isRecordIdString = (value: string): boolean => {
	const idx = value.indexOf(':');
	return idx > 0 && idx < value.length - 1;
};

const parseRecordIdString = (value: string): RecordId | undefined => {
	const normalized = toRecordIdString(value);
	if (!isRecordIdString(normalized)) return undefined;

	const idx = normalized.indexOf(':');
	const table = normalized.slice(0, idx).trim();
	const key = normalized.slice(idx + 1).trim();
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
