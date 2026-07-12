import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	SEPARATOR,
	META_PREFIX,
	META,
	segmentsToText,
	gatherChildrenText,
	parseFlashcard,
	findFlashcardsInRecord,
	isNestedUnderSeparator,
	hasCardMeta,
	buildAncestorBreadcrumb,
	truncateStr,
	truncateBreadcrumbs,
	metaToCard,
	cardToMetaProps,
	formatInterval,
	formatDueDate,
	formatLastPracticed,
} from './lib.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Build a minimal line item with text segments and optional children/props. */
function mkLineItem(text, opts = {}) {
	return {
		guid: opts.guid || 'li-' + Math.random().toString(36).slice(2, 8),
		parent_guid: opts.parent_guid || null,
		segments: [{ type: 'text', text }],
		children: opts.children || [],
		props: opts.props || null,
	};
}

/** Build a line item with multiple segments. */
function mkMultiSegLineItem(segments, opts = {}) {
	return {
		guid: opts.guid || 'li-' + Math.random().toString(36).slice(2, 8),
		parent_guid: opts.parent_guid || null,
		segments: segments.map(s => (typeof s === 'string' ? { type: 'text', text: s } : s)),
		children: opts.children || [],
		props: opts.props || null,
	};
}

// ─── Constants ──────────────────────────────────────────────────────────────

describe('Constants', () => {
	it('SEPARATOR is "::"', () => {
		assert.equal(SEPARATOR, '::');
	});

	it('META_PREFIX is "fc_"', () => {
		assert.equal(META_PREFIX, 'fc_');
	});

	it('META keys all start with fc_', () => {
		for (const [key, value] of Object.entries(META)) {
			assert.ok(value.startsWith('fc_'), `META.${key} = "${value}" should start with fc_`);
		}
	});

	it('META has all expected keys', () => {
		const expected = [
			'due', 'stability', 'difficulty', 'reps', 'lapses',
			'state', 'last_review', 'elapsed_days', 'scheduled_days', 'learning_steps',
		];
		for (const key of expected) {
			assert.ok(key in META, `META should have key "${key}"`);
		}
	});
});

// ─── segmentsToText ─────────────────────────────────────────────────────────

describe('segmentsToText', () => {
	it('returns empty string for null/undefined', () => {
		assert.equal(segmentsToText(null), '');
		assert.equal(segmentsToText(undefined), '');
	});

	it('returns empty string for empty array', () => {
		assert.equal(segmentsToText([]), '');
	});

	it('joins text from multiple segments', () => {
		const segments = [
			{ type: 'text', text: 'Hello ' },
			{ type: 'text', text: 'World' },
		];
		assert.equal(segmentsToText(segments), 'Hello World');
	});

	it('handles segments with missing text', () => {
		const segments = [
			{ type: 'text', text: 'Hello' },
			{ type: 'link' },
			{ type: 'text', text: '!' },
		];
		assert.equal(segmentsToText(segments), 'Hello!');
	});

	it('handles single segment', () => {
		assert.equal(segmentsToText([{ type: 'text', text: 'solo' }]), 'solo');
	});
});

// ─── gatherChildrenText ─────────────────────────────────────────────────────

describe('gatherChildrenText', () => {
	it('returns empty array when no children', () => {
		const li = mkLineItem('parent');
		assert.deepEqual(gatherChildrenText(li), []);
	});

	it('gathers direct children at depth 0', () => {
		const li = mkLineItem('parent', {
			children: [
				mkLineItem('child1'),
				mkLineItem('child2'),
			],
		});
		const result = gatherChildrenText(li);
		assert.deepEqual(result, [
			{ text: 'child1', depth: 0 },
			{ text: 'child2', depth: 0 },
		]);
	});

	it('gathers nested children with increasing depth', () => {
		const li = mkLineItem('root', {
			children: [
				mkLineItem('level0', {
					children: [
						mkLineItem('level1', {
							children: [mkLineItem('level2')],
						}),
					],
				}),
			],
		});
		const result = gatherChildrenText(li);
		assert.deepEqual(result, [
			{ text: 'level0', depth: 0 },
			{ text: 'level1', depth: 1 },
			{ text: 'level2', depth: 2 },
		]);
	});

	it('skips empty children but continues into their children', () => {
		const li = mkLineItem('root', {
			children: [
				mkLineItem('', {
					children: [mkLineItem('nested')],
				}),
			],
		});
		const result = gatherChildrenText(li);
		assert.deepEqual(result, [
			{ text: 'nested', depth: 1 },
		]);
	});

	it('trims whitespace from child text', () => {
		const li = mkLineItem('root', {
			children: [
				mkLineItem('  spaced out  '),
			],
		});
		const result = gatherChildrenText(li);
		assert.deepEqual(result, [
			{ text: 'spaced out', depth: 0 },
		]);
	});

	it('respects custom starting depth', () => {
		const li = mkLineItem('root', {
			children: [mkLineItem('child')],
		});
		const result = gatherChildrenText(li, 3);
		assert.deepEqual(result, [
			{ text: 'child', depth: 3 },
		]);
	});
});

// ─── parseFlashcard ─────────────────────────────────────────────────────────

describe('parseFlashcard', () => {
	it('parses a simple Q :: A card', () => {
		const li = mkLineItem('Capital of France :: Paris');
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'Capital of France');
		assert.equal(fc.answer, 'Paris');
		assert.deepEqual(fc.answerLines, [
			{ text: 'Paris', depth: 0, inline: true },
		]);
	});

	it('returns null when no :: separator', () => {
		const li = mkLineItem('Just some text');
		assert.equal(parseFlashcard(li), null);
	});

	it('returns null when question is empty', () => {
		const li = mkLineItem(' :: Answer');
		assert.equal(parseFlashcard(li), null);
	});

	it('returns null when no answer content at all', () => {
		const li = mkLineItem('Question :: ');
		assert.equal(parseFlashcard(li), null);
	});

	it('handles inline answer + children (multiline)', () => {
		const li = mkLineItem('Phases of mitosis :: Prophase', {
			children: [
				mkLineItem('Metaphase'),
				mkLineItem('Anaphase'),
				mkLineItem('Telophase'),
			],
		});
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'Phases of mitosis');
		assert.equal(fc.answer, 'Prophase\nMetaphase\nAnaphase\nTelophase');
		assert.equal(fc.answerLines.length, 4);
		assert.deepEqual(fc.answerLines[0], { text: 'Prophase', depth: 0, inline: true });
		assert.deepEqual(fc.answerLines[1], { text: 'Metaphase', depth: 0 });
		assert.deepEqual(fc.answerLines[2], { text: 'Anaphase', depth: 0 });
		assert.deepEqual(fc.answerLines[3], { text: 'Telophase', depth: 0 });
	});

	it('handles children-only answer (Q :: with children)', () => {
		const li = mkLineItem('Phases of mitosis :: ', {
			children: [
				mkLineItem('Prophase'),
				mkLineItem('Metaphase'),
			],
		});
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'Phases of mitosis');
		assert.equal(fc.answer, 'Prophase\nMetaphase');
		assert.equal(fc.answerLines.length, 2);
		// No inline line when inline answer is empty
		assert.ok(!fc.answerLines[0].inline);
	});

	it('returns null when Q :: has no inline answer and no children', () => {
		const li = mkLineItem('Question ::');
		assert.equal(parseFlashcard(li), null);
	});

	it('preserves nesting depth in children', () => {
		const li = mkLineItem('Q :: A', {
			children: [
				mkLineItem('L0', {
					children: [mkLineItem('L1')],
				}),
			],
		});
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.deepEqual(fc.answerLines, [
			{ text: 'A', depth: 0, inline: true },
			{ text: 'L0', depth: 0 },
			{ text: 'L1', depth: 1 },
		]);
	});

	it('uses first :: as separator (handles :: in answer)', () => {
		const li = mkLineItem('Q :: A :: B');
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'Q');
		assert.equal(fc.answer, 'A :: B');
	});

	it('works with multi-segment line items', () => {
		const li = mkMultiSegLineItem(['Capital of ', 'France', ' :: Paris']);
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'Capital of France');
		assert.equal(fc.answer, 'Paris');
	});

	it('does not parse an escaped separator', () => {
		const li = mkLineItem('C++ uses \\:: for qualified names');
		assert.equal(parseFlashcard(li), null);
	});

	it('unescapes literal separators when another separator creates the card', () => {
		const li = mkLineItem('What does \\:: mean in C++? :: Scope resolution');
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'What does :: mean in C++?');
		assert.equal(fc.answer, 'Scope resolution');
	});

	it('unescapes a literal separator in the answer', () => {
		const li = mkLineItem('C++ scope resolution operator? :: \\::');
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.answer, '::');
	});

	it('does not parse :: inside an inline-code segment', () => {
		const li = mkMultiSegLineItem([
			{ type: 'text', text: 'Use ' },
			{ type: 'code', text: 'std::vector<int>' },
			{ type: 'text', text: ' in C++' },
		]);
		assert.equal(parseFlashcard(li), null);
	});

	it('can parse a card whose question contains inline code with ::', () => {
		const li = mkMultiSegLineItem([
			{ type: 'code', text: 'std::vector' },
			{ type: 'text', text: ' stores what? :: A dynamic array' },
		]);
		const fc = parseFlashcard(li);
		assert.ok(fc);
		assert.equal(fc.question, 'std::vector stores what?');
		assert.equal(fc.answer, 'A dynamic array');
	});

	it('does not parse syntax-highlighted code blocks', () => {
		const li = mkLineItem('std::vector<int> values;');
		li.getHighlightLanguage = () => 'cpp';
		assert.equal(parseFlashcard(li), null);
	});
});

// ─── hasCardMeta ────────────────────────────────────────────────────────────

describe('hasCardMeta', () => {
	it('returns false when props is null', () => {
		const li = mkLineItem('text');
		assert.ok(!hasCardMeta(li));
	});

	it('returns false when props exists but no fc_due', () => {
		const li = mkLineItem('text', { props: { some_other: 'value' } });
		assert.equal(hasCardMeta(li), false);
	});

	it('returns true when fc_due exists', () => {
		const li = mkLineItem('text', {
			props: { [META.due]: '2025-01-01T00:00:00.000Z' },
		});
		assert.equal(hasCardMeta(li), true);
	});

	it('returns false when fc_due is null', () => {
		const li = mkLineItem('text', {
			props: { [META.due]: null },
		});
		assert.equal(hasCardMeta(li), false);
	});

	it('returns true when fc_due is 0 (falsy but not null/undefined)', () => {
		const li = mkLineItem('text', {
			props: { [META.due]: 0 },
		});
		// 0 != null is true, so hasCardMeta returns true
		assert.equal(hasCardMeta(li), true);
	});
});

// ─── buildAncestorBreadcrumb ────────────────────────────────────────────────

describe('buildAncestorBreadcrumb', () => {
	it('returns empty array for a top-level item', () => {
		const li = mkLineItem('card', { guid: 'c1' });
		assert.deepEqual(buildAncestorBreadcrumb(li, [li]), []);
	});

	it('returns parent text for a one-level nested item', () => {
		const parent = mkLineItem('Parent', { guid: 'p1' });
		const child = mkLineItem('Child', { guid: 'c1', parent_guid: 'p1' });
		assert.deepEqual(buildAncestorBreadcrumb(child, [parent, child]), ['Parent']);
	});

	it('returns ancestors from root down for deeply nested items', () => {
		const root = mkLineItem('Root', { guid: 'r' });
		const mid = mkLineItem('Middle', { guid: 'm', parent_guid: 'r' });
		const leaf = mkLineItem('Leaf', { guid: 'l', parent_guid: 'm' });
		const all = [root, mid, leaf];
		assert.deepEqual(buildAncestorBreadcrumb(leaf, all), ['Root', 'Middle']);
	});

	it('handles missing parent gracefully (broken chain)', () => {
		const child = mkLineItem('Child', { guid: 'c1', parent_guid: 'missing' });
		assert.deepEqual(buildAncestorBreadcrumb(child, [child]), []);
	});

	it('skips ancestors with empty text', () => {
		const root = mkLineItem('', { guid: 'r' });
		const mid = mkLineItem('Middle', { guid: 'm', parent_guid: 'r' });
		const leaf = mkLineItem('Leaf', { guid: 'l', parent_guid: 'm' });
		const all = [root, mid, leaf];
		assert.deepEqual(buildAncestorBreadcrumb(leaf, all), ['Middle']);
	});
});

// ─── truncateStr ────────────────────────────────────────────────────────────

describe('truncateStr', () => {
	it('returns string as-is if within max', () => {
		assert.equal(truncateStr('hello', 10), 'hello');
	});

	it('returns string as-is if exactly max length', () => {
		assert.equal(truncateStr('hello', 5), 'hello');
	});

	it('truncates and adds ellipsis when over max', () => {
		const result = truncateStr('hello world', 6);
		assert.ok(result.length <= 6);
		assert.ok(result.endsWith('…'));
	});

	it('returns just ellipsis when max is 1', () => {
		assert.equal(truncateStr('hello', 1), '…');
	});

	it('returns ellipsis when max is 0', () => {
		assert.equal(truncateStr('hello', 0), '…');
	});

	it('handles empty string', () => {
		assert.equal(truncateStr('', 5), '');
	});

	it('trims trailing whitespace before ellipsis', () => {
		// "hello world" truncated to 7 chars: "hello " + "…" but trimEnd → "hello…"
		const result = truncateStr('hello world', 7);
		assert.ok(!result.includes(' …'), `Got "${result}" - should not have space before ellipsis`);
		assert.ok(result.endsWith('…'));
	});
});

// ─── truncateBreadcrumbs ────────────────────────────────────────────────────

describe('truncateBreadcrumbs', () => {
	it('handles note name only (no ancestors)', () => {
		const result = truncateBreadcrumbs('My Note', [], 50);
		assert.equal(result.noteName, 'My Note');
		assert.deepEqual(result.crumbs, []);
	});

	it('truncates long note name when no ancestors', () => {
		const longName = 'A'.repeat(100);
		const result = truncateBreadcrumbs(longName, [], 20);
		assert.ok(result.noteName.length <= 20);
		assert.ok(result.noteName.endsWith('…'));
	});

	it('handles note name + single ancestor', () => {
		const result = truncateBreadcrumbs('Note', ['Section'], 50);
		assert.ok(result.noteName);
		assert.equal(result.crumbs.length, 1);
	});

	it('handles note name + multiple ancestors', () => {
		const result = truncateBreadcrumbs('Note', ['A', 'B', 'C'], 50);
		assert.equal(result.crumbs.length, 3);
	});

	it('truncates ancestors when budget is tight', () => {
		const result = truncateBreadcrumbs(
			'Very Long Note Name Here',
			['Very Long Ancestor Name'],
			30,
		);
		assert.ok(result.noteName.length <= 30);
		assert.ok(result.crumbs[0].length <= 30);
	});

	it('defaults budget to 90 when not provided', () => {
		const result = truncateBreadcrumbs('Note', ['Ancestor']);
		assert.ok(result.noteName);
		assert.ok(result.crumbs.length === 1);
	});

	it('returns both parts even with very small budget', () => {
		const result = truncateBreadcrumbs('Note', ['Ancestor'], 10);
		assert.ok(result.noteName.length > 0);
		assert.ok(result.crumbs.length === 1);
		assert.ok(result.crumbs[0].length > 0);
	});
});

// ─── metaToCard ─────────────────────────────────────────────────────────────

describe('metaToCard', () => {
	it('reconstructs a card from meta properties', () => {
		const now = new Date('2025-06-01T12:00:00Z');
		const li = mkLineItem('Q :: A', {
			props: {
				[META.due]: '2025-06-05T12:00:00.000Z',
				[META.stability]: 4.5,
				[META.difficulty]: 5.2,
				[META.elapsed_days]: 3,
				[META.scheduled_days]: 4,
				[META.reps]: 2,
				[META.lapses]: 0,
				[META.learning_steps]: 0,
				[META.state]: 2,
				[META.last_review]: '2025-06-01T12:00:00.000Z',
			},
		});
		const card = metaToCard(li);
		assert.equal(card.due.toISOString(), '2025-06-05T12:00:00.000Z');
		assert.equal(card.stability, 4.5);
		assert.equal(card.difficulty, 5.2);
		assert.equal(card.elapsed_days, 3);
		assert.equal(card.scheduled_days, 4);
		assert.equal(card.reps, 2);
		assert.equal(card.lapses, 0);
		assert.equal(card.learning_steps, 0);
		assert.equal(card.state, 2);
		assert.equal(card.last_review.toISOString(), '2025-06-01T12:00:00.000Z');
	});

	it('handles missing props gracefully (defaults to 0)', () => {
		const li = mkLineItem('Q :: A', { props: {} });
		const card = metaToCard(li);
		assert.equal(card.stability, 0);
		assert.equal(card.difficulty, 0);
		assert.equal(card.reps, 0);
		assert.equal(card.lapses, 0);
		assert.equal(card.state, 0);
		assert.equal(card.last_review, undefined);
	});

	it('handles null props', () => {
		const li = mkLineItem('Q :: A');
		const card = metaToCard(li);
		assert.equal(card.stability, 0);
		assert.equal(card.last_review, undefined);
	});

	it('handles string-encoded numbers', () => {
		const li = mkLineItem('Q :: A', {
			props: {
				[META.due]: '2025-06-05T12:00:00.000Z',
				[META.stability]: '4.5',
				[META.difficulty]: '5.2',
				[META.reps]: '3',
				[META.state]: '2',
			},
		});
		const card = metaToCard(li);
		assert.equal(card.stability, 4.5);
		assert.equal(card.difficulty, 5.2);
		assert.equal(card.reps, 3);
		assert.equal(card.state, 2);
	});
});

// ─── cardToMetaProps ────────────────────────────────────────────────────────

describe('cardToMetaProps', () => {
	it('builds meta props from a card object', () => {
		const card = {
			due: new Date('2025-06-05T12:00:00.000Z'),
			stability: 4.5,
			difficulty: 5.2,
			elapsed_days: 3,
			scheduled_days: 4,
			reps: 2,
			lapses: 0,
			learning_steps: 0,
			state: 2,
			last_review: new Date('2025-06-01T12:00:00.000Z'),
		};
		const props = cardToMetaProps(card);
		assert.equal(props[META.due], '2025-06-05T12:00:00.000Z');
		assert.equal(props[META.stability], 4.5);
		assert.equal(props[META.difficulty], 5.2);
		assert.equal(props[META.elapsed_days], 3);
		assert.equal(props[META.scheduled_days], 4);
		assert.equal(props[META.reps], 2);
		assert.equal(props[META.lapses], 0);
		assert.equal(props[META.learning_steps], 0);
		assert.equal(props[META.state], 2);
		assert.equal(props[META.last_review], '2025-06-01T12:00:00.000Z');
	});

	it('sets last_review to null when undefined', () => {
		const card = {
			due: new Date('2025-06-05T12:00:00.000Z'),
			stability: 0,
			difficulty: 0,
			elapsed_days: 0,
			scheduled_days: 0,
			reps: 0,
			lapses: 0,
			learning_steps: 0,
			state: 0,
			last_review: undefined,
		};
		const props = cardToMetaProps(card);
		assert.equal(props[META.last_review], null);
	});

	it('round-trips through metaToCard', () => {
		const original = {
			due: new Date('2025-06-05T12:00:00.000Z'),
			stability: 4.5,
			difficulty: 5.2,
			elapsed_days: 3,
			scheduled_days: 4,
			reps: 2,
			lapses: 1,
			learning_steps: 0,
			state: 2,
			last_review: new Date('2025-06-01T12:00:00.000Z'),
		};
		const props = cardToMetaProps(original);
		const li = mkLineItem('Q :: A', { props });
		const reconstructed = metaToCard(li);

		assert.equal(reconstructed.due.toISOString(), original.due.toISOString());
		assert.equal(reconstructed.stability, original.stability);
		assert.equal(reconstructed.difficulty, original.difficulty);
		assert.equal(reconstructed.elapsed_days, original.elapsed_days);
		assert.equal(reconstructed.scheduled_days, original.scheduled_days);
		assert.equal(reconstructed.reps, original.reps);
		assert.equal(reconstructed.lapses, original.lapses);
		assert.equal(reconstructed.learning_steps, original.learning_steps);
		assert.equal(reconstructed.state, original.state);
		assert.equal(reconstructed.last_review.toISOString(), original.last_review.toISOString());
	});
});

// ─── formatInterval ─────────────────────────────────────────────────────────

describe('formatInterval', () => {
	it('returns "< 1d" for sub-day with no last_review', () => {
		const card = { scheduled_days: 0, due: new Date() };
		assert.equal(formatInterval(card), '< 1d');
	});

	it('returns minutes for sub-day with last_review', () => {
		const last = new Date('2025-06-01T12:00:00Z');
		const due = new Date('2025-06-01T12:10:00Z'); // 10 min later
		const card = { scheduled_days: 0, due, last_review: last };
		assert.equal(formatInterval(card), '10m');
	});

	it('returns "< 1m" for less-than-a-minute interval', () => {
		const last = new Date('2025-06-01T12:00:00Z');
		const due = new Date('2025-06-01T12:00:20Z'); // 20 sec later
		const card = { scheduled_days: 0, due, last_review: last };
		assert.equal(formatInterval(card), '< 1m');
	});

	it('returns hours for sub-day intervals over 60 min', () => {
		const last = new Date('2025-06-01T12:00:00Z');
		const due = new Date('2025-06-01T15:00:00Z'); // 3 hrs later
		const card = { scheduled_days: 0, due, last_review: last };
		assert.equal(formatInterval(card), '3h');
	});

	it('returns "1d" for 1 day', () => {
		const card = { scheduled_days: 1 };
		assert.equal(formatInterval(card), '1d');
	});

	it('returns days for 2-29 days', () => {
		assert.equal(formatInterval({ scheduled_days: 2 }), '2d');
		assert.equal(formatInterval({ scheduled_days: 15 }), '15d');
		assert.equal(formatInterval({ scheduled_days: 29 }), '29d');
	});

	it('returns months for 30-364 days', () => {
		assert.equal(formatInterval({ scheduled_days: 30 }), '1mo');
		assert.equal(formatInterval({ scheduled_days: 60 }), '2mo');
		assert.equal(formatInterval({ scheduled_days: 180 }), '6mo');
		assert.equal(formatInterval({ scheduled_days: 364 }), '12mo');
	});

	it('returns years for 365+ days', () => {
		assert.equal(formatInterval({ scheduled_days: 365 }), '1y');
		assert.equal(formatInterval({ scheduled_days: 730 }), '2y');
	});

	it('returns fractional years', () => {
		// 548 days ≈ 1.5 years
		assert.equal(formatInterval({ scheduled_days: 548 }), '1.5y');
	});
});

// ─── formatDueDate ──────────────────────────────────────────────────────────

describe('formatDueDate', () => {
	it('formats a date as "Mon DD, YYYY"', () => {
		const date = new Date('2026-02-10T00:00:00Z');
		const result = formatDueDate(date);
		// Locale-dependent but should contain the components
		assert.ok(result.includes('Feb'), `Expected "Feb" in "${result}"`);
		assert.ok(result.includes('10'), `Expected "10" in "${result}"`);
		assert.ok(result.includes('2026'), `Expected "2026" in "${result}"`);
	});
});

// ─── formatLastPracticed ────────────────────────────────────────────────────

describe('formatLastPracticed', () => {
	it('formats a date with day name, date, and time', () => {
		const date = new Date('2026-02-10T16:30:00Z');
		const result = formatLastPracticed(date);
		// Should contain abbreviated day name, month, day, year, and time
		assert.ok(result.includes('Feb') || result.includes('2026'),
			`Expected date components in "${result}"`);
	});

	it('returns a non-empty string', () => {
		const result = formatLastPracticed(new Date());
		assert.ok(result.length > 0);
	});
});

// ─── isNestedUnderSeparator ─────────────────────────────────────────────────

describe('isNestedUnderSeparator', () => {
	/** Build a byGuid map from an array of line items. */
	function buildMap(items) {
		const m = new Map();
		for (const li of items) m.set(li.guid, li);
		return m;
	}

	it('returns false for a top-level line item (no parent)', () => {
		const li = mkLineItem('Q :: A', { guid: 'a' });
		const byGuid = buildMap([li]);
		assert.equal(isNestedUnderSeparator(li, byGuid), false);
	});

	it('returns false for a child whose parent has no ::', () => {
		const parent = mkLineItem('Just a heading', { guid: 'p' });
		const child = mkLineItem('Sub :: item', { guid: 'c', parent_guid: 'p' });
		const byGuid = buildMap([parent, child]);
		assert.equal(isNestedUnderSeparator(child, byGuid), false);
	});

	it('returns true for a direct child of a :: line', () => {
		const parent = mkLineItem('Q :: A', { guid: 'p' });
		const child = mkLineItem('The :: operator is not relevant', { guid: 'c', parent_guid: 'p' });
		const byGuid = buildMap([parent, child]);
		assert.equal(isNestedUnderSeparator(child, byGuid), true);
	});

	it('returns true for a grandchild of a :: line', () => {
		const root = mkLineItem('Q :: A', { guid: 'r' });
		const mid = mkLineItem('middle', { guid: 'm', parent_guid: 'r' });
		const leaf = mkLineItem('deep :: nested', { guid: 'l', parent_guid: 'm' });
		const byGuid = buildMap([root, mid, leaf]);
		assert.equal(isNestedUnderSeparator(leaf, byGuid), true);
	});

	it('returns false when parent_guid points to a missing item', () => {
		const li = mkLineItem('Q :: A', { guid: 'a', parent_guid: 'missing' });
		const byGuid = buildMap([li]);
		assert.equal(isNestedUnderSeparator(li, byGuid), false);
	});

	it('does not suppress a child card under an escaped separator', () => {
		const parent = mkLineItem('C++ uses \\:: for qualified names', { guid: 'parent' });
		const child = mkLineItem('Valid question :: Valid answer', { guid: 'child', parent_guid: 'parent' });
		const byGuid = buildMap([parent, child]);
		assert.equal(isNestedUnderSeparator(child, byGuid), false);
	});

	it('does not suppress a child card under inline code containing ::', () => {
		const parent = mkMultiSegLineItem([{ type: 'code', text: 'std::vector' }], { guid: 'parent' });
		const child = mkLineItem('Valid question :: Valid answer', { guid: 'child', parent_guid: 'parent' });
		const byGuid = buildMap([parent, child]);
		assert.equal(isNestedUnderSeparator(child, byGuid), false);
	});

	it('only checks ancestors, not the line item itself', () => {
		// A top-level :: line should NOT be considered nested under a separator
		const li = mkLineItem('Q :: A', { guid: 'a' });
		const byGuid = buildMap([li]);
		assert.equal(isNestedUnderSeparator(li, byGuid), false);
	});

	it('stops at the first ancestor with :: (does not over-walk)', () => {
		const grandparent = mkLineItem('no separator here', { guid: 'gp' });
		const parent = mkLineItem('Parent :: Answer', { guid: 'p', parent_guid: 'gp' });
		const child = mkLineItem('child text', { guid: 'c', parent_guid: 'p' });
		const byGuid = buildMap([grandparent, parent, child]);
		assert.equal(isNestedUnderSeparator(child, byGuid), true);
	});

	it('handles the exact scenario from the bug report', () => {
		// What does this code print :: It prints "hello"
		//    The :: operator is not relevant here
		//    Just a normal child line
		const card = mkLineItem('What does this code print :: It prints "hello"', {
			guid: 'card',
			children: [
				mkLineItem('The :: operator is not relevant here', { guid: 'c1', parent_guid: 'card' }),
				mkLineItem('Just a normal child line', { guid: 'c2', parent_guid: 'card' }),
			],
		});
		const c1 = card.children[0];
		const c2 = card.children[1];
		const byGuid = buildMap([card, c1, c2]);

		// The parent card itself is NOT nested
		assert.equal(isNestedUnderSeparator(card, byGuid), false);
		// Both children ARE nested under a :: line
		assert.equal(isNestedUnderSeparator(c1, byGuid), true);
		assert.equal(isNestedUnderSeparator(c2, byGuid), true);

		// Only the parent should parse as a card
		assert.ok(parseFlashcard(card));
		// c1 would parse as a card too if we didn't filter — verify that
		assert.ok(parseFlashcard(c1), 'c1 does contain :: and would parse without the guard');
	});
});

// ─── findFlashcardsInRecord ──────────────────────────────────────────────────

describe('findFlashcardsInRecord', () => {
	it('preserves inline Question :: Answer syntax with or without spaces', () => {
		const spaced = mkLineItem('Capital of France :: Paris', { guid: 'spaced' });
		const compact = mkLineItem('Capital of France::Paris', { guid: 'compact' });
		const cards = findFlashcardsInRecord([spaced, compact]);

		assert.equal(cards.length, 2);
		assert.deepEqual(cards.map(card => ({ question: card.question, answer: card.answer })), [
			{ question: 'Capital of France', answer: 'Paris' },
			{ question: 'Capital of France', answer: 'Paris' },
		]);
	});

	it('rebuilds child answers from a flat Thymer line-item list', () => {
		const parent = mkLineItem('Q :: Inline', { guid: 'parent' });
		const child = mkLineItem('Child one', { guid: 'child', parent_guid: 'parent' });
		const grandchild = mkLineItem('Grandchild', { guid: 'grandchild', parent_guid: 'child' });
		const sibling = mkLineItem('Child two', { guid: 'sibling', parent_guid: 'parent' });

		const cards = findFlashcardsInRecord([parent, child, grandchild, sibling]);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].lineItem, parent);
		assert.equal(cards[0].answer, 'Inline\nChild one\nGrandchild\nChild two');
		assert.deepEqual(cards[0].answerLines, [
			{ text: 'Inline', depth: 0, inline: true },
			{ text: 'Child one', depth: 0 },
			{ text: 'Grandchild', depth: 1 },
			{ text: 'Child two', depth: 0 },
		]);
	});

	it('supports answers made entirely from child lines', () => {
		const parent = mkLineItem('Q ::', { guid: 'parent' });
		const child = mkLineItem('First', { guid: 'child', parent_guid: 'parent' });
		const detail = mkLineItem('Detail', { guid: 'detail', parent_guid: 'child' });
		const second = mkLineItem('Second', { guid: 'second', parent_guid: 'parent' });

		const cards = findFlashcardsInRecord([parent, child, detail, second]);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].answer, 'First\nDetail\nSecond');
		assert.deepEqual(cards[0].answerLines, [
			{ text: 'First', depth: 0 },
			{ text: 'Detail', depth: 1 },
			{ text: 'Second', depth: 0 },
		]);
	});

	it('treats descendant :: lines as parent answer content, not child cards', () => {
		const parent = mkLineItem('Parent question :: Parent answer', { guid: 'parent' });
		const child = mkLineItem('The :: operator is used here', { guid: 'child', parent_guid: 'parent' });
		const grandchild = mkLineItem('Nested question :: Nested answer', { guid: 'grandchild', parent_guid: 'child' });

		const cards = findFlashcardsInRecord([parent, child, grandchild]);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].question, 'Parent question');
		assert.equal(cards[0].answer, 'Parent answer\nThe :: operator is used here\nNested question :: Nested answer');
	});

	it('allows nested cards below ordinary non-card ancestors', () => {
		const heading = mkLineItem('Ordinary heading', { guid: 'heading' });
		const child = mkLineItem('Child question :: Child answer', { guid: 'child', parent_guid: 'heading' });

		const cards = findFlashcardsInRecord([heading, child]);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].question, 'Child question');
		assert.deepEqual(cards[0].ancestors, ['Ordinary heading']);
	});

	it('recognizes a separator split across rich-text segments', () => {
		const line = mkMultiSegLineItem([
			{ type: 'text', text: 'Question ' },
			{ type: 'bold', text: ':' },
			{ type: 'italic', text: ':' },
			{ type: 'text', text: ' Answer' },
		], { guid: 'split' });

		const cards = findFlashcardsInRecord([line]);

		assert.equal(cards.length, 1);
		assert.equal(cards[0].question, 'Question');
		assert.equal(cards[0].answer, 'Answer');
	});
});