import { createEmptyCard } from 'ts-fsrs';
import {
	META_PREFIX,
	cardToMetaProps,
	findFlashcardsInRecord,
	hasCardMeta,
	metaToCard,
} from './lib.js';

const EVENT_DEBOUNCE_MS = 100;
const SCAN_CONCURRENCY = 6;

/**
 * Run asynchronous work with bounded concurrency while preserving result order.
 * @template T, R
 * @param {T[]} values
 * @param {number} concurrency
 * @param {(value: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(values, concurrency, worker) {
	const results = Array.from({ length: values.length });
	let nextIndex = 0;

	async function run() {
		while (nextIndex < values.length) {
			const index = nextIndex++;
			results[index] = await worker(values[index]);
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
	return results;
}

/**
 * Cached, event-driven view of flashcards stored in Thymer line items.
 * Note content and line metadata remain the source of truth.
 */
export class CardRepository {
	/**
	 * @param {{ data: DataAPI, events?: EventsAPI, onChanged?: () => void }} options
	 */
	constructor({ data, events, onChanged }) {
		this.data = data;
		this.events = events;
		this.onChanged = onChanged || (() => {});

		/** @type {Map<string, any>} */
		this.cardsById = new Map();
		/** @type {Map<string, Set<string>>} */
		this.cardIdsByRecord = new Map();
		/** @type {Map<string, Set<string>>} */
		this.lineIdsByRecord = new Map();
		/** @type {Map<string, string>} */
		this.recordIdByLine = new Map();
		/** @type {string[]} */
		this.eventHandlerIds = [];
		/** @type {Set<string>} */
		this.dirtyRecordIds = new Set();
		this.dirtyTimer = null;
		/** @type {Promise<any>} */
		this.reconcileChain = Promise.resolve();
		this.generation = 0;
		this.rebuilding = false;
		this.disposed = false;
		/** @type {Promise<any>} */
		this.ready = Promise.resolve();
	}

	/** Subscribe before the initial scan so edits made during startup are queued. */
	start() {
		this._subscribe();
		this.ready = this.rebuild({ initializeMissing: true });
		return this.ready;
	}

	/**
	 * Rebuild the complete cache. This is used at startup, manual refresh, and
	 * after Thymer's reload event. Ordinary edits use record-level reconciliation.
	 * @param {{ initializeMissing?: boolean }} [options]
	 */
	async rebuild({ initializeMissing = false } = {}) {
		const generation = ++this.generation;
		this.rebuilding = true;
		const records = this.data.getAllRecords();
		const results = await mapWithConcurrency(records, SCAN_CONCURRENCY, async record => {
			try {
				return await this._scanRecord(record, initializeMissing);
			} catch (error) {
				console.warn(`Flashcards: failed to scan record ${record.guid}`, error);
				return null;
			}
		});

		if (this.disposed || generation !== this.generation) {
			return { records: records.length, found: 0, created: 0, existing: 0 };
		}

		this.cardsById.clear();
		this.cardIdsByRecord.clear();
		this.lineIdsByRecord.clear();
		this.recordIdByLine.clear();

		let found = 0;
		let created = 0;
		let existing = 0;
		for (const result of results) {
			if (!result) continue;
			this._replaceRecord(result);
			found += result.found;
			created += result.created;
			existing += result.existing;
		}
		this.rebuilding = false;
		this.onChanged();

		// Events received while the full scan was running are applied afterward.
		this._scheduleDirtyFlush();
		return { records: records.length, found, created, existing };
	}

	/** Manual refresh retains the existing command's initialization behavior. */
	generate() {
		this.ready = this.rebuild({ initializeMissing: true });
		return this.ready;
	}

	async whenReady() {
		await this.ready;
	}

	getAllCards() {
		return [...this.cardsById.values()];
	}

	/**
	 * @param {{ recordGuids?: Set<string>, now?: Date }} [options]
	 */
	getDueCards({ recordGuids, now = new Date() } = {}) {
		return this.getAllCards()
			.filter(entry => (!recordGuids || recordGuids.has(entry.recordGuid)) && entry.card.due <= now)
			.sort((a, b) => a.card.due.getTime() - b.card.due.getTime());
	}

	/** Keep the cache coherent immediately after an optimistic review. */
	/**
	 * @param {string} lineItemGuid
	 * @param {import('ts-fsrs').Card} card
	 */
	updateSchedule(lineItemGuid, card) {
		const entry = this.cardsById.get(lineItemGuid);
		if (!entry) return;
		entry.card = card;
		this.onChanged();
	}

	_subscribe() {
		if (!this.events) return;
		this.eventHandlerIds.push(
			this.events.on('lineitem.created', event => this._onLineEvent(event), { collection: '*' }),
			this.events.on('lineitem.updated', event => this._onLineEvent(event), { collection: '*' }),
			this.events.on('lineitem.moved', event => this._onLineEvent(event), { collection: '*' }),
			this.events.on('lineitem.undeleted', event => this._onLineEvent(event), { collection: '*' }),
			this.events.on('lineitem.deleted', event => this._onLineEvent(event), { collection: '*' }),
			this.events.on('record.created', event => {
				if (event.recordGuid) this._markDirty(event.recordGuid);
			}, { collection: '*' }),
			this.events.on('record.updated', event => {
				if (event.recordGuid) this._markDirty(event.recordGuid);
			}, { collection: '*' }),
			this.events.on('record.moved', event => {
				if (event.recordGuid) this._markDirty(event.recordGuid);
			}, { collection: '*' }),
			this.events.on('reload', () => {
				this.ready = this.rebuild({ initializeMissing: true });
			}),
		);
	}

	/** @param {any} event */
		_onLineEvent(event) {
		// Our own FSRS writes emit metadata-only lineitem.updated events. The
		// schedule is already updated optimistically, so rescanning would only loop.
		if (event.eventName === 'lineitem.updated' && this._isFlashcardMetadataOnly(event)) return;

		const previousRecordId = this.recordIdByLine.get(event.lineItemGuid);
		if (previousRecordId) this._markDirty(previousRecordId);
		if (event.recordGuid) this._markDirty(event.recordGuid);
	}

	/** @param {any} event */
		_isFlashcardMetadataOnly(event) {
			if (!event.source?.isLocal || event.hasSegments?.()) return false;
		if (event.properties || event.status != null || !event.metaProperties) return false;
		const keys = Object.keys(event.metaProperties);
		return keys.length > 0 && keys.every(key => key.startsWith(META_PREFIX));
	}

	/** @param {string} recordId */
	_markDirty(recordId) {
		if (!recordId || this.disposed) return;
		this.dirtyRecordIds.add(recordId);
		this._scheduleDirtyFlush();
	}

	_scheduleDirtyFlush() {
		if (this.disposed || this.rebuilding || this.dirtyRecordIds.size === 0 || this.dirtyTimer != null) return;
		this.dirtyTimer = setTimeout(() => {
			this.dirtyTimer = null;
			const recordIds = [...this.dirtyRecordIds];
			this.dirtyRecordIds.clear();
			this.reconcileChain = this.reconcileChain
				.then(() => mapWithConcurrency(recordIds, SCAN_CONCURRENCY, id => this._reconcileRecord(id)))
				.catch(error => console.error('Flashcards: record reconciliation failed', error));
		}, EVENT_DEBOUNCE_MS);
	}

	/** @param {string} recordId */
	async _reconcileRecord(recordId) {
		if (this.disposed) return;
		const record = this.data.getRecord(recordId);
		if (!record) {
			this._removeRecord(recordId);
			this.onChanged();
			return;
		}

		try {
			const result = await this._scanRecord(record, true);
			if (this.disposed) return;
			this._replaceRecord(result);
			this.onChanged();
		} catch (error) {
			console.warn(`Flashcards: failed to reconcile record ${recordId}`, error);
		}
	}

	/**
	 * @param {PluginRecord} record
	 * @param {boolean} initializeMissing
	 */
	async _scanRecord(record, initializeMissing) {
		// Never expand references/transclusions: cards belong to their source record.
		const lineItems = await record.getLineItems(false);
		const candidates = findFlashcardsInRecord(lineItems);
		const entries = [];
		let created = 0;
		let existing = 0;

		for (const candidate of candidates) {
			let card;
			if (hasCardMeta(candidate.lineItem)) {
				card = metaToCard(candidate.lineItem);
				existing++;
			} else if (initializeMissing) {
				card = createEmptyCard(new Date());
				const saved = await candidate.lineItem.setMetaProperties(cardToMetaProps(card));
				if (!saved) continue;
				created++;
			} else {
				continue;
			}

			if (Number.isNaN(card.due.getTime())) continue;
			entries.push({
				...candidate,
				card,
				lineItemGuid: candidate.lineItem.guid,
				recordName: record.getName(),
				recordGuid: record.guid,
			});
		}

		return {
			recordGuid: record.guid,
			lineIds: lineItems.map(/** @param {PluginLineItem} lineItem */ lineItem => lineItem.guid),
			entries,
			found: candidates.length,
			created,
			existing,
		};
	}

	/** @param {any} result */
	_replaceRecord(result) {
		this._removeRecord(result.recordGuid);

		const cardIds = new Set();
		for (const entry of result.entries) {
			this.cardsById.set(entry.lineItemGuid, entry);
			cardIds.add(entry.lineItemGuid);
		}
		this.cardIdsByRecord.set(result.recordGuid, cardIds);

		const lineIds = new Set(result.lineIds);
		this.lineIdsByRecord.set(result.recordGuid, lineIds);
		for (const lineId of lineIds) this.recordIdByLine.set(lineId, result.recordGuid);
	}

	/** @param {string} recordId */
	_removeRecord(recordId) {
		for (const cardId of this.cardIdsByRecord.get(recordId) || []) this.cardsById.delete(cardId);
		for (const lineId of this.lineIdsByRecord.get(recordId) || []) this.recordIdByLine.delete(lineId);
		this.cardIdsByRecord.delete(recordId);
		this.lineIdsByRecord.delete(recordId);
	}

	dispose() {
		this.disposed = true;
		this.generation++;
		if (this.dirtyTimer != null) clearTimeout(this.dirtyTimer);
		this.dirtyTimer = null;
		if (this.events) {
			for (const handlerId of this.eventHandlerIds) this.events.off(handlerId);
		}
		this.eventHandlerIds = [];
		this.dirtyRecordIds.clear();
	}
}
