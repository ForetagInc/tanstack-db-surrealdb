import { RecordId } from 'surrealdb';

const recordIdInternPool = new Map<string, RecordId>();

const internRecordId = (canonical: string): RecordId => {
	const cached = recordIdInternPool.get(canonical);
	if (cached) return cached;
	const created = canonicalToNativeRecordId(canonical);
	recordIdInternPool.set(canonical, created);
	return created;
};

const canonicalToNativeRecordId = (canonical: string): RecordId => {
	const idx = canonical.indexOf(':');
	const table = canonical.slice(0, idx);
	const key = canonical.slice(idx + 1);
	return new RecordId(table, key);
};

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
	const key = stripOuterQuotes(
		stripAngleBrackets(stripOuterQuotes(trimmed.slice(idx + 1).trim())),
	);
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
	return stripOuterQuotes(rawKey.trim());
};

const isRecordIdString = (value: string): boolean => {
	const idx = value.indexOf(':');
	return idx > 0 && idx < value.length - 1;
};

const looksLikeTableName = (value: string): boolean =>
	/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value);

const toCanonicalRecordIdString = (value: string): string | undefined => {
	const normalized = toRecordIdString(value);
	if (!isRecordIdString(normalized)) return undefined;

	const idx = normalized.indexOf(':');
	const table = stripOuterQuotes(normalized.slice(0, idx).trim());
	const key = normalized.slice(idx + 1).trim();
	if (!table || !key || !looksLikeTableName(table)) return undefined;
	return `${table}:${key}`;
};

const unwrapIdWrapper = (value: unknown): unknown => {
	if (!value || typeof value !== 'object') return undefined;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length !== 1 || keys[0] !== 'id') return undefined;
	return obj.id;
};

export const asCanonicalRecordIdString = (
	value: unknown,
): string | undefined => {
	if (typeof value === 'string') {
		return toCanonicalRecordIdString(value);
	}
	if (value instanceof RecordId) {
		return toCanonicalRecordIdString(value.toString());
	}
	const wrappedId = unwrapIdWrapper(value);
	if (wrappedId === undefined || wrappedId === value) return undefined;
	return asCanonicalRecordIdString(wrappedId);
};

export const toNativeRecordIdLikeValue = (value: unknown): unknown => {
	if (value instanceof RecordId) {
		const canonical = asCanonicalRecordIdString(value);
		if (!canonical) return value;
		return internRecordId(canonical);
	}
	const canonical = asCanonicalRecordIdString(value);
	if (!canonical) return value;
	return internRecordId(canonical);
};

export const preferRecordIdLikeIdentity = (value: unknown): unknown => {
	const canonical = asCanonicalRecordIdString(value);
	if (!canonical) return normalizeRecordIdLikeValue(value);

	if (value instanceof RecordId) {
		recordIdInternPool.set(canonical, value);
		return value;
	}

	const wrappedId = unwrapIdWrapper(value);
	if (wrappedId instanceof RecordId) {
		recordIdInternPool.set(canonical, wrappedId);
		return wrappedId;
	}

	return internRecordId(canonical);
};

export const preferRecordIdLikeIdentityDeep = <T>(value: T): T => {
	const preferred = preferRecordIdLikeIdentity(value);

	if (Array.isArray(preferred)) {
		return preferred.map((item) =>
			preferRecordIdLikeIdentityDeep(item),
		) as T;
	}

	if (isPlainObject(preferred)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(preferred)) {
			out[k] = preferRecordIdLikeIdentityDeep(v);
		}
		return out as T;
	}

	return preferred as T;
};

export const normalizeRecordIdLikeValue = (value: unknown): unknown => {
	if (value instanceof RecordId) return toNativeRecordIdLikeValue(value);
	if (typeof value === 'object' && value !== null)
		return toNativeRecordIdLikeValue(value);
	if (typeof value !== 'string') return value;

	const trimmed = value.trim();
	const unquoted = stripOuterQuotes(trimmed);
	const canonical =
		toCanonicalRecordIdString(unquoted) ??
		(unquoted === trimmed ? undefined : toCanonicalRecordIdString(trimmed));
	if (canonical) {
		return internRecordId(canonical);
	}

	// Keep original value shape if it isn't record-id-like
	return value;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	Object.getPrototypeOf(value) === Object.prototype;

export const normalizeRecordIdLikeValueDeep = <T>(value: T): T => {
	const normalized = normalizeRecordIdLikeValue(value);

	if (Array.isArray(normalized)) {
		return normalized.map((item) =>
			normalizeRecordIdLikeValueDeep(item),
		) as T;
	}

	if (isPlainObject(normalized)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(normalized)) {
			out[k] = normalizeRecordIdLikeValueDeep(v);
		}
		return out as T;
	}

	return normalized as T;
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
	if (id instanceof RecordId) {
		return id;
	}

	const normalized = toRecordIdString(id);
	const prefixed = `${tableName}:`;
	const key = normalized.startsWith(prefixed)
		? normalized.slice(prefixed.length)
		: normalized;
	return new RecordId(tableName, key);
};
