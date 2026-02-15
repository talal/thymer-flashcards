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
const DASHBOARD_PANEL_ID = 'flashcard-dashboard';

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

/**
 * Format a date as "Mon DD, YYYY" (e.g. "Feb 10, 2026").
 * @param {Date} date
 * @returns {string}
 */
function _formatDueDate(date) {
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
function _formatLastPracticed(date) {
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


// ─── Plugin ─────────────────────────────────────────────────────────────────

export class Plugin extends AppPlugin {

	onLoad() {
		this.ui.injectCSS(css);
		this.ui.injectCSS(`
/* ── Flashcard Dashboard ────────────────────────────── */
.fc-dashboard-container {
	height: 100%;
	overflow-y: auto;
	padding: 32px 24px 40px;
	box-sizing: border-box;
	font-family: inherit;
	color: inherit;
	width: 100%;
	max-width: 100%;
}
.fc-dashboard-header {
	margin-bottom: 24px;
}
.fc-dashboard-title {
	font-size: 22px;
	font-weight: 700;
	margin-bottom: 4px;
}
.fc-dashboard-subtitle {
	font-size: 13px;
	opacity: 0.45;
}
.fc-dashboard-loading {
	font-size: 14px;
	opacity: 0.5;
	padding: 40px 0;
	text-align: center;
}
.fc-dashboard-table-wrap {
	border-radius: 8px;
	border: 1px solid rgba(128,128,128,0.18);
}
.fc-dashboard-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
}
.fc-dashboard-table thead th {
	text-align: left;
	font-weight: 600;
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	opacity: 0.45;
	padding: 10px 14px;
	border-bottom: 1px solid rgba(128,128,128,0.18);
	white-space: nowrap;
	position: sticky;
	top: 0;
}
.fc-dashboard-table tbody tr {
	border-bottom: 1px solid rgba(128,128,128,0.09);
	transition: background 0.12s ease;
}
.fc-dashboard-table tbody tr:last-child {
	border-bottom: none;
}
.fc-dashboard-table tbody tr:hover {
	background: rgba(128,128,128,0.06);
}
.fc-dashboard-table td {
	padding: 10px 14px;
	vertical-align: middle;
	line-height: 1.45;
}
.fc-dashboard-cell-note {
	white-space: nowrap;
}
.fc-dashboard-cell-front,
.fc-dashboard-cell-back {
	max-width: 0;
	width: 50%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.fc-dashboard-cell-front {
	font-weight: 500;
}
.fc-dashboard-cell-back {
	opacity: 0.7;
}
.fc-dashboard-cell-due,
.fc-dashboard-cell-reviews,
.fc-dashboard-cell-last {
	white-space: nowrap;
}
.fc-dashboard-note-link {
	color: #6ea8e4;
	text-decoration: none;
	font-weight: 500;
	cursor: pointer;
	white-space: nowrap;
}
.fc-dashboard-note-link:hover {
	text-decoration: underline;
	opacity: 0.85;
}
.fc-dashboard-badge-new {
	display: inline-block;
	padding: 2px 8px;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 600;
	background: rgba(80,145,220,0.15);
	color: #5091dc;
}
.fc-dashboard-badge-never {
	display: inline-block;
	padding: 2px 8px;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 600;
	background: rgba(128,128,128,0.12);
	opacity: 0.55;
}
.fc-dashboard-due-now {
	color: #dca032;
	font-weight: 600;
}
		`);

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Generate',
			icon: 'ti-flame',
			onSelected: () => this.generateFlashcards(),
		});

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Practice All Cards',
			icon: 'ti-flame',
			onSelected: () => this.practiceFlashcards(),
		});

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Practice This Note',
			icon: 'ti-flame',
			onSelected: () => this.practiceThisNote(),
		});

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Practice Collection',
			icon: 'ti-flame',
			onSelected: () => this.practiceCollection(),
		});

		this.ui.addCommandPaletteCommand({
			label: 'Flashcards: Dashboard',
			icon: 'ti-flame',
			onSelected: () => this.openDashboard(),
		});

		// Sidebar item — opens the dashboard
		this.ui.addSidebarItem({
			label: 'Flashcards',
			icon: 'ti-flame',
			tooltip: 'Flashcards Dashboard',
			onClick: () => this.openDashboard(),
		});

		// Register custom panel for practice UI
		this.ui.registerCustomPanelType(PANEL_ID, (panel) => {
			const title = this._practiceTitle || 'Practice Flashcards';
			panel.setTitle(title);
			this._renderPracticePanel(panel);
		});

		// Register custom panel for dashboard
		this.ui.registerCustomPanelType(DASHBOARD_PANEL_ID, (panel) => {
			panel.setTitle('Flashcards Dashboard');
			this._renderDashboardPanel(panel);
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

	// ── Dashboard ─────────────────────────────────────────────────────────

	async openDashboard() {
		const panel = this.ui.getActivePanel();
		if (panel) {
			panel.navigateToCustomType(DASHBOARD_PANEL_ID);
		}
	}

	/**
	 * Collect all generated flashcard line items (not just due ones).
	 * Only includes cards that have been initialized via "Flashcards: Generate".
	 * @returns {Promise<Array<{ lineItem: PluginLineItem, card: import('ts-fsrs').Card, question: string, answer: string, recordName: string, recordGuid: string }>>}
	 */
	async _collectAllCards() {
		const allRecords = this.data.getAllRecords();
		const allCards = [];

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
				allCards.push({
					lineItem: li,
					card,
					question: fc.question,
					answer: fc.answer,
					recordName: record.getName(),
					recordGuid: record.guid,
				});
			}
		}

		return allCards;
	}

	/**
	 * @param {PluginPanel} panel
	 */
	async _renderDashboardPanel(panel) {
		const el = panel.getElement();
		if (!el) return;

		el.innerHTML = '';
		const container = document.createElement('div');
		container.className = 'fc-dashboard-container';
		el.appendChild(container);

		// Loading state
		container.innerHTML = `
			<div class="fc-dashboard-header">
				<div class="fc-dashboard-title">📋 Flashcards Dashboard</div>
			</div>
			<div class="fc-dashboard-loading">Loading flashcards…</div>
		`;

		const allCards = await this._collectAllCards();

		container.innerHTML = '';

		// Header
		const header = document.createElement('div');
		header.className = 'fc-dashboard-header';
		header.innerHTML = `
			<div class="fc-dashboard-title">📋 Flashcards Dashboard</div>
			<div class="fc-dashboard-subtitle">${allCards.length} flashcard${allCards.length !== 1 ? 's' : ''} found</div>
		`;
		container.appendChild(header);

		if (allCards.length === 0) {
			container.innerHTML += `
				<div class="flashcard-empty">
					<div class="flashcard-empty-emoji">📭</div>
					<div class="flashcard-empty-title">No flashcards found</div>
					<div class="flashcard-empty-subtitle">
						Use <strong>Flashcards: Generate</strong> to scan your notes,<br>
						or write cards with the <code>${esc(SEPARATOR)}</code> syntax:<br>
						<code>Question ${esc(SEPARATOR)} Answer</code>
					</div>
				</div>
			`;
			return;
		}

		// Table
		const tableWrap = document.createElement('div');
		tableWrap.className = 'fc-dashboard-table-wrap';

		const table = document.createElement('table');
		table.className = 'fc-dashboard-table';
		table.innerHTML = `
			<thead>
				<tr>
					<th class="fc-dashboard-cell-note">Parent Note</th>
					<th class="fc-dashboard-cell-front">Front</th>
					<th class="fc-dashboard-cell-back">Back</th>
					<th class="fc-dashboard-cell-due">Due</th>
					<th class="fc-dashboard-cell-reviews">Reviews</th>
					<th class="fc-dashboard-cell-last">Last Practiced</th>
				</tr>
			</thead>
		`;

		const tbody = document.createElement('tbody');

		for (const entry of allCards) {
			const tr = document.createElement('tr');

			// Parent Note (clickable)
			const tdNote = document.createElement('td');
			tdNote.className = 'fc-dashboard-cell-note';
			const noteLink = document.createElement('a');
			noteLink.className = 'fc-dashboard-note-link';
			noteLink.textContent = entry.recordName;
			noteLink.href = '#';
			noteLink.addEventListener('click', async (e) => {
				e.preventDefault();
				const wsGuid = this.getWorkspaceGuid();
				const newPanel = await this.ui.createPanel({ afterPanel: panel });
				if (newPanel) {
					setTimeout(() => {
						newPanel.navigateTo({
							type: 'edit_panel',
							rootId: entry.recordGuid,
							subId: null,
							workspaceGuid: wsGuid,
						});
					}, 0);
				}
			});
			tdNote.appendChild(noteLink);
			tr.appendChild(tdNote);

			// Front
			const tdFront = document.createElement('td');
			tdFront.className = 'fc-dashboard-cell-front';
			tdFront.textContent = entry.question;
			tr.appendChild(tdFront);

			// Back
			const tdBack = document.createElement('td');
			tdBack.className = 'fc-dashboard-cell-back';
			tdBack.textContent = entry.answer;
			tr.appendChild(tdBack);

			// Due
			const tdDue = document.createElement('td');
			tdDue.className = 'fc-dashboard-cell-due';
			const dueDate = entry.card.due;
			if (entry.card.state === 0 && entry.card.reps === 0) {
				tdDue.innerHTML = '<span class="fc-dashboard-badge-new">New</span>';
			} else {
				tdDue.textContent = _formatDueDate(dueDate);
				if (dueDate <= new Date()) {
					tdDue.classList.add('fc-dashboard-due-now');
				}
			}
			tr.appendChild(tdDue);

			// Reviews
			const tdReviews = document.createElement('td');
			tdReviews.className = 'fc-dashboard-cell-reviews';
			tdReviews.textContent = String(entry.card.reps);
			tr.appendChild(tdReviews);

			// Last Practiced
			const tdLastPracticed = document.createElement('td');
			tdLastPracticed.className = 'fc-dashboard-cell-last';
			if (entry.card.last_review) {
				tdLastPracticed.textContent = _formatLastPracticed(entry.card.last_review);
			} else {
				tdLastPracticed.innerHTML = '<span class="fc-dashboard-badge-never">Never</span>';
			}
			tr.appendChild(tdLastPracticed);

			tbody.appendChild(tr);
		}

		table.appendChild(tbody);
		tableWrap.appendChild(table);
		container.appendChild(tableWrap);
	}

	// ── Practice flashcards ───────────────────────────────────────────────

	/**
	 * Start a practice session with optional title and filter context.
	 * @param {object} [opts]
	 * @param {Set<string>} [opts.recordGuids] - if provided, only practice cards from these records
	 * @param {string} [opts.title] - custom panel title
	 */
	async _startPracticeSession({ recordGuids, title } = {}) {
		const due = await this._collectDueCards({ recordGuids });

		this._dueCards = due;
		this._practiceIndex = 0;
		this._practiceRevealed = false;
		this._practiceStats = { again: 0, hard: 0, good: 0, easy: 0 };
		this._practiceTitle = title || 'Practice Flashcards';
		this._practiceRecordGuids = recordGuids || null;

		// Navigate current panel to practice UI
		const panel = this.ui.getActivePanel();
		if (panel) {
			panel.navigateToCustomType(PANEL_ID);
		}
	}

	async practiceFlashcards() {
		await this._startPracticeSession();
	}

	// ── Practice this note ────────────────────────────────────────────────

	async practiceThisNote() {
		const panel = this.ui.getActivePanel();
		if (!panel) return;

		const record = panel.getActiveRecord();
		if (!record) {
			this.ui.addToaster({
				title: 'No active note',
				message: 'Open a note first, then run "Flashcards: Practice This Note".',
				dismissible: true,
				autoDestroyTime: 4000,
			});
			return;
		}

		const recordGuids = new Set([record.guid]);
		const title = `Practice: ${record.getName()}`;
		await this._startPracticeSession({ recordGuids, title });
	}

	// ── Practice collection ───────────────────────────────────────────────

	async practiceCollection() {
		const panel = this.ui.getActivePanel();
		if (!panel) return;

		// First check if the active panel is showing a collection view
		let collection = panel.getActiveCollection();

		if (!collection) {
			// Not on a collection view — offer a picker from all collections
			const allCollections = await this.data.getAllCollections();
			if (!allCollections || allCollections.length === 0) {
				this.ui.addToaster({
					title: 'No collections found',
					message: 'Create a collection first, or navigate to one.',
					dismissible: true,
					autoDestroyTime: 4000,
				});
				return;
			}

			// Invisible anchor element positioned at screen centre for the dropdown
			const dummyBtn = document.createElement('button');
			dummyBtn.style.position = 'fixed';
			dummyBtn.style.left = '50%';
			dummyBtn.style.top = '50%';
			dummyBtn.style.transform = 'translate(-50%, -50%)';
			dummyBtn.style.width = '0';
			dummyBtn.style.height = '0';
			dummyBtn.style.opacity = '0';
			dummyBtn.style.pointerEvents = 'none';
			document.body.appendChild(dummyBtn);

			// Outside-click handler (declared as let so cleanup can reference it)
			let onOutsideClick = null;
			let dropdown = null;

			// Helper to tear down the anchor button and listener
			const cleanupAnchor = () => {
				if (dummyBtn.parentNode) dummyBtn.remove();
				if (onOutsideClick) {
					document.removeEventListener('mousedown', onOutsideClick, true);
				}
			};

			// Build dropdown options — each cleans up the anchor after selecting
			const options = allCollections.map(c => ({
				label: c.getName(),
				onSelected: () => {
					cleanupAnchor();
					this._practiceCollectionByRef(c);
				},
			}));

			dropdown = this.ui.createDropdown({
				attachedTo: dummyBtn,
				options,
				inputPlaceholder: 'Pick a collection…',
				width: 320,
			});

			// If the user clicks outside the dropdown, tear everything down
			onOutsideClick = (e) => {
				// Give the dropdown a frame to handle its own click
				requestAnimationFrame(() => {
					// If the anchor is already gone an onSelected handler fired
					if (!dummyBtn.parentNode) return;
					cleanupAnchor();
					dropdown.destroy();
				});
			};
			// Delay attaching so the current click doesn't immediately dismiss
			requestAnimationFrame(() => {
				document.addEventListener('mousedown', onOutsideClick, true);
			});

			return;
		}

		await this._practiceCollectionByRef(collection);
	}

	/**
	 * Start a practice session scoped to a specific collection.
	 * @param {PluginCollectionAPI} collection
	 */
	async _practiceCollectionByRef(collection) {
		const records = await collection.getAllRecords();
		if (!records || records.length === 0) {
			this.ui.addToaster({
				title: 'No records in collection',
				message: `"${collection.getName()}" has no notes.`,
				dismissible: true,
				autoDestroyTime: 4000,
			});
			return;
		}

		const recordGuids = new Set(records.map(r => r.guid));
		const title = `Practice: ${collection.getName()}`;
		await this._startPracticeSession({ recordGuids, title });
	}

	/**
	 * Collect flashcard line items that are due for review.
	 * @param {object} [opts]
	 * @param {Set<string>} [opts.recordGuids] - if provided, only include cards from these records
	 * @returns {Promise<Array<{ lineItem: PluginLineItem, card: import('ts-fsrs').Card, question: string, answer: string, recordName: string }>>}
	 */
	async _collectDueCards({ recordGuids } = {}) {
		const now = new Date();
		const allRecords = this.data.getAllRecords();
		const dueCards = [];

		for (const record of allRecords) {
			// Skip records not in the filter set (if provided)
			if (recordGuids && !recordGuids.has(record.guid)) continue;

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
			this._dueCards = await this._collectDueCards({ recordGuids: this._practiceRecordGuids });
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

		// Scope subtitle (shown when practicing a specific note or collection)
		const scopeTitle = this._practiceTitle && this._practiceTitle !== 'Practice Flashcards'
			? this._practiceTitle.replace(/^Practice:\s*/, '')
			: null;
		const scopeHTML = scopeTitle
			? `<div class="flashcard-scope" style="text-align:center;opacity:0.5;font-size:13px;margin-bottom:8px;">Scope: <strong>${esc(scopeTitle)}</strong></div>`
			: '';

		// No cards due
		if (total === 0) {
			container.innerHTML = `
				<div class="flashcard-empty">
					<div class="flashcard-empty-emoji">🎉</div>
					<div class="flashcard-empty-title">No flashcards due</div>
					${scopeHTML}
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
					${scopeHTML}
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
					Click the card or press <kbd>Space</kbd> to reveal answer
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

		// Session complete screen — Space closes the panel
		if (idx >= cards.length) {
			if (e.code === 'Space' || e.key === ' ') {
				e.preventDefault();
				const p = this._panel;
				this._cleanup();
				if (p) this.ui.closePanel(p);
			}
			return;
		}

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
		this._practiceTitle = null;
		this._practiceRecordGuids = null;
		this._panelEl = null;
		this._panel = null;
	}

	onUnload() {
		this._cleanup();
	}
}