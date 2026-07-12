import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CardRepository } from './card-repository.js';

/**
 * @param {string} guid
 * @param {string} text
 * @param {string | null} [parentGuid]
 * @returns {any}
 */
function line(guid, text, parentGuid = null) {
	return {
		guid,
		parent_guid: parentGuid,
		segments: [{ type: 'text', text }],
		props: null,
		/** @type {any[]} */
		metaWrites: [],
		/** @param {Record<string, any>} props */
		async setMetaProperties(props) {
			this.metaWrites.push(props);
			this.props = Object.assign({}, this.props, props);
			return true;
		},
	};
}

/**
 * @param {string} guid
 * @param {string} name
 * @param {any[]} lines
 */
function record(guid, name, lines) {
	return {
		guid,
		/** @type {boolean[]} */
		lineItemsCalls: [],
		getName: () => name,
		/** @param {boolean} expandReferences */
		async getLineItems(expandReferences) {
			this.lineItemsCalls.push(expandReferences);
			return lines;
		},
	};
}

/** @param {any[]} records */
function repositoryFor(records) {
	const recordsById = new Map(records.map(item => [item.guid, item]));
	return new CardRepository({
		data: /** @type {any} */ ({
			getAllRecords: () => records,
			getRecord: (/** @type {string} */ guid) => recordsById.get(guid) || null,
		}),
	});
}

describe('CardRepository', () => {
	it('scans without expanding references and initializes inline cards', async () => {
		const card = line('card', 'Capital of France :: Paris');
		const note = record('note', 'Geography', [card]);
		const repository = repositoryFor([note]);

		const stats = await repository.start();
		const cards = repository.getAllCards();

		assert.deepEqual(note.lineItemsCalls, [false]);
		assert.deepEqual(stats, { records: 1, found: 1, created: 1, existing: 0 });
		assert.equal(card.metaWrites.length, 1);
		assert.equal(cards.length, 1);
		assert.equal(cards[0].question, 'Capital of France');
		assert.equal(cards[0].answer, 'Paris');
		repository.dispose();
	});

	it('initializes only the parent when child answer text also contains ::', async () => {
		const parent = line('parent', 'Parent question :: Parent answer');
		const child = line('child', 'The :: operator is answer text', 'parent');
		const grandchild = line('grandchild', 'Nested card :: also answer text', 'child');
		const note = record('note', 'Nested cards', [parent, child, grandchild]);
		const repository = repositoryFor([note]);

		await repository.start();
		const cards = repository.getAllCards();

		assert.equal(cards.length, 1);
		assert.equal(cards[0].lineItemGuid, 'parent');
		assert.equal(cards[0].answer, 'Parent answer\nThe :: operator is answer text\nNested card :: also answer text');
		assert.equal(parent.metaWrites.length, 1);
		assert.equal(child.metaWrites.length, 0);
		assert.equal(grandchild.metaWrites.length, 0);
		repository.dispose();
	});

	it('keeps child cards under ordinary ancestors as independent cards', async () => {
		const heading = line('heading', 'Ordinary heading');
		const child = line('child', 'Child question :: Child answer', 'heading');
		const note = record('note', 'Nested card', [heading, child]);
		const repository = repositoryFor([note]);

		await repository.start();
		const cards = repository.getAllCards();

		assert.equal(cards.length, 1);
		assert.equal(cards[0].lineItemGuid, 'child');
		assert.deepEqual(cards[0].ancestors, ['Ordinary heading']);
		assert.equal(heading.metaWrites.length, 0);
		assert.equal(child.metaWrites.length, 1);
		repository.dispose();
	});

	it('does not initialize escaped separators or syntax-highlighted code blocks', async () => {
		const escaped = line('escaped', 'C++ uses \\:: for qualified names');
		const codeBlock = line('code', 'std::vector<int> values;');
		codeBlock.getHighlightLanguage = () => 'cpp';
		const valid = line('valid', 'C++ scope operator? :: \\::');
		const note = record('note', 'C++', [escaped, codeBlock, valid]);
		const repository = repositoryFor([note]);

		const stats = await repository.start();
		const cards = repository.getAllCards();

		assert.deepEqual(stats, { records: 1, found: 1, created: 1, existing: 0 });
		assert.equal(cards.length, 1);
		assert.equal(cards[0].lineItemGuid, 'valid');
		assert.equal(cards[0].answer, '::');
		assert.equal(escaped.metaWrites.length, 0);
		assert.equal(codeBlock.metaWrites.length, 0);
		assert.equal(valid.metaWrites.length, 1);
		repository.dispose();
	});
});
