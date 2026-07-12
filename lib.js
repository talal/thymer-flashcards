// ─── Constants ──────────────────────────────────────────────────────────────
export const SEPARATOR = '::';
export const META_PREFIX = 'fc_';

// Meta property keys stored on each flashcard line item
export const META = {
	due:            META_PREFIX + 'due',
	stability:      META_PREFIX + 'stability',
	difficulty:     META_PREFIX + 'difficulty',
	reps:           META_PREFIX + 'reps',
	lapses:         META_PREFIX + 'lapses',
	state:          META_PREFIX + 'state',
	last_review:    META_PREFIX + 'last_review',
	elapsed_days:   META_PREFIX + 'elapsed_days',
	scheduled_days: META_PREFIX + 'scheduled_days',
	learning_steps: META_PREFIX + 'learning_steps',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract plain text from line item segments.
 * @param {PluginLineItemSegment[]} segments
 * @returns {string}
 */
export function segmentsToText(segments) {
	if (!segments || !segments.length) return '';
	return segments.map(s => s.text || '').join('');
}

/**
 * Recursively gather text from a line item's children.
 * Returns an array of { text, depth } objects preserving nesting.
 * @param {PluginLineItem} lineItem
 * @param {number} depth
 * @returns {{ text: string, depth: number }[]}
 */
export function gatherChildrenText(lineItem, depth = 0) {
	const lines = [];
	for (const child of (lineItem.children || [])) {
		const text = segmentsToText(child.segments).trim();
		if (text) {
			lines.push({ text, depth });
		}
		lines.push(...gatherChildrenText(child, depth + 1));
	}
	return lines;
}

/**
 * Return the first separator that is neither escaped (`\::`) nor inside an
 * inline-code segment. Syntax-highlighted code blocks are never flashcards.
 * @param {PluginLineItem | any} lineItem
 * @returns {number}
 */
export function findFlashcardSeparatorIndex(lineItem) {
	if (lineItem._flashcardCodeBlock ||
		(typeof lineItem.getHighlightLanguage === 'function' && lineItem.getHighlightLanguage() != null)) {
		return -1;
	}

	let text = '';
	/** @type {boolean[]} */
	const protectedCharacters = [];
	for (const segment of lineItem.segments || []) {
		const value = typeof segment.text === 'string' ? segment.text : '';
		text += value;
		for (let i = 0; i < value.length; i++) protectedCharacters.push(segment.type === 'code');
	}

	for (let index = 0; index <= text.length - SEPARATOR.length; index++) {
		if (text.slice(index, index + SEPARATOR.length) !== SEPARATOR) continue;
		if (protectedCharacters[index] || protectedCharacters[index + 1]) continue;

		let precedingBackslashes = 0;
		for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) {
			precedingBackslashes++;
		}
		if (precedingBackslashes % 2 === 0) return index;
	}
	return -1;
}

/**
 * Remove the escape character from literal separators in displayed card text.
 * @param {string} value
 * @returns {string}
 */
export function unescapeCardSeparators(value) {
	return value.replace(/\\::/g, SEPARATOR);
}

/**
 * Try to parse a flashcard from a line item's text.
 * Children of the line item are gathered as additional answer content.
 * Returns { question, answer, answerLines } or null.
 * @param {PluginLineItem} lineItem
 * @returns {{ question: string, answer: string, answerLines: { text: string, depth: number, inline?: boolean }[] } | null}
 */
export function parseFlashcard(lineItem) {
	const text = segmentsToText(lineItem.segments);
	const idx = findFlashcardSeparatorIndex(lineItem);
	if (idx === -1) return null;

	const question = unescapeCardSeparators(text.slice(0, idx)).trim();
	const inlineAnswer = unescapeCardSeparators(text.slice(idx + SEPARATOR.length)).trim();

	// Gather children as additional answer lines
	const childLines = gatherChildrenText(lineItem);

	// Build answerLines: inline answer at depth 0 (flagged), then children
	const answerLines = [];
	if (inlineAnswer) {
		answerLines.push({ text: inlineAnswer, depth: 0, inline: true });
	}
	answerLines.push(...childLines);

	// Need a question and at least some answer content
	if (!question || answerLines.length === 0) return null;

	// Flat answer string for dashboard / backward compat
	const answer = answerLines.map(l => l.text).join('\n');

	return { question, answer, answerLines };
}

/**
 * Check whether a line item is nested under another line that contains the
 * `::` separator (i.e. it is a descendant of a flashcard line and should not
 * be treated as its own card).
 * @param {PluginLineItem} lineItem
 * @param {Map<string, PluginLineItem>} byGuid - map of guid → lineItem for the same record
 * @returns {boolean}
 */
export function isNestedUnderSeparator(lineItem, byGuid) {
	let current = lineItem;
	while (current.parent_guid) {
		const parent = byGuid.get(current.parent_guid);
		if (!parent) break;
		if (findFlashcardSeparatorIndex(parent) !== -1) return true;
		current = parent;
	}
	return false;
}

/**
 * Find flashcards in a record while preserving the existing syntax contract:
 * descendants of a `::` line are answer content, not independent cards.
 *
 * Thymer returns a flat line-item list. Rebuild a lightweight tree from
 * `parent_guid` rather than relying on the SDK's optional children cache.
 * The original line item is retained for metadata writes.
 *
 * @param {PluginLineItem[]} lineItems
 * @returns {Array<{ lineItem: PluginLineItem, question: string, answer: string, answerLines: { text: string, depth: number, inline?: boolean }[], ancestors: string[] }>}
 */
export function findFlashcardsInRecord(lineItems) {
	/** @type {Map<string, PluginLineItem[]>} */
	const childrenByParent = new Map();
	for (const lineItem of lineItems) {
		if (!lineItem.parent_guid) continue;
		const siblings = childrenByParent.get(lineItem.parent_guid) || [];
		siblings.push(lineItem);
		childrenByParent.set(lineItem.parent_guid, siblings);
	}

	/** @type {Map<string, any>} */
	const hydratedByGuid = new Map();
	for (const lineItem of lineItems) {
		hydratedByGuid.set(lineItem.guid, {
			guid: lineItem.guid,
			parent_guid: lineItem.parent_guid,
			segments: lineItem.segments,
			props: lineItem.props,
			_flashcardCodeBlock: typeof lineItem.getHighlightLanguage === 'function' &&
				lineItem.getHighlightLanguage() != null,
			children: [],
		});
	}
	for (const [guid, hydrated] of hydratedByGuid) {
		hydrated.children = (childrenByParent.get(guid) || [])
			.map(child => hydratedByGuid.get(child.guid))
			.filter(Boolean);
	}

	const cards = [];
	for (const lineItem of lineItems) {
		const hydrated = hydratedByGuid.get(lineItem.guid);
		if (!hydrated || isNestedUnderSeparator(hydrated, hydratedByGuid)) continue;
		const parsed = parseFlashcard(hydrated);
		if (!parsed) continue;

		cards.push({
			lineItem,
			question: parsed.question,
			answer: parsed.answer,
			answerLines: parsed.answerLines,
			ancestors: buildAncestorBreadcrumb(hydrated, [...hydratedByGuid.values()]),
		});
	}
	return cards;
}

/**
 * Check whether a line item already has FSRS metadata.
 * @param {PluginLineItem} lineItem
 * @returns {boolean}
 */
export function hasCardMeta(lineItem) {
	return Boolean(lineItem.props && lineItem.props[META.due] != null);
}

/**
 * Build the ancestor breadcrumb for a flashcard line item.
 * Returns an array of ancestor text strings from root (top-level) down to
 * the immediate parent of the given line item. Does NOT include the line item itself.
 * @param {PluginLineItem} lineItem - the flashcard line item
 * @param {PluginLineItem[]} allLineItems - all line items from the same record
 * @returns {string[]}
 */
export function buildAncestorBreadcrumb(lineItem, allLineItems) {
	const byGuid = new Map();
	for (const li of allLineItems) {
		byGuid.set(li.guid, li);
	}

	const ancestors = [];
	let current = lineItem;
	while (current.parent_guid) {
		const parent = byGuid.get(current.parent_guid);
		if (!parent) break;
		const text = segmentsToText(parent.segments).trim();
		if (text) ancestors.unshift(text);
		current = parent;
	}
	return ancestors;
}

/**
 * Truncate a string to a maximum length, appending "…" if needed.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
export function truncateStr(str, max) {
	if (str.length <= max) return str;
	if (max <= 1) return '…';
	return str.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Build truncated breadcrumb parts (note name + ancestor crumbs) that fit
 * within a character budget.
 * @param {string} noteName
 * @param {string[]} ancestors
 * @param {number} [budget=90]
 * @returns {{ noteName: string, crumbs: string[] }}
 */
export function truncateBreadcrumbs(noteName, ancestors, budget) {
	if (budget == null) budget = 90;
	// separator " > " costs 3 chars each
	const sepCost = (ancestors.length > 0 ? ancestors.length : 0) * 3;
	const available = Math.max(10, budget - sepCost);

	if (ancestors.length === 0) {
		return { noteName: truncateStr(noteName, available), crumbs: [] };
	}

	// Give note name ~30% of budget, rest shared among ancestors
	const noteMax = Math.max(8, Math.floor(available * 0.3));
	const truncatedNote = truncateStr(noteName, noteMax);
	const remaining = available - truncatedNote.length;
	const perCrumb = Math.max(6, Math.floor(remaining / ancestors.length));

	const crumbs = ancestors.map(a => truncateStr(a, perCrumb));
	return { noteName: truncatedNote, crumbs };
}

/**
 * Reconstruct an FSRS Card object from line item meta properties.
 * @param {PluginLineItem} lineItem
 * @returns {import('ts-fsrs').Card}
 */
export function metaToCard(lineItem) {
	const p = lineItem.props || {};
	return {
		due:            new Date(p[META.due]),
		stability:      Number(p[META.stability])      || 0,
		difficulty:     Number(p[META.difficulty])      || 0,
		elapsed_days:   Number(p[META.elapsed_days])    || 0,
		scheduled_days: Number(p[META.scheduled_days])  || 0,
		reps:           Number(p[META.reps])            || 0,
		lapses:         Number(p[META.lapses])          || 0,
		learning_steps: Number(p[META.learning_steps])  || 0,
		state:          Number(p[META.state])           || 0,
		last_review:    p[META.last_review] ? new Date(p[META.last_review]) : undefined,
	};
}

/**
 * Build the meta properties object from an FSRS Card (without persisting).
 * This is the pure, testable counterpart of cardToMeta.
 * @param {import('ts-fsrs').Card} card
 * @returns {Record<string, any>}
 */
export function cardToMetaProps(card) {
	return {
		[META.due]:            card.due.toISOString(),
		[META.stability]:      card.stability,
		[META.difficulty]:     card.difficulty,
		[META.elapsed_days]:   card.elapsed_days,
		[META.scheduled_days]: card.scheduled_days,
		[META.reps]:           card.reps,
		[META.lapses]:         card.lapses,
		[META.learning_steps]: card.learning_steps,
		[META.state]:          card.state,
		[META.last_review]:    card.last_review ? card.last_review.toISOString() : null,
	};
}

/**
 * Format a scheduled interval for display.
 * @param {import('ts-fsrs').Card} card
 * @returns {string}
 */
export function formatInterval(card) {
	const days = card.scheduled_days;
	if (days < 1) {
		// Compute from due and last_review (learning steps, minutes)
		if (card.last_review) {
			const mins = Math.round((card.due.getTime() - card.last_review.getTime()) / 60000);
			if (mins < 1) return '< 1m';
			if (mins < 60) return `${mins}m`;
			const hrs = Math.round(mins / 60);
			return `${hrs}h`;
		}
		return '< 1d';
	}
	if (days === 1) return '1d';
	if (days < 30) return `${days}d`;
	if (days < 365) {
		const months = Math.round(days / 30);
		return `${months}mo`;
	}
	const years = +(days / 365).toFixed(1);
	return `${years}y`;
}

/**
 * Format a date as "Mon DD, YYYY" (e.g. "Feb 10, 2026").
 * @param {Date} date
 * @returns {string}
 */
export function formatDueDate(date) {
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

/**
 * Format a date as "Day Mon DD, YYYY HH:MM" 24hr (e.g. "Tue Feb 10, 2026 16:00").
 * @param {Date} date
 * @returns {string}
 */
export function formatLastPracticed(date) {
	const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
	const monthDay = date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
	const time = date.toLocaleTimeString('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
	return `${dayName} ${monthDay} ${time}`;
}