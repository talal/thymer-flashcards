import { fsrs, Rating } from 'ts-fsrs';
import css from './styles.css';
import { CardRepository } from './card-repository.js';
import {
	SEPARATOR,
	truncateBreadcrumbs,
	cardToMetaProps,
	formatInterval,
	formatDueDate,
	formatLastPracticed,
} from './lib.js';

// ─── FSRS instance with good defaults ───────────────────────────────────────
const f = fsrs({
	request_retention: 0.9,
	maximum_interval: 365,
	enable_fuzz: true,
	enable_short_term: true,
});

// ─── Constants ──────────────────────────────────────────────────────────────
const PANEL_ID = 'flashcard-practice';
const DASHBOARD_PANEL_ID = 'flashcard-dashboard';

// ─── Helpers (DOM-dependent, kept in plugin.js) ─────────────────────────────

/**
 * Persist an FSRS Card back to line item meta properties.
 * @param {PluginLineItem} lineItem
 * @param {import('ts-fsrs').Card} card
 * @returns {Promise<boolean>}
 */
function cardToMeta(lineItem, card) {
	return lineItem.setMetaProperties(cardToMetaProps(card));
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
	/** @type {CardRepository} */
	_repository = /** @type {any} */ (null);
	/** @type {Promise<any>} */
	_repositoryReady = Promise.resolve();
	/** @type {PluginPanel | null} */
	_dashboardPanel = null;
	/** @type {ReturnType<typeof setTimeout> | null} */
	_dashboardRefreshTimer = null;
	/** @type {number} */
	_dashboardRenderGeneration = 0;
	/** @type {string[]} */
	_panelEventHandlerIds = [];
	/** @type {Map<string, Promise<void>>} */
	_cardWriteChains = new Map();
	/** @type {{ remove: () => void, refresh: () => void } | null} */
	_sidebarWidget = null;
	/** @type {boolean} */
	_ratingInProgress = false;
	/** @type {any[] | null} */
	_dueCards = null;
	/** @type {number} */
	_practiceIndex = 0;
	/** @type {boolean} */
	_practiceRevealed = false;
	/** @type {Record<string, number> | null} */
	_practiceStats = null;
	/** @type {string | null} */
	_practiceTitle = null;
	/** @type {Set<string> | null} */
	_practiceRecordGuids = null;
	/** @type {PluginPanel | null} */
	_panel = null;
	/** @type {HTMLElement | null} */
	_panelEl = null;
	/** @type {((event: KeyboardEvent) => void) | null} */
	_keyHandler = null;

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
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 16px;
}
.fc-dashboard-header-left {
	display: flex;
	flex-direction: column;
}
.fc-dashboard-title {
	font-size: 22px;
	font-weight: 700;
}
.fc-dashboard-subtitle {
	font-size: 13px;
	opacity: 0.45;
	margin-top: 6px;
}
.fc-dashboard-header-actions {
	display: flex;
	gap: 8px;
	flex-shrink: 0;
}
.fc-dashboard-scan-btn {
	padding: 8px 16px;
	border-radius: 8px;
	border: 1px solid rgba(128,128,128,0.25);
	background: transparent;
	cursor: pointer;
	font-size: 13px;
	font-weight: 500;
	font-family: inherit;
	color: inherit;
	white-space: nowrap;
	transition: background 0.15s ease, border-color 0.15s ease;
}
.fc-dashboard-scan-btn:hover {
	background: rgba(128,128,128,0.12);
	border-color: rgba(128,128,128,0.45);
}
.fc-dashboard-scan-btn:active {
	transform: scale(0.97);
}
.fc-dashboard-practice-btn {
	padding: 8px 16px;
	border-radius: 8px;
	border: 1px solid rgba(70,180,100,0.35);
	background: transparent;
	cursor: pointer;
	font-size: 13px;
	font-weight: 600;
	font-family: inherit;
	color: #46b464;
	white-space: nowrap;
	transition: background 0.15s ease, border-color 0.15s ease;
}
.fc-dashboard-practice-btn:hover {
	background: rgba(70,180,100,0.12);
	border-color: rgba(70,180,100,0.6);
}
.fc-dashboard-practice-btn:active {
	transform: scale(0.97);
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
			label: 'Flashcards: Refresh Cards',
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

		this._repository = new CardRepository({
			data: this.data,
			events: this.events,
			onChanged: () => this._handleRepositoryChanged(),
		});
		this._sidebarWidget = this.ui.addSidebarWidget(container => this._renderSidebarWidget(container));

		this._repositoryReady = this._repository.start().catch(error => {
			console.error('Flashcards: initial indexing failed', error);
			this.ui.addToaster({
				title: 'Flashcard indexing failed',
				message: 'Use “Flashcards: Refresh Cards” to try again.',
				dismissible: true,
				autoDestroyTime: 5000,
			});
		});

		if (this.events) {
			this._panelEventHandlerIds.push(
				this.events.on('panel.navigated', event => this._onPanelLifecycle(event, false)),
				this.events.on('panel.closed', event => this._onPanelLifecycle(event, true)),
			);
		}
	}

	/**
	 * @param {PluginEventPanel} event
	 * @param {boolean} closed
	 */
	_onPanelLifecycle(event, closed) {
		const panelId = event.panel.getId();
		if (this._panel?.getId() === panelId && (closed || event.panel.getType() !== PANEL_ID)) {
			this._cleanup();
		}
		if (this._dashboardPanel?.getId() === panelId &&
			(closed || event.panel.getType() !== DASHBOARD_PANEL_ID)) {
			this._dashboardPanel = null;
		}
	}

	// ── Refresh flashcards ────────────────────────────────────────────────

	async generateFlashcards() {
		const stats = await this._repository.generate();
		this.ui.addToaster({
			title: 'Flashcards refreshed',
			message: `Scanned ${stats.records} notes. Found ${stats.found} flashcards: ${stats.created} new, ${stats.existing} already tracked.`,
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

	_handleRepositoryChanged() {
		this._scheduleDashboardRefresh();
		this._sidebarWidget?.refresh();
	}

	/** @param {HTMLElement} container */
	_renderSidebarWidget(container) {
		const cards = this._repository.getAllCards();
		const due = this._repository.getDueCards().length;
		container.innerHTML = `
			<div class="fc-sidebar-summary">
				<div class="fc-sidebar-summary-counts">
					<strong>${due}</strong> due <span>·</span> ${cards.length} total
				</div>
				<div class="fc-sidebar-summary-actions">
					<button type="button" data-action="dashboard">Dashboard</button>
					<button type="button" data-action="study" ${due === 0 ? 'disabled' : ''}>Study</button>
				</div>
			</div>
		`;
		const openDashboard = () => this.openDashboard();
		const startStudy = () => this._startPracticeSession();
		container.querySelector('[data-action="dashboard"]')?.addEventListener('click', openDashboard);
		container.querySelector('[data-action="study"]')?.addEventListener('click', startStudy);
		return () => {
			container.querySelector('[data-action="dashboard"]')?.removeEventListener('click', openDashboard);
			container.querySelector('[data-action="study"]')?.removeEventListener('click', startStudy);
		};
	}

	_scheduleDashboardRefresh() {
		if (!this._dashboardPanel || this._dashboardRefreshTimer != null) return;
		this._dashboardRefreshTimer = setTimeout(() => {
			this._dashboardRefreshTimer = null;
			const panel = this._dashboardPanel;
			const element = panel?.getElement();
			if (panel && element?.isConnected && panel.getType() === DASHBOARD_PANEL_ID) {
				this._renderDashboardPanel(panel);
			}
		}, 100);
	}

	/**
	 * Collect all generated flashcard line items (not just due ones).
	 * Cards are initialized automatically during indexing and refresh.
	 * @returns {Promise<any[]>}
	 */
	async _collectAllCards() {
		await this._repository.whenReady();
		return this._repository.getAllCards();
	}

	/**
	 * @param {PluginPanel} panel
	 */
	async _renderDashboardPanel(panel) {
		const el = panel.getElement();
		if (!el) return;
		this._dashboardPanel = panel;
		const renderGeneration = this._dashboardRenderGeneration + 1;
		this._dashboardRenderGeneration = renderGeneration;

		el.innerHTML = '';
		const container = document.createElement('div');
		container.className = 'fc-dashboard-container';
		el.appendChild(container);

		// Loading state
		container.innerHTML = `
			<div class="fc-dashboard-header">
				<div class="fc-dashboard-header-left">
					<div class="fc-dashboard-title">Flashcards Dashboard</div>
				</div>
			</div>
			<div class="fc-dashboard-loading">Loading flashcards…</div>
		`;

		const allCards = await this._collectAllCards();
		if (this._dashboardRenderGeneration !== renderGeneration || !container.isConnected) return;

		container.innerHTML = '';

		// Count due today
		const now = new Date();
		const dueCount = allCards.filter(e => e.card.due <= now).length;

		// Header
		const header = document.createElement('div');
		header.className = 'fc-dashboard-header';
		header.innerHTML = `
			<div class="fc-dashboard-header-left">
				<div class="fc-dashboard-title">Flashcards Dashboard</div>
				<div class="fc-dashboard-subtitle">Total flashcards: ${allCards.length}</div>
			</div>
			<div class="fc-dashboard-header-actions">
				<button class="fc-dashboard-scan-btn" id="fc-dashboard-scan-btn">Refresh Cards</button>
				<button class="fc-dashboard-practice-btn" id="fc-dashboard-practice-btn">Practice Today's Cards (${dueCount})</button>
			</div>
		`;
		container.appendChild(header);

		// Scan button click handler — generate then re-render dashboard
		header.querySelector('#fc-dashboard-scan-btn')?.addEventListener('click', async () => {
			await this.generateFlashcards();
			this._renderDashboardPanel(panel);
		});

		// Practice button click handler
		header.querySelector('#fc-dashboard-practice-btn')?.addEventListener('click', () => {
			this._startPracticeSession();
		});

		if (allCards.length === 0) {
			container.innerHTML += `
				<div class="flashcard-empty">
					<div class="flashcard-empty-emoji">📭</div>
					<div class="flashcard-empty-title">No flashcards found</div>
					<div class="flashcard-empty-subtitle">
						Write a card in any note using the <code>${esc(SEPARATOR)}</code> syntax:<br>
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
				const newPanel = await this.ui.createPanel({ afterPanel: panel });
				if (newPanel) {
					setTimeout(() => {
						newPanel.navigateTo({
														type: 'edit_panel', rootId: null, subId: null, workspaceGuid: null,
														itemGuid: entry.lineItemGuid, highlight: true,
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
			tdBack.textContent = entry.answerLines && entry.answerLines.length > 1
				? entry.answerLines[0].text + ' …'
				: entry.answer;
			tr.appendChild(tdBack);

			// Due
			const tdDue = document.createElement('td');
			tdDue.className = 'fc-dashboard-cell-due';
			const dueDate = entry.card.due;
			if (entry.card.state === 0 && entry.card.reps === 0) {
				tdDue.innerHTML = '<span class="fc-dashboard-badge-new">New</span>';
			} else {
				tdDue.textContent = formatDueDate(dueDate);
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
				tdLastPracticed.textContent = formatLastPracticed(entry.card.last_review);
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
			/** @type {((event: MouseEvent) => void) | null} */
			let onOutsideClick = null;
			/** @type {PluginDropdown | null} */
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
			onOutsideClick = (_e) => {
				// Give the dropdown a frame to handle its own click
				requestAnimationFrame(() => {
					// If the anchor is already gone an onSelected handler fired
					if (!dummyBtn.parentNode) return;
					cleanupAnchor();
					dropdown?.destroy();
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
	 * @returns {Promise<any[]>}
	 */
	async _collectDueCards({ recordGuids } = {}) {
		await this._repository.whenReady();
		return this._repository.getDueCards({ recordGuids });
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
			this._dueCards = await this._collectDueCards({ recordGuids: this._practiceRecordGuids || undefined });
			this._practiceIndex = 0;
			this._practiceRevealed = false;
			this._practiceStats = { again: 0, hard: 0, good: 0, easy: 0 };
		}

		const container = document.createElement('div');
		container.className = 'flashcard-container';
		el.innerHTML = '';
		el.appendChild(container);

		// Clean up any existing keyboard handler before adding a new one
		if (this._keyHandler) {
			document.removeEventListener('keydown', this._keyHandler);
			this._keyHandler = null;
		}

		// Keyboard handler
		this._keyHandler = (/** @type {KeyboardEvent} */ e) => this._handleKey(e, panel);
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
						All caught up! New cards are detected automatically.
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
			const stats = this._practiceStats || { again: 0, hard: 0, good: 0, easy: 0 };
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

		// Breadcrumb (sits above the card, like buttons sit below)
		const rawAncestors = entry.ancestors || [];
		const bc = truncateBreadcrumbs(entry.recordName, rawAncestors);
		let breadcrumbHTML = `<div class="flashcard-breadcrumb">`;
		breadcrumbHTML += `<a class="flashcard-breadcrumb-note" href="#" data-record-guid="${esc(entry.recordGuid)}" title="${esc(entry.recordName)}">${esc(bc.noteName)}</a>`;
		for (let i = 0; i < bc.crumbs.length; i++) {
			const fullText = rawAncestors[i] || bc.crumbs[i];
			breadcrumbHTML += `<span class="flashcard-breadcrumb-sep">\u203A</span>`;
			breadcrumbHTML += `<span class="flashcard-breadcrumb-crumb" title="${esc(fullText)}">${esc(bc.crumbs[i])}</span>`;
		}
		breadcrumbHTML += `</div>`;

		// Card face
		let cardInner = `
			<div class="flashcard-question">${esc(entry.question)}</div>
		`;

		if (revealed) {
			const lines = entry.answerLines || [{ text: entry.answer, depth: 0 }];
			const isMultiline = lines.length > 1;
			let answerHTML = '';
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const indent = line.depth * 40;
				let cls = 'flashcard-answer-line';
				cls += line.inline ? ' flashcard-answer-primary' : ' flashcard-answer-detail';
				answerHTML += `<div class="${cls}" style="padding-left: ${indent}px">${esc(line.text)}</div>`;
			}
			cardInner += `
				<div class="flashcard-divider"></div>
				<div class="flashcard-answer${isMultiline ? ' flashcard-answer--multiline' : ''}">${answerHTML}</div>
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
							<span class="flashcard-btn-tooltip">Press <kbd>1</kbd></span>
							<span class="flashcard-btn-label">Again</span>
							<span class="flashcard-btn-interval">${formatInterval(againCard)}</span>
						</button>
						<button class="flashcard-btn flashcard-btn--hard" data-grade="2">
							<span class="flashcard-btn-tooltip">Press <kbd>2</kbd></span>
							<span class="flashcard-btn-label">Hard</span>
							<span class="flashcard-btn-interval">${formatInterval(hardCard)}</span>
						</button>
						<button class="flashcard-btn flashcard-btn--good" data-grade="3">
							<span class="flashcard-btn-tooltip">Press <kbd>3</kbd></span>
							<span class="flashcard-btn-label">Good</span>
							<span class="flashcard-btn-interval">${formatInterval(goodCard)}</span>
						</button>
						<button class="flashcard-btn flashcard-btn--easy" data-grade="4">
							<span class="flashcard-btn-tooltip">Press <kbd>4</kbd></span>
							<span class="flashcard-btn-label">Easy</span>
							<span class="flashcard-btn-interval">${formatInterval(easyCard)}</span>
						</button>
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
			${breadcrumbHTML}
			<div class="flashcard-card" id="fc-card">
				${cardInner}
			</div>
			${buttonsHTML}
		`;

		// Event listeners — breadcrumb note link
		const noteLink = container.querySelector('.flashcard-breadcrumb-note');
		if (noteLink) {
			noteLink.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const guid = noteLink.getAttribute('data-record-guid');
				if (!guid) return;
				const newPanel = await this.ui.createPanel({ afterPanel: this._panel || undefined });
				if (newPanel) {
					setTimeout(() => {
						newPanel.navigateTo({
							type: 'edit_panel', rootId: null, subId: null, workspaceGuid: null,
							itemGuid: entry.lineItemGuid || guid, highlight: true,
						});
					}, 0);
				}
			});
		}

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
		// If our practice container is no longer in the DOM, the user navigated
		// away — clean up the listener so we stop intercepting keys.
		if (!this._panelEl || !this._panelEl.isConnected) {
			this._cleanup();
			return;
		}

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
			/** @type {Record<string, import('ts-fsrs').Grade>} */
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
	_rateCard(grade) {
		if (this._ratingInProgress) return;
		const cards = this._dueCards || [];
		const idx = this._practiceIndex || 0;
		if (idx >= cards.length) return;
		this._ratingInProgress = true;

		const entry = cards[idx];
		const result = f.next(entry.card, new Date(), grade);
		const newCard = result.card;

		// Update the session and shared index immediately. Persistence is serialized
		// in the background so backend latency never delays the next card.
		entry.card = newCard;
		this._repository.updateSchedule(entry.lineItemGuid, newCard);
		this._queueCardWrite(entry.lineItem, newCard);

		/** @type {Record<number, string>} */
		const statKey = { [Rating.Again]: 'again', [Rating.Hard]: 'hard', [Rating.Good]: 'good', [Rating.Easy]: 'easy' };
		if (this._practiceStats && statKey[grade]) {
			this._practiceStats[statKey[grade]]++;
		}

		this._practiceIndex = idx + 1;
		this._practiceRevealed = false;
		this._ratingInProgress = false;
		this._renderCurrentCard();
	}

	/**
	 * @param {PluginLineItem} lineItem
	 * @param {import('ts-fsrs').Card} card
	 */
	_queueCardWrite(lineItem, card) {
		if (!this._cardWriteChains) this._cardWriteChains = new Map();
		const previous = this._cardWriteChains.get(lineItem.guid) || Promise.resolve();
		const next = previous.catch(() => {}).then(async () => {
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					if (await cardToMeta(lineItem, card)) return;
				} catch (error) {
					if (attempt === 3) throw error;
				}
				await new Promise(resolve => setTimeout(resolve, attempt * 250));
			}
			throw new Error('Thymer rejected the flashcard metadata update');
		});
		this._cardWriteChains.set(lineItem.guid, next);
		next.catch(/** @param {any} error */ error => {
			console.error(`Flashcards: failed to save review for ${lineItem.guid}`, error);
			this.ui.addToaster({
				title: 'Review not saved',
				message: 'The card could not be updated after three attempts. Refresh cards before reviewing it again.',
				dismissible: true,
				autoDestroyTime: 6000,
			});
		}).finally(() => {
			if (this._cardWriteChains?.get(lineItem.guid) === next) this._cardWriteChains.delete(lineItem.guid);
		});
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
		this._ratingInProgress = false;
		this._panelEl = null;
		this._panel = null;
	}

	onUnload() {
		this._cleanup();
		this._repository?.dispose();
		this._sidebarWidget?.remove();
		this._sidebarWidget = null;
		if (this._dashboardRefreshTimer != null) clearTimeout(this._dashboardRefreshTimer);
		this._dashboardRefreshTimer = null;
		if (this.events) {
			for (const handlerId of this._panelEventHandlerIds || []) this.events.off(handlerId);
		}
		this._panelEventHandlerIds = [];
	}
}