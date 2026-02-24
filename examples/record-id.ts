import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId, Surreal } from 'surrealdb';

import { surrealCollectionOptions } from '../src';

const db = new Surreal();
const queryClient = new QueryClient();

type CalendarEvent = {
	id: RecordId<'calendar_event'>;
	owner: RecordId<'account'>;
	title: string;
	start_at: string;
};

export const calendarEvents = createCollection(
	surrealCollectionOptions<CalendarEvent>({
		db,
		table: { name: 'calendar_event' },
		queryClient,
		queryKey: ['calendar_event'],
		syncMode: 'on-demand',
	}),
);

const ownerId = new RecordId('account', 'user-123');

export const ownerEvents = createLiveQueryCollection((q) =>
	q
		.from({ calendarEvents })
		.where(({ calendarEvents }) => eq(calendarEvents.owner, ownerId))
		.select(({ calendarEvents }) => calendarEvents),
);

await ownerEvents.preload();

calendarEvents.insert({
	id: new RecordId('calendar_event', 'evt-001'),
	owner: ownerId,
	title: 'Planning',
	start_at: '2026-02-23T10:00:00.000Z',
});
