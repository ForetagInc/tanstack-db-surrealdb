export const firstRow = <T>(
	result: T | T[] | null | undefined,
): T | undefined => {
	if (!result) return undefined;
	if (Array.isArray(result)) return result[0];
	return result;
};

export const toRecordArray = <T>(rows: T | T[] | null | undefined): T[] => {
	if (!rows) return [];
	return Array.isArray(rows) ? rows : [rows];
};

export const omitUndefined = <T extends Record<string, unknown>>(
	obj: T,
): Partial<T> =>
	Object.fromEntries(
		Object.entries(obj).filter(([, value]) => value !== undefined),
	) as Partial<T>;

export const isPlainObject = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === 'object' &&
	value !== null &&
	Object.getPrototypeOf(value) === Object.prototype;

export async function queryRows<T>(
	db: {
		query: (
			sql: string,
			bindings?: Record<string, unknown>,
		) => Promise<unknown>;
	},
	sql: string,
	bindings?: Record<string, unknown>,
): Promise<T[]> {
	const result = await db.query(sql, bindings ?? {});
	if (Array.isArray(result)) {
		const first = result[0];
		if (Array.isArray(first)) return first as T[];
	}
	return [];
}
