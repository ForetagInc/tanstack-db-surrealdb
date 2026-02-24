import { describe, expect, it } from 'bun:test';
import { LoroDoc } from 'loro-crdt';

import {
	applyLoroJsonChange,
	applyLoroRichtextChange,
	createLoroProfile,
	materializeLoroJson,
	materializeLoroRichtext,
} from '../src/crdt';

describe('crdt profile helpers', () => {
	it('materializes and applies json changes', () => {
		const doc = new LoroDoc();
		applyLoroJsonChange(doc, {
			type: 'insert',
			value: { id: '1', title: 'hello', done: false },
		});

		const item = materializeLoroJson<{ id: string; title: string; done: boolean }>(
			doc,
			'1',
		);
		expect(item.id).toBe('1');
		expect(item.title).toBe('hello');
		expect(item.done).toBe(false);
	});

	it('materializes and applies richtext changes', () => {
		const doc = new LoroDoc();
		applyLoroRichtextChange(doc, {
			type: 'insert',
			value: { id: 'x', content: 'Hello world', title: 'Doc' },
		});

		const item = materializeLoroRichtext<{
			id: string;
			content: string;
			title: string;
		}>(doc, 'x');
		expect(item.id).toBe('x');
		expect(item.content).toBe('Hello world');
		expect(item.title).toBe('Doc');
	});

	it('returns profile-specific adapters', () => {
		const json = createLoroProfile('json');
		const rich = createLoroProfile('richtext');

		const jsonDoc = new LoroDoc();
		json.applyLocalChange(jsonDoc, {
			type: 'insert',
			value: { id: '1', count: 1 },
		});
		expect(json.materialize<{ id: string; count: number }>(jsonDoc, '1').count).toBe(
			1,
		);

		const richDoc = new LoroDoc();
		rich.applyLocalChange(richDoc, {
			type: 'insert',
			value: { id: '2', content: 'a' },
		});
		expect(
			rich.materialize<{ id: string; content: string }>(richDoc, '2').content,
		).toBe('a');
	});
});
