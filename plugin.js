import { fsrs, createEmptyCard, Rating, State } from 'ts-fsrs';
import css from './styles.css';

// ─── FSRS instance with good defaults ───────────────────────────────────────
const f = fsrs({
	request_retention: 0.9,
	maximum_interval: 365,
	enable_fuzz: true,
	enable_short_term: true,
});

// ─── Constants ──────────────────────────────────────────────────────────────
const SEPARATOR = '::';
const META_PREFIX = 'fc_';
const PANEL_ID = 'flashcard-practice';

// Meta property keys stored on each flashcard line item
const META = {
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
function segmentsToText(segments) {
	if (!segments || !segments.length) return '';
	return segments.map(s => s.text || '').join('');
}

/**
 * Try to parse a flashcard from a line item's text.
 * Returns { question, answer } or null.
 * @param {PluginLineItem} lineItem
 * @returns {{ question: string, answer: string } | null}
 */
function parseFlashcard(lineItem) {
	const text = segmentsToText(lineItem.segments);
	const idx = text.indexOf(SEPARATOR);
	if (idx === -1) return null;

	const question = text.slice(0, idx).trim();
	const answer = text.slice(idx + SEPARATOR.length).trim();
	if (!question || !answer) return null;

	return { question, answer };
}

/**
 * Check whether a line item already has FSRS metadata.
 * @param {PluginLineItem} lineItem
 * @returns {boolean}
 */
function hasCardMeta(lineItem) {
	return lineItem.props && lineItem.props[META.due] != null;
}

/**
 * Reconstruct an FSRS Card object from line item meta properties.
 * @param {PluginLineItem} lineItem
 * @returns {import('ts-fsrs').Card}
 */
function metaToCard(lineItem) {
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
		state:          Number(p[META.state])           ?? State.New,
		last_review:    p[META.last_review] ? new Date(p[META.last_review]) : undefined,
	};
}

/**
 * Persist an FSRS Card back to line item meta properties.
 * @param {PluginLineItem} lineItem
 * @param {import('ts-fsrs').Card} card
 * @returns {Promise<boolean>}
 */
function cardToMeta(lineItem, card) {
	return lineItem.setMetaProperties({
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
	});
}

/**
 * Format a scheduled interval for display.
 * @param {import('ts-fsrs').Card} card
 * @returns {string}
 */
function formatInterval(card) {
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
 * Escape HTML.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
	const el = document.createElement('span');
	el.textContent = str;
	return el.innerHTML;
}


// ─── Plugin ─────────────────────────────────────────────────────────────────

export class Plugin extends AppPlugin {

	onLoad() {
		this.ui.injectCSS(css);

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Generate',
			icon: 'books',
			onSelected: () => this.generateFlashcards(),
		});

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Practice',
			icon: 'books',
			onSelected: () => this.practiceFlashcards(),
		});

		// Register custom panel for practice UI
		this.ui.registerCustomPanelType(PANEL_ID, (panel) => {
			panel.setTitle('Practice Flashcards');
			this._renderPracticePanel(panel);
		});
	}

	// ── Generate flashcards ───────────────────────────────────────────────

	async generateFlashcards() {
		const allRecords = this.data.getAllRecords();
		let created = 0;
		let existing = 0;
		let scanned = 0;

		for (const record of allRecords) {
			/** @type {PluginLineItem[]} */
			let lineItems;
			try {
				lineItems = await record.getLineItems();
			} catch {
				continue;
			}

			for (const li of lineItems) {
				const fc = parseFlashcard(li);
				if (!fc) continue;

				scanned++;

				if (hasCardMeta(li)) {
					existing++;
				} else {
					// Initialize new FSRS card
					const card = createEmptyCard(new Date());
					await cardToMeta(li, card);
					created++;
				}
			}
		}

		this.ui.addToaster({
			title: 'Flashcards generated',
			message: `Scanned ${allRecords.length} notes. Found ${scanned} flashcards: ${created} new, ${existing} already tracked.`,
			dismissible: true,
			autoDestroyTime: 5000,
		});
	}

	// ── Practice flashcards ───────────────────────────────────────────────

	async practiceFlashcards() {
		// Collect all due flashcards
		const due = await this._collectDueCards();

		this._dueCards = due;
		this._practiceIndex = 0;
		this._practiceRevealed = false;
		this._practiceStats = { again: 0, hard: 0, good: 0, easy: 0 };

		// Navigate current panel to practice UI
		const panel = this.ui.getActivePanel();
		if (panel) {
			panel.navigateToCustomType(PANEL_ID);
		}
	}

	/**
	 * Collect flashcard line items that are due for review.
	 * @returns {Promise<Array<{ lineItem: PluginLineItem, card: import('ts-fsrs').Card, question: string, answer: string, recordName: string }>>}
	 */
	async _collectDueCards() {
		const now = new Date();
		const allRecords = this.data.getAllRecords();
		const dueCards = [];

		for (const record of allRecords) {
			let lineItems;
			try {
				lineItems = await record.getLineItems();
			} catch {
				continue;
			}

			for (const li of lineItems) {
				const fc = parseFlashcard(li);
				if (!fc) continue;
				if (!hasCardMeta(li)) continue;

				const card = metaToCard(li);
				if (card.due <= now) {
					dueCards.push({
						lineItem: li,
						card,
						question: fc.question,
						answer: fc.answer,
						recordName: record.getName(),
					});
				}
			}
		}

		// Sort: oldest due first
		dueCards.sort((a, b) => a.card.due.getTime() - b.card.due.getTime());
		return dueCards;
	}

	// ── Render practice panel ─────────────────────────────────────────────

	/**
	 * @param {PluginPanel} panel
	 */
	async _renderPracticePanel(panel) {
		const el = panel.getElement();
		if (!el) return;

		// Fetch due cards if we don't have them yet (e.g., panel restored)
		if (!this._dueCards) {
			this._dueCards = await this._collectDueCards();
			this._practiceIndex = 0;
			this._practiceRevealed = false;
			this._practiceStats = { again: 0, hard: 0, good: 0, easy: 0 };
		}

		const cards = this._dueCards;
		const container = document.createElement('div');
		container.className = 'flashcard-container';
		el.innerHTML = '';
		el.appendChild(container);

		// Keyboard handler
		this._keyHandler = (e) => this._handleKey(e, panel);
		document.addEventListener('keydown', this._keyHandler);

		this._panelEl = container;
		this._panel = panel;
		this._renderCurrentCard();
	}

	_renderCurrentCard() {
		const container = this._panelEl;
		if (!container) return;

		const cards = this._dueCards || [];
		const idx = this._practiceIndex || 0;
		const total = cards.length;

		container.innerHTML = '';

		// No cards due
		if (total === 0) {
			container.innerHTML = `
				<div class="flashcard-empty">
					<div class="flashcard-empty-emoji">🎉</div>
					<div class="flashcard-empty-title">No flashcards due</div>
					<div class="flashcard-empty-subtitle">
						All caught up! Come back later, or use<br>
						<strong>Flashcards: Generate</strong> to scan your notes for new cards.
						<br><br>
						Use the <code>${esc(SEPARATOR)}</code> syntax in your notes:<br>
						<code>Question ${esc(SEPARATOR)} Answer</code>
					</div>
				</div>
			`;
			return;
		}

		// All done
		if (idx >= total) {
			const stats = this._practiceStats;
			container.innerHTML = `
				<div class="flashcard-done">
					<div class="flashcard-done-emoji">✅</div>
					<div class="flashcard-done-title">Session complete!</div>
					<div class="flashcard-done-subtitle">You reviewed ${total} card${total !== 1 ? 's' : ''}.</div>
					<div class="flashcard-done-stats">
						<div class="flashcard-stat flashcard-stat--again">
							<div class="flashcard-stat-value">${stats.again}</div>
							<div class="flashcard-stat-label">Again</div>
						</div>
						<div class="flashcard-stat flashcard-stat--hard">
							<div class="flashcard-stat-value">${stats.hard}</div>
							<div class="flashcard-stat-label">Hard</div>
						</div>
						<div class="flashcard-stat flashcard-stat--good">
							<div class="flashcard-stat-value">${stats.good}</div>
							<div class="flashcard-stat-label">Good</div>
						</div>
						<div class="flashcard-stat flashcard-stat--easy">
							<div class="flashcard-stat-value">${stats.easy}</div>
							<div class="flashcard-stat-label">Easy</div>
						</div>
					</div>
					<button class="flashcard-close-btn" id="fc-close">Close</button>
				</div>
			`;
			container.querySelector('#fc-close')?.addEventListener('click', () => {
				const panel = this._panel;
				this._cleanup();
				if (panel) this.ui.closePanel(panel);
			});
			return;
		}

		// Show current card
		const entry = cards[idx];
		const revealed = this._practiceRevealed;

		// Progress
		const progressPct = Math.round((idx / total) * 100);
		const progressHTML = `
			<div class="flashcard-progress">
				<div class="flashcard-progress-text">${idx + 1} / ${total}</div>
				<div class="flashcard-progress-bar">
					<div class="flashcard-progress-fill" style="width: ${progressPct}%"></div>
				</div>
			</div>
		`;

		// Card face
		let cardInner = `
			<div class="flashcard-source">${esc(entry.recordName)}</div>
			<div class="flashcard-question">${esc(entry.question)}</div>
		`;

		if (revealed) {
			cardInner += `
				<div class="flashcard-divider"></div>
				<div class="flashcard-answer">${esc(entry.answer)}</div>
			`;
		} else {
			cardInner += `
				<div class="flashcard-reveal-hint">Click or press Space to reveal</div>
			`;
		}

		let buttonsHTML = '';
		if (revealed) {
			// Compute preview to get intervals
			const preview = f.repeat(entry.card, new Date());
			const againCard = preview[Rating.Again].card;
			const hardCard  = preview[Rating.Hard].card;
			const goodCard  = preview[Rating.Good].card;
			const easyCard  = preview[Rating.Easy].card;

			buttonsHTML = `
				<div class="flashcard-buttons">
					<button class="flashcard-btn flashcard-btn--again" data-grade="1">
						<span class="flashcard-btn-label">Again</span>
						<span class="flashcard-btn-interval">${formatInterval(againCard)}</span>
					</button>
					<button class="flashcard-btn flashcard-btn--hard" data-grade="2">
						<span class="flashcard-btn-label">Hard</span>
						<span class="flashcard-btn-interval">${formatInterval(hardCard)}</span>
					</button>
					<button class="flashcard-btn flashcard-btn--good" data-grade="3">
						<span class="flashcard-btn-label">Good</span>
						<span class="flashcard-btn-interval">${formatInterval(goodCard)}</span>
					</button>
					<button class="flashcard-btn flashcard-btn--easy" data-grade="4">
						<span class="flashcard-btn-label">Easy</span>
						<span class="flashcard-btn-interval">${formatInterval(easyCard)}</span>
					</button>
				</div>
				<div class="flashcard-shortcuts">
					<kbd>1</kbd> Again &nbsp; <kbd>2</kbd> Hard &nbsp; <kbd>3</kbd> Good &nbsp; <kbd>4</kbd> Easy
				</div>
			`;
		} else {
			buttonsHTML = `
				<div class="flashcard-shortcuts">
					<kbd>Space</kbd> Reveal answer
				</div>
			`;
		}

		container.innerHTML = `
			${progressHTML}
			<div class="flashcard-card" id="fc-card">
				${cardInner}
			</div>
			${buttonsHTML}
		`;

		// Event listeners
		if (!revealed) {
			container.querySelector('#fc-card')?.addEventListener('click', () => {
				this._practiceRevealed = true;
				this._renderCurrentCard();
			});
		}

		container.querySelectorAll('.flashcard-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				const grade = Number(btn.getAttribute('data-grade'));
				if (grade >= 1 && grade <= 4) {
					this._rateCard(grade);
				}
			});
		});
	}

	/**
	 * Handle keyboard input during practice.
	 * @param {KeyboardEvent} e
	 * @param {PluginPanel} panel
	 */
	_handleKey(e, panel) {
		// Ignore if not our panel that's active
		if (!panel.isActive()) return;

		const cards = this._dueCards || [];
		const idx = this._practiceIndex || 0;
		if (idx >= cards.length) return;

		if (!this._practiceRevealed) {
			if (e.code === 'Space' || e.key === ' ') {
				e.preventDefault();
				this._practiceRevealed = true;
				this._renderCurrentCard();
			}
		} else {
			const keyMap = { '1': Rating.Again, '2': Rating.Hard, '3': Rating.Good, '4': Rating.Easy };
			const grade = keyMap[e.key];
			if (grade) {
				e.preventDefault();
				this._rateCard(grade);
			}
		}
	}

	/**
	 * Apply a rating to the current card and advance.
	 * @param {import('ts-fsrs').Grade} grade
	 */
	async _rateCard(grade) {
		const cards = this._dueCards || [];
		const idx = this._practiceIndex || 0;
		if (idx >= cards.length) return;

		const entry = cards[idx];
		const now = new Date();

		// Apply FSRS
		const result = f.next(entry.card, now, grade);
		const newCard = result.card;

		// Persist to line item
		await cardToMeta(entry.lineItem, newCard);

		// Update stats
		const statKey = { [Rating.Again]: 'again', [Rating.Hard]: 'hard', [Rating.Good]: 'good', [Rating.Easy]: 'easy' };
		if (this._practiceStats && statKey[grade]) {
			this._practiceStats[statKey[grade]]++;
		}

		// Advance
		this._practiceIndex = idx + 1;
		this._practiceRevealed = false;
		this._renderCurrentCard();
	}

	/**
	 * Clean up event listeners and state.
	 */
	_cleanup() {
		if (this._keyHandler) {
			document.removeEventListener('keydown', this._keyHandler);
			this._keyHandler = null;
		}
		this._dueCards = null;
		this._practiceIndex = 0;
		this._practiceRevealed = false;
		this._practiceStats = null;
		this._panelEl = null;
		this._panel = null;
	}

	onUnload() {
		this._cleanup();
	}
}