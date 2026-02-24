import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { Surreal } from 'surrealdb';

import { WebCryptoAESGCM, surrealCollectionOptions } from '../src';

const db = new Surreal();
const queryClient = new QueryClient();

const key = crypto.getRandomValues(new Uint8Array(32));
const provider = await WebCryptoAESGCM.fromRawKey(key, { kid: 'org-2026-01' });

type SecretNote = {
	id: string;
	title: string;
	body: string;
};

export const secretNotes = createCollection(
	surrealCollectionOptions<SecretNote>({
		db,
		table: { name: 'secret_note' },
		queryClient,
		queryKey: ['secret-note'],
		syncMode: 'eager',
		e2ee: {
			enabled: true,
			crypto: provider,
		},
	}),
);
