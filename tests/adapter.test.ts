import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/query-core';
import { LoroDoc } from 'loro-crdt';
import { RecordId, Table } from 'surrealdb';

import {
	WebCryptoAESGCM,
	type CryptoProvider,
	surrealCollectionOptions,
	toRecordKeyString,
} from '../src/index';
import { toBytes } from '../src/util';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const toStoredEnvelope = (envelope: {
	v: number;
	alg: string;
	kid: string;
	n: string;
	ct: string;
}) => ({
	version: envelope.v,
	algorithm: envelope.alg,
	key_id: envelope.kid,
	nonce: envelope.n,
	ciphertext: envelope.ct,
});

type LiveCallback = (msg: {
	action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
	value: Record<string, unknown>;
}) => void | Promise<void>;

const createLiveHarness = () => {
	let callback: LiveCallback | undefined;
	let killed = 0;
	const live = {
		subscribe: (cb: LiveCallback) => {
			callback = cb;
		},
		kill: async () => {
			killed += 1;
		},
	};

	return {
		live,
		emit: async (msg: {
			action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
			value: Record<string, unknown>;
		}) => {
			await callback?.(msg);
		},
		getKilled: () => killed,
	};
};

describe('modern adapter path', () => {
	it('supports progressive mode with immediate ready and background hydration', async () => {
		const baseLive = createLiveHarness();
		const db = {
			select: async () => [{ id: new RecordId('note', '1'), title: 'n1' }],
			query: async () => [[{ id: new RecordId('note', '1'), title: 'n1' }]],
			live: async () => baseLive.live,
			isFeatureSupported: () => true,
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			update: () => ({ merge: async () => ({}) }),
			delete: async () => ({}),
			upsert: () => ({ merge: async () => ({}) }),
		};

		type Note = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Note>({
			db: db as never,
			table: { name: 'note' },
			queryClient: new QueryClient(),
			queryKey: ['note-progressive'],
			syncMode: 'progressive',
		});

		let markedReady = 0;
		const writes: Array<Record<string, unknown>> = [];
		options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => writes.push(change as Record<string, unknown>),
			commit: () => {},
			markReady: () => {
				markedReady += 1;
			},
			truncate: () => {},
		} as never);

		await flush();
		expect(markedReady).toBe(1);
		expect(writes.length).toBeGreaterThan(0);
	});

	it('hydrates and decrypts in eager mode, then applies decrypted live updates', async () => {
		const key = crypto.getRandomValues(new Uint8Array(32));
		const provider = await WebCryptoAESGCM.fromRawKey(key, { kid: 'k1' });
		const baseLive = createLiveHarness();
		const rowId = new RecordId('secret_note', '1');

		const envelope = await provider.encrypt({
			plaintext: toBytes({ title: 'Top Secret' }),
			aad: toBytes('secret_note:1'),
		});

		const db = {
			select: async () => [{ id: rowId, ...toStoredEnvelope(envelope) }],
			query: async () => [[]],
			live: async () => baseLive.live,
			isFeatureSupported: () => true,
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			update: () => ({ merge: async () => ({}) }),
			delete: async () => ({}),
			upsert: () => ({ merge: async () => ({}) }),
		};

		type Secret = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Secret>({
			db: db as never,
			table: { name: 'secret_note' },
			queryClient: new QueryClient(),
			queryKey: ['secret-note'],
			syncMode: 'eager',
			e2ee: {
				enabled: true,
				crypto: provider,
			},
		});

		const writes: Array<Record<string, unknown>> = [];
		let markedReady = 0;
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => {
				writes.push(change as Record<string, unknown>);
			},
			commit: () => {},
			markReady: () => {
				markedReady += 1;
			},
			truncate: () => {},
		} as never);

		await new Promise((resolve) => setTimeout(resolve, 15));

		expect(markedReady).toBe(1);
		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'Top Secret')).toBe(true);

		const updated = await provider.encrypt({
			plaintext: toBytes({ title: 'Updated Secret' }),
			aad: toBytes('secret_note:1'),
		});

		await baseLive.emit({
			action: 'UPDATE',
			value: { id: rowId, ...toStoredEnvelope(updated) },
		});
		await flush();

		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'Updated Secret')).toBe(true);

		if (typeof syncResult === 'function') syncResult();
		if (typeof syncResult === 'object' && syncResult?.cleanup) syncResult.cleanup();
		expect(baseLive.getKilled()).toBeGreaterThan(0);
	});

	it('loads query-driven subsets in on-demand mode and applies only active live ids', async () => {
		const baseLive = createLiveHarness();
		const db = {
			select: async () => [],
			query: async () => [[{ id: new RecordId('task', '1'), title: 'One' }]],
			live: async () => baseLive.live,
			isFeatureSupported: () => true,
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			update: () => ({ merge: async () => ({}) }),
			delete: async () => ({}),
			upsert: () => ({ merge: async () => ({}) }),
		};

		type Task = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Task>({
			db: db as never,
			table: new Table('task'),
			queryClient: new QueryClient(),
			queryKey: ['task'],
			syncMode: 'on-demand',
		});

		const writes: Array<Record<string, unknown>> = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => {
				writes.push(change as Record<string, unknown>);
			},
			commit: () => {},
			markReady: () => {},
			truncate: () => {},
		} as never);

		if (typeof syncResult === 'object' && syncResult?.loadSubset) {
			await syncResult.loadSubset({});
		}
		await flush();

		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'One')).toBe(true);

		await baseLive.emit({
			action: 'CREATE',
			value: { id: new RecordId('task', '2'), title: 'Two' },
		});
		await baseLive.emit({
			action: 'UPDATE',
			value: { id: new RecordId('task', '1'), title: 'One Updated' },
		});
		await flush();

		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'Two')).toBe(false);
		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'One Updated')).toBe(true);
	});

	it('writes encrypted CRDT updates with default update AAD and ignores self-origin live events', async () => {
		const key = crypto.getRandomValues(new Uint8Array(32));
		const baseProvider = await WebCryptoAESGCM.fromRawKey(key, { kid: 'k2' });
		const aadSeen: string[] = [];
		const decoder = new TextDecoder();
		const provider: CryptoProvider = {
			encrypt: async (input) => {
				if (input.aad) aadSeen.push(decoder.decode(input.aad));
				return baseProvider.encrypt(input);
			},
			decrypt: (input) => baseProvider.decrypt(input),
		};

		const updatesLive = createLiveHarness();
		const createdRows: Record<string, unknown>[] = [];
		const actorResolverCalls: string[] = [];
		const db = {
			select: async () => [],
			query: async (_sql: string, params: Record<string, unknown>) => {
				if (params.table === 'doc') {
					return [[{ id: new RecordId('doc', 'abc') }]];
				}
				return [[]];
			},
			live: async (table: Table) => {
				if (table.name === 'crdt_update') return updatesLive.live;
				return createLiveHarness().live;
			},
			isFeatureSupported: () => true,
			create: (table: Table) => ({
				content: async (payload: Record<string, unknown>) => {
					if (table.name === 'crdt_update') createdRows.push(payload);
					return payload;
				},
			}),
			insert: async () => ({}),
			update: () => ({ merge: async () => ({}) }),
			delete: async () => ({}),
			upsert: () => ({ merge: async () => ({}) }),
		};

		type DocRow = { id: string | RecordId; title?: string };
		const options = surrealCollectionOptions<DocRow>({
			db: db as never,
			table: { name: 'doc' },
			queryClient: new QueryClient(),
			queryKey: ['doc-modern'],
			syncMode: 'on-demand',
			e2ee: { enabled: true, crypto: provider },
			crdt: {
				enabled: true,
				profile: 'json',
				updatesTable: { name: 'crdt_update' },
				actor: ({ id }) => {
					actorResolverCalls.push(id);
					return id === 'abc' ? 'device-a' : 'device-z';
				},
			},
		});

		await options.onUpdate?.({
			transaction: {
				mutations: [
					{
						type: 'update',
						key: 'doc:abc',
						modified: { title: 'hello' },
					},
				],
			} as never,
			collection: {
				utils: {
					writeUpsert: () => {},
				},
			} as never,
		} as never);

		expect(createdRows.length).toBe(1);
		expect(
			toRecordKeyString(createdRows[0]?.doc as string | RecordId),
		).toBe('abc');
		expect(createdRows[0]?.actor).toBe('device-a');
		expect(actorResolverCalls.includes('abc')).toBe(true);
		expect(typeof createdRows[0]?.ciphertext).toBe('string');
		expect(aadSeen.some((aad) => aad === 'crdt_update:doc:abc')).toBe(true);

		const writes: Array<Record<string, unknown>> = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => writes.push(change as Record<string, unknown>),
			commit: () => {},
			markReady: () => {},
			truncate: () => {},
		} as never);
		if (typeof syncResult === 'object' && syncResult?.loadSubset) {
			await syncResult.loadSubset({});
		}
		await flush();

		const remoteDoc = new LoroDoc();
		remoteDoc.getMap('root').set('title', 'Remote');
		const remoteBytes = remoteDoc.export({ mode: 'update' });
		const remoteEnvelope = await baseProvider.encrypt({
			plaintext: remoteBytes,
			aad: toBytes('crdt_update:doc:abc'),
		});
		const remoteStoredEnvelope = toStoredEnvelope(remoteEnvelope);

		const baselineWrites = writes.length;
		await updatesLive.emit({
			action: 'CREATE',
			value: {
				doc: new RecordId('doc', 'abc'),
				actor: 'device-a',
				...remoteStoredEnvelope,
			},
		});
		const afterSelfWrites = writes.length;
		await updatesLive.emit({
			action: 'CREATE',
			value: {
				doc: new RecordId('doc', 'abc'),
				actor: 'device-b',
				...remoteStoredEnvelope,
			},
		});
		await flush();

		expect(afterSelfWrites).toBe(baselineWrites);
		expect(writes.length).toBe(baselineWrites + 1);
		expect(writes[writes.length - 1]?.type).toBe('update');
	});

	it('hydrates CRDT docs from snapshots and subsequent updates', async () => {
		const updatesLive = createLiveHarness();

		const seed = new LoroDoc();
		seed.getMap('root').set('title', 'snapshot');
		const snapshot = seed.export({ mode: 'snapshot' });
		const from = seed.oplogVersion();
		seed.getMap('root').set('title', 'updated');
		const update = seed.export({ mode: 'update', from });

		const db = {
			select: async () => [],
			query: async (sql: string, params: Record<string, unknown>) => {
				if (params.table === 'crdt_snapshot') {
					return [[{ doc: new RecordId('doc', '1'), ts: '2026-01-01T00:00:00.000Z', snapshot_bytes: Buffer.from(snapshot).toString('base64') }]];
				}
				if (params.table === 'crdt_update') {
					if (sql.includes('ts > $since')) {
						return [[{ doc: new RecordId('doc', '1'), ts: '2026-01-01T00:01:00.000Z', update_bytes: Buffer.from(update).toString('base64') }]];
					}
					return [[{ doc: new RecordId('doc', '1'), ts: '2026-01-01T00:01:00.000Z', update_bytes: Buffer.from(update).toString('base64') }]];
				}
				if (params.table === 'doc') {
					return [[{ id: new RecordId('doc', '1') }]];
				}
				return [[]];
			},
			live: async () => updatesLive.live,
			isFeatureSupported: () => true,
			create: () => ({ content: async () => ({}) }),
			insert: async () => ({}),
			update: () => ({ merge: async () => ({}) }),
			delete: async () => ({}),
			upsert: () => ({ merge: async () => ({}) }),
		};

		type DocRow = { id: string | RecordId; title?: string };
		const options = surrealCollectionOptions<DocRow>({
			db: db as never,
			table: { name: 'doc' },
			queryClient: new QueryClient(),
			queryKey: ['doc-snapshot'],
			syncMode: 'on-demand',
			crdt: {
				enabled: true,
				profile: 'json',
				updatesTable: { name: 'crdt_update' },
				snapshotsTable: { name: 'crdt_snapshot' },
				materialize: (doc, id) => {
					const root = doc.getMap('root').toJSON() as Record<string, unknown>;
					return {
						id: new RecordId('doc', id),
						title: root.title as string | undefined,
					};
				},
				applyLocalChange: () => {},
			},
		});

		const writes: Array<Record<string, unknown>> = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change) => writes.push(change as Record<string, unknown>),
			commit: () => {},
			markReady: () => {},
			truncate: () => {},
		} as never);

		if (typeof syncResult === 'object' && syncResult?.loadSubset) {
			await syncResult.loadSubset({});
		}
		await flush();

		expect(writes.some((w) => (w.value as Record<string, unknown>)?.title === 'updated')).toBe(true);
	});
});
