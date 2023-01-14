/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventEmitter} from "../../utils/EventEmitter";
import {RoomSummary} from "./RoomSummary";
import {GapWriter} from "./timeline/persistence/GapWriter";
import {RelationWriter} from "./timeline/persistence/RelationWriter";
import {Timeline} from "./timeline/Timeline";
import {FragmentIdComparer} from "./timeline/FragmentIdComparer";
import {WrappedError} from "../error"
import {fetchOrLoadMembers, fetchOrLoadMember} from "./members/load";
import {MemberList} from "./members/MemberList";
import {Heroes} from "./members/Heroes";
import {EventEntry} from "./timeline/entries/EventEntry";
import {ObservedEventMap} from "./ObservedEventMap";
import {DecryptionSource} from "../e2ee/common";
import {ensureLogItem} from "../../logging/utils";
import {PowerLevels} from "./PowerLevels";
import {RetainedObservableValue} from "../../observable/ObservableValue";
import {TimelineReader} from "./timeline/persistence/TimelineReader";
import {Platform, SortedArray} from "../../lib";
import {Membership, RoomEventType} from "../net/types/roomEvents";
import type {Storage} from "../storage/idb/Storage";
import type {HomeServerApi} from "../net/HomeServerApi";
import type {MediaRepository} from "../net/MediaRepository";
import type {InstantMessageRoom} from "./InstantMessageRoom";
import type {RoomEncryption, SummaryData} from "../e2ee/RoomEncryption";
import type {User} from "../User";
import type {RoomMember} from "./members/RoomMember";
import type {Transaction} from "../storage/idb/Transaction";
import type {ILogItem} from "../../logging/types";
import type {IncomingRoomKey, RoomKey} from "../e2ee/megolm/decryption/RoomKey";
import type {FragmentBoundaryEntry} from "./timeline/entries/FragmentBoundaryEntry";
import type {KeyBackup} from "../e2ee/megolm/keybackup/KeyBackup";
import type {ObservedEvent} from "./ObservedEventMap";
import type {DecryptionPreparation} from "../e2ee/megolm/decryption/DecryptionPreparation";
import type {PendingEvent} from "./sending/PendingEvent";

const EVENT_ENCRYPTED_TYPE = "m.room.encrypted";

export type Options = {
    roomId: string;
    storage: Storage;
    hsApi: HomeServerApi;
    mediaRepository: MediaRepository;
    emitCollectionChange: (room: BaseRoom, params: any) => boolean | undefined;
    user: User;
    createRoomEncryption: (room: InstantMessageRoom, encryptionParams: EncryptionParams) => RoomEncryption | null;
    getSyncToken: () => string | undefined;
    platform: Platform;
}

export class BaseRoom extends EventEmitter<{change: void}> {
    protected _roomId: string;
    protected _storage: Storage;
    protected _hsApi: HomeServerApi;
    private _mediaRepository: MediaRepository;
    private _emitCollectionChange: (room: BaseRoom, params?: any) => boolean | undefined;
    protected _user: User;
    protected _createRoomEncryption: (room: BaseRoom, encryptionParams: EncryptionParams) => RoomEncryption | null;
    private _getSyncToken: () => string | undefined;
    protected _platform: Platform;
    protected _summary: RoomSummary;
    protected _fragmentIdComparer: FragmentIdComparer;
    protected _timeline?: Timeline;
    protected _changedMembersDuringSync?: Map<string, RoomMember> | null;
    protected _memberList?: MemberList;
    protected _roomEncryption?: RoomEncryption;
    protected _observedEvents?: ObservedEventMap;
    protected _powerLevels?: RetainedObservableValue<PowerLevels>;
    private _powerLevelLoading?: Promise<PowerLevels>;
    protected _observedMembers?: Map<string, RetainedObservableValue<RoomMember>>;
    protected _heroes?: Heroes;


    constructor({roomId, storage, hsApi, mediaRepository, emitCollectionChange, user, createRoomEncryption, getSyncToken, platform}: Options) {
        super();
        this._roomId = roomId;
        this._storage = storage;
        this._hsApi = hsApi;
        this._mediaRepository = mediaRepository;
        this._summary = new RoomSummary(roomId);
        this._fragmentIdComparer = new FragmentIdComparer([]);
        this._emitCollectionChange = emitCollectionChange;
        this._user = user;
        this._createRoomEncryption = createRoomEncryption;
        this._getSyncToken = getSyncToken;
        this._platform = platform;
    }

    async _eventIdsToEntries(eventIds: string[], txn: Transaction): Promise<EventEntry[]> {
        const retryEntries: EventEntry[] = [];
        await Promise.all(eventIds.map(async eventId => {
            const storageEntry = await txn.timelineEvents.getByEventId(this._roomId, eventId);
            if (storageEntry) {
                retryEntries.push(new EventEntry(storageEntry, this._fragmentIdComparer));
            }
        }));
        return retryEntries;
    }

    _getAdditionalTimelineRetryEntries(otherRetryEntries: EventEntry[] | undefined, roomKeys: RoomKey[]): EventEntry[] {
        let retryTimelineEntries: Array<EventEntry> = this._roomEncryption.filterUndecryptedEventEntriesForKeys(this._timeline.remoteEntries, roomKeys);
        // filter out any entries already in retryEntries so we don't decrypt them twice
        const existingIds = otherRetryEntries?.reduce((ids, e) => {ids.add(e.id); return ids;}, new Set());
        retryTimelineEntries = retryTimelineEntries.filter(e => !existingIds.has(e.id));
        return retryTimelineEntries;
    }

    /**
     * Used for retrying decryption from other sources than sync, like key backup.
     * @internal
     * @param  {Array<string>} eventIds any event ids that should be retried. There might be more in the timeline though for this key.
     */
    async notifyRoomKey(roomKey: RoomKey, eventIds: string[], log: ILogItem) {
        if (!this._roomEncryption) {
            return;
        }
        const txn = await this._storage.readTxn([
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.inboundGroupSessions,
        ]);
        let retryEntries = await this._eventIdsToEntries(eventIds, txn);
        if (this._timeline) {
            const retryTimelineEntries = this._getAdditionalTimelineRetryEntries(retryEntries, [roomKey]);
            retryEntries = retryEntries.concat(retryTimelineEntries);
        }
        if (retryEntries.length) {
            const decryptRequest = this._decryptEntries(DecryptionSource.Retry, retryEntries, txn, log);
            // this will close txn while awaiting decryption
            await decryptRequest.complete();

            this._timeline?.replaceEntries(retryEntries);
            // we would ideally write the room summary in the same txn as the groupSessionDecryptions in the
            // _decryptEntries entries and could even know which events have been decrypted for the first
            // time from DecryptionChanges.write and only pass those to the summary. As timeline changes
            // are not essential to the room summary, it's fine to write this in a separate txn for now.
            const changes = this._summary.data.applyTimelineEntries(retryEntries, false, false);
            if (await this._summary.writeAndApplyData(changes, this._storage)) {
                this._emitUpdate();
            }
        }
    }

    _setEncryption(roomEncryption: RoomEncryption): boolean {
        if (roomEncryption && !this._roomEncryption) {
            this._roomEncryption = roomEncryption;
            if (this._timeline) {
                this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
            }
            return true;
        }
        return false;
    }

    /**
     * Used for decrypting when loading/filling the timeline, and retrying decryption,
     * not during sync, where it is split up during the multiple phases.
     */
    _decryptEntries(source: "Sync" | "Timeline" | "Retry", entries: EventEntry[], inboundSessionTxn: Transaction | undefined, log: ILogItem): DecryptionRequest {
        const request = new DecryptionRequest(async (r, log) => {
            if (!inboundSessionTxn) {
                inboundSessionTxn = await this._storage.readTxn([this._storage.storeNames.inboundGroupSessions]);
            }
            if (r.cancelled) return;
            const events = entries.filter(entry => {
                return entry.eventType === EVENT_ENCRYPTED_TYPE;
            }).map(entry => entry.event);
            r.preparation = await this._roomEncryption.prepareDecryptAll(events, null, source, inboundSessionTxn);
            if (r.cancelled) return;
            const changes = await r.preparation?.decrypt();
            r.preparation = undefined;
            if (r.cancelled) return;
            const stores = [this._storage.storeNames.groupSessionDecryptions];
            const isTimelineOpen = this._isTimelineOpen;
            if (isTimelineOpen) {
                // read to fetch devices if timeline is open
                stores.push(this._storage.storeNames.deviceIdentities);
            }
            const writeTxn = await this._storage.readWriteTxn(stores);
            let decryption;
            try {
                decryption = await changes?.write(writeTxn);
                if (isTimelineOpen) {
                    await decryption.verifyKnownSenders(writeTxn);
                }
            } catch (err) {
                writeTxn.abort();
                throw err;
            }
            await writeTxn.complete();
            // TODO: log decryption errors here
            decryption.applyToEntries(entries);
            if (this._observedEvents) {
                this._observedEvents.updateEvents(entries);
            }
            if (isTimelineOpen && decryption.hasUnverifiedSenders) {
                // verify missing senders async and update timeline once done so we don't delay rendering with network requests
                log.wrapDetached("fetch unknown senders keys", async log => {
                    const newlyVerifiedDecryption = await decryption.fetchAndVerifyRemainingSenders(this._hsApi, log);
                    const verifiedEntries: any[] = [];
                    newlyVerifiedDecryption.applyToEntries(entries, entry => verifiedEntries.push(entry));
                    this._timeline?.replaceEntries(verifiedEntries);
                    this._observedEvents?.updateEvents(verifiedEntries);
                });
            }
        }, ensureLogItem(log));
        return request;
    }

    // TODO: move this to Room
    async _getSyncRetryDecryptEntries(newKeys: IncomingRoomKey[], roomEncryption: RoomEncryption, txn: Transaction): Promise<EventEntry[] | undefined> {
        const entriesPerKey: (EventEntry[] | undefined)[] = await Promise.all(newKeys.map(async key => {
            const retryEventIds = await roomEncryption.getEventIdsForMissingKey(key, txn);
            if (retryEventIds) {
                return this._eventIdsToEntries(retryEventIds, txn);
            }
        }));
        let retryEntries = entriesPerKey.reduce((allEntries, entries) => entries ? allEntries?.concat(entries) : allEntries, []);
        // If we have the timeline open, see if there are more entries for the new keys
        // as we only store missing session information for synced events, not backfilled.
        // We want to decrypt all events we can though if the user is looking
        // at them when the timeline is open
        if (this._timeline) {
            const retryTimelineEntries = this._getAdditionalTimelineRetryEntries(retryEntries, newKeys);
            // make copies so we don't modify the original entry in writeSync, before the afterSync stage
            const retryTimelineEntriesCopies = retryTimelineEntries.map(e => e.clone());
            // add to other retry entries
            retryEntries = retryEntries?.concat(retryTimelineEntriesCopies);
        }
        return retryEntries;
    }

    /** @package */
    async load(summary: SummaryData | undefined, txn: Transaction, log: ILogItem) {
        log?.set("id", this.id);
        try {
            // if called from sync, there is no summary yet
            if (summary) {
                this._summary.load(summary);
            }
            if (this._summary.data.encryption) {
                const roomEncryption = this._createRoomEncryption(this, this._summary.data.encryption);
                this._setEncryption(roomEncryption);
            }
            // need to load members for name?
            if (this._summary.data.needsHeroes) {
                if (!this._summary.data.heroes) throw new Error("data missing heroes")
                this._heroes = new Heroes(this._roomId);
                const changes = await this._heroes.calculateChanges(this._summary.data.heroes, new Map(), txn);
                this._heroes.applyChanges(changes, this._summary.data, log);
            }
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }

    async observeMember(userId: string): Promise<RetainedObservableValue<RoomMember> | null> {
        if (!this._observedMembers) {
            this._observedMembers = new Map();
        }
        const mapMember = this._observedMembers.get(userId);
        if (mapMember) {
            // Hit, we're already observing this member
            return mapMember;
        }
        // Miss, load from storage/hs and set in map
        const member = await fetchOrLoadMember({
            summary: this._summary,
            roomId: this._roomId,
            userId,
            storage: this._storage,
            hsApi: this._hsApi
        }, this._platform.logger);
        if (!member) {
            return null;
        }
        const observableMember = new RetainedObservableValue(member, () => this._observedMembers?.delete(userId));
        this._observedMembers.set(userId, observableMember);
        return observableMember;
    }


    /** @public */
    async loadMemberList(txn?: Transaction, log?: ILogItem) {
        if (this._memberList) {
            // TODO: also await fetchOrLoadMembers promise here
            this._memberList.retain();
            return this._memberList;
        } else {
            const syncToken = this._getSyncToken();
            if (!txn || !syncToken) throw new Error("missing transaction or sync token")
            const members = await fetchOrLoadMembers({
                summary: this._summary,
                roomId: this._roomId,
                hsApi: this._hsApi,
                storage: this._storage,
                // pass in a transaction if we know we won't need to fetch (which would abort the transaction)
                // and we want to make this operation part of the larger transaction
                txn,
                syncToken: syncToken,
                // to handle race between /members and /sync
                setChangedMembersMap: map => this._changedMembersDuringSync = map,
                log,
            }, this._platform.logger);
            this._memberList = new MemberList({
                members,
                closeCallback: () => { this._memberList = undefined; }
            });
            return this._memberList;
        }
    }

    /** @public */
    fillGap(fragmentEntry: FragmentBoundaryEntry, amount: number, log: ILogItem) {
        // TODO move some/all of this out of BaseRoom
        return this._platform.logger.wrapOrRun(log, "fillGap", async log => {
            log.set("id", this.id);
            log.set("fragment", fragmentEntry.fragmentId);
            log.set("dir", fragmentEntry.direction.asApiString());
            if (fragmentEntry.edgeReached) {
                log.set("edgeReached", true);
                return;
            }
            const response = await this._hsApi.messages(this._roomId, {
                from: fragmentEntry.token,
                dir: fragmentEntry.direction.asApiString(),
                limit: amount,
                filter: {
                    lazy_load_members: true,
                    include_redundant_members: true,
                }
            }, {log}).response();

            const txn = await this._storage.readWriteTxn([
                this._storage.storeNames.pendingEvents,
                this._storage.storeNames.timelineEvents,
                this._storage.storeNames.timelineRelations,
                this._storage.storeNames.timelineFragments,
            ]);
            let extraGapFillChanges;
            let gapResult;
            try {
                // detect remote echos of pending messages in the gap
                extraGapFillChanges = await this._writeGapFill(response.chunk, txn, log);
                // write new events into gap
                const relationWriter = new RelationWriter({
                    roomId: this._roomId,
                    fragmentIdComparer: this._fragmentIdComparer,
                    ownUserId: this._user.id,
                });
                const gapWriter = new GapWriter({
                    roomId: this._roomId,
                    storage: this._storage,
                    fragmentIdComparer: this._fragmentIdComparer,
                    relationWriter
                });
                gapResult = await gapWriter.writeFragmentFill(fragmentEntry, response, txn, log);
            } catch (err) {
                txn.abort();
                throw err;
            }
            await txn.complete();
            if (this._roomEncryption) {
                const decryptRequest = this._decryptEntries(DecryptionSource.Timeline, gapResult.entries, undefined, log);
                await decryptRequest.complete();
            }
            // once txn is committed, update in-memory state & emit events
            for (const fragment of gapResult.fragments) {
                this._fragmentIdComparer.add(fragment);
            }
            if (extraGapFillChanges) {
                this._applyGapFill(extraGapFillChanges);
            }
            if (this._timeline) {
                // these should not be added if not already there
                this._timeline.replaceEntries(gapResult.updatedEntries);
                this._timeline.addEntries(gapResult.entries);
            }
        });
    }

    /**
    allow sub classes to integrate in the gap fill lifecycle.
    JoinedRoom uses this update remote echos.
    */
    // eslint-disable-next-line no-unused-vars
    async _writeGapFill(chunk, txn, log): Promise<PendingEvent[]> {
        return []
    }
    _applyGapFill(removedPendingEvents?: PendingEvent[]) {}

    /** @public */
    get name(): string | undefined {
        if (this._heroes) {
            return this._heroes.roomName;
        }
        const summaryData = this._summary.data;
        if (summaryData.name) {
            return summaryData.name;
        }
        if (summaryData.canonicalAlias) {
            return summaryData.canonicalAlias;
        }
    }

    /** @public */
    get id(): string {
        return this._roomId;
    }

    get avatarUrl(): string | undefined{
        if (this._summary.data.avatarUrl) {
            return this._summary.data.avatarUrl;
        } else if (this._heroes) {
            return this._heroes.roomAvatarUrl;
        }
    }

    /**
     * Retrieve the identifier that should be used to color
     * this room's avatar. By default this is the room's
     * ID, but DM rooms should be the same color as their
     * user's avatar.
     */
    get avatarColorId(): string {
        return this._roomId;
    }

    get lastMessageTimestamp(): number | undefined {
        return this._summary.data.lastMessageTimestamp;
    }

    get isLowPriority(): boolean {
        const tags = this._summary.data.tags;
        return !!(tags && tags['m.lowpriority']);
    }

    get isEncrypted(): boolean {
        return !!this._summary.data.encryption;
    }

    get isJoined(): boolean {
        return this.membership === "join";
    }

    get isLeft(): boolean {
        return this.membership === "leave";
    }

    get canonicalAlias(): string | undefined{
        return this._summary.data.canonicalAlias;
    }

    get joinedMemberCount(): number {
        return this._summary.data.joinCount;
    }

    get mediaRepository(): MediaRepository {
        return this._mediaRepository;
    }

    get membership(): Membership | undefined {
        return this._summary.data.membership;
    }

    get isArchived(): boolean {
        return false
    }

    release(): void {}
    forget(): void {}
    join(): void {}

    isDirectMessageForUserId(userId: string): boolean {
        if (this._summary.data.dmUserId === userId) {
            return true;
        } else {
            // fall back to considering any room a DM containing heroes (e.g. no name) and 2 members,
            // on of which the userId we're looking for.
            // We need this because we're not yet processing m.direct account data correctly.
            const {heroes, joinCount, inviteCount} = this._summary.data;
            if (heroes && heroes.includes(userId) && (joinCount + inviteCount) === 2) {
                return true;
            }
        }
        return false;
    }

    async _loadPowerLevels(): Promise<PowerLevels> {
        const txn = await this._storage.readTxn([this._storage.storeNames.roomState]);
        const powerLevelsState = await txn.roomState.get(this._roomId, RoomEventType.PowerLevels, "");
        if (powerLevelsState) {
            return new PowerLevels({
                powerLevelEvent: powerLevelsState.event,
                ownUserId: this._user.id,
                membership: this.membership
            });
        }
        const createState = await txn.roomState.get(this._roomId, RoomEventType.Create, "");
        if (createState) {
            return new PowerLevels({
                createEvent: createState.event,
                ownUserId: this._user.id,
                membership: this.membership
            });
        } else {
            const membership = this.membership;
            return new PowerLevels({ownUserId: this._user.id, membership});
        }
    }

    /**
     * Get the PowerLevels of the room.
     * Always subscribe to the value returned by this method.
     */
    async observePowerLevels(): Promise<RetainedObservableValue<PowerLevels>> {
        if (this._powerLevelLoading) { await this._powerLevelLoading; }
        let observable = this._powerLevels;
        if (!observable) {
            this._powerLevelLoading = this._loadPowerLevels();
            const powerLevels = await this._powerLevelLoading;
            observable = new RetainedObservableValue(powerLevels, () => { this._powerLevels = undefined; });
            this._powerLevels = observable;
            this._powerLevelLoading = undefined;
        }
        return observable;
    }

    enableKeyBackup(keyBackup: KeyBackup | undefined) {
        this._roomEncryption?.enableKeyBackup(keyBackup);
        // TODO: do we really want to do this every time you open the app?
        if (this._timeline && keyBackup) {
            this._platform.logger.run("enableKeyBackup", log => {
                return this._roomEncryption.restoreMissingSessionsFromBackup(this._timeline.remoteEntries, log);
            });
        }
    }

    get _isTimelineOpen() {
        return !!this._timeline;
    }

    _emitUpdate() {
        // once for event emitter listeners
        this.emit("change");
        // and once for collection listeners
        this._emitCollectionChange(this);
    }

    /** @public */
    openTimeline(log?: ILogItem) {
        return this._platform.logger.wrapOrRun(log, "open timeline", async log => {
            log.set("id", this.id);
            if (this._timeline) {
                throw new Error("not dealing with load race here for now");
            }
            this._timeline = new Timeline({
                roomId: this.id,
                storage: this._storage,
                fragmentIdComparer: this._fragmentIdComparer,
                pendingEvents: this._getPendingEvents(),
                closeCallback: () => {
                    this._timeline = undefined;
                    if (this._roomEncryption) {
                        this._roomEncryption.notifyTimelineClosed();
                    }
                },
                clock: this._platform.clock,
                logger: this._platform.logger,
                powerLevelsObservable: await this.observePowerLevels(),
                hsApi: this._hsApi
            });
            try {
                if (this._roomEncryption) {
                    this._timeline.enableEncryption(this._decryptEntries.bind(this, DecryptionSource.Timeline));
                }
                await this._timeline.load(this._user, this.membership, log);
            } catch (err) {
                // this also clears this._timeline in the closeCallback
                this._timeline.dispose();
                throw err;
            }
            return this._timeline;
        });
    }

    /* allow subclasses to provide an observable list with pending events when opening the timeline */
    _getPendingEvents(): SortedArray<PendingEvent> { return new SortedArray(() => 0); }

    observeEvent(eventId: string): ObservedEvent {
        if (!this._observedEvents) {
            this._observedEvents = new ObservedEventMap(() => {
                this._observedEvents = null;
            });
        }
        let entry = null;
        if (this._timeline) {
            entry = this._timeline.getByEventId(eventId);
        }
        const observable = this._observedEvents.observe(eventId, entry);
        if (!entry) {
            // update in the background
            this._readEventById(eventId).then(entry => {
                observable.update(entry);
            }).catch(err => {
                console.warn(`could not load event ${eventId} from storage`, err);
            });
        }
        return observable;
    }

    async _readEventById(eventId: string): Promise<EventEntry | undefined> {
        const reader = new TimelineReader({ roomId: this._roomId, storage: this._storage, fragmentIdComparer: this._fragmentIdComparer });
        const entry = await reader.readById(eventId);
        return entry;
    }

    dispose() {
        this._roomEncryption?.dispose();
        this._timeline?.dispose();
    }
}

export class DecryptionRequest {
    private _cancelled: boolean;
    preparation?: DecryptionPreparation;
    private _promise: Promise<void>;

    constructor(decryptFn: (r: DecryptionRequest, log: ILogItem) => Promise<void>, log: ILogItem) {
        this._cancelled = false;
        this._promise = log.wrap("decryptEntries", log => decryptFn(this, log));
    }

    complete() {
        return this._promise;
    }

    get cancelled() {
        return this._cancelled;
    }

    dispose() {
        this._cancelled = true;
        if (this.preparation) {
            this.preparation.dispose();
        }
    }
}

export type EncryptionParams = {
    algorithm: "m.megolm.v1.aes-sha2";
    rotation_period_ms?: number;
    rotation_period_msgs?: number;
}