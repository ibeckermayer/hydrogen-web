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

import {BaseRoom} from "./BaseRoom";
import {SyncWriter} from "./timeline/persistence/SyncWriter";
import {MemberWriter} from "./timeline/persistence/MemberWriter";
import {RelationWriter} from "./timeline/persistence/RelationWriter";
import {SendQueue} from "./sending/SendQueue";
import {WrappedError} from "../error";
import {Heroes} from "./members/Heroes";
import {AttachmentUpload} from "./AttachmentUpload";
import {DecryptionSource} from "../e2ee/common";
import {PowerLevels} from "./PowerLevels";
import {HistoryVisibility, PowerLevelsStateEvent, RoomEventType} from "../net/types/roomEvents";
import type {Options as BaseRoomOptions} from './BaseRoom';
import type {PendingEvent, PendingEventData} from "./sending/PendingEvent";
import type {SortedArray} from "../../observable";
import type {RoomEncryption, SummaryData, DecryptionPreparation, BatchDecryptionResult} from "../e2ee/RoomEncryption";
import type {EventEntry} from "./timeline/entries/EventEntry";
import type {EventKey} from "./timeline/EventKey";
import type {MemberChange} from "./members/RoomMember";
import type {HeroChanges} from "./members/Heroes";
import { ILogItem } from "../../logging/types";
import { JoinedRoom, LeftRoom } from "../net/types/sync";
import { Transaction } from "../storage/idb/Transaction";
import { IncomingRoomKey } from "../e2ee/megolm/decryption/RoomKey";
import { DecryptionChanges } from "../e2ee/megolm/decryption/DecryptionChanges";
import { Operation } from "../storage/idb/stores/OperationStore";
import { TimelineEvent, Content } from "../storage/types";


type Options = {
    pendingEvents?: PendingEventData[];
} & BaseRoomOptions;

export class Room extends BaseRoom {
    private _syncWriter: SyncWriter;
    private _sendQueue: SendQueue;

    constructor(options: Options) {
        super(options);
        // TODO: pass pendingEvents to start like pendingOperations?
        const {pendingEvents} = options;
        const relationWriter = new RelationWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            ownUserId: this._user.id
        });
        this._syncWriter = new SyncWriter({
            roomId: this.id,
            fragmentIdComparer: this._fragmentIdComparer,
            relationWriter,
            memberWriter: new MemberWriter(this.id)
        });
        this._sendQueue = new SendQueue({roomId: this.id, storage: this._storage, hsApi: this._hsApi, pendingEvents});
    }

    _setEncryption(roomEncryption: RoomEncryption): boolean {
        if (super._setEncryption(roomEncryption)) {
            this._sendQueue.enableEncryption(this._roomEncryption);
            return true;
        }
        return false;
    }

    async prepareSync(roomResponse: JoinedRoom | LeftRoom, membership: string, newKeys: IncomingRoomKey[], txn: Transaction, log: ILogItem): Promise<RoomSyncPreparation> {
        log?.set("id", this.id);
        if (newKeys) {
            log?.set("newKeys", newKeys.length);
        }
        let summaryChanges = this._summary.data.applySyncResponse(roomResponse, membership, this._user.id);
        let roomEncryption = this._roomEncryption;
        // encryption is enabled in this sync
        if (!roomEncryption && summaryChanges.encryption) {
            log?.set("enableEncryption", true);
            roomEncryption = this._createRoomEncryption(this, summaryChanges.encryption);
        }

        let retryEntries;
        let decryptPreparation;
        if (roomEncryption) {
            let eventsToDecrypt = roomResponse?.timeline?.events || [];
            // when new keys arrive, also see if any older events can now be retried to decrypt
            if (newKeys) {
                // TODO: if a key is considered by roomEncryption.prepareDecryptAll to use for decryption,
                // key.eventIds will be set. We could somehow try to reuse that work, but retrying also needs
                // to happen if a key is not needed to decrypt this sync or there are indeed no encrypted messages
                // in this sync at all.
                retryEntries = await this._getSyncRetryDecryptEntries(newKeys, roomEncryption, txn);
                if (retryEntries.length) {
                    log?.set("retry", retryEntries.length);
                    eventsToDecrypt = eventsToDecrypt.concat(retryEntries.map(entry => entry.event));
                }
            }
            eventsToDecrypt = eventsToDecrypt.filter(event => {
                return event?.type === RoomEventType.Encrypted;
            });
            if (eventsToDecrypt.length) {
                decryptPreparation = await roomEncryption.prepareDecryptAll(
                    eventsToDecrypt, newKeys, DecryptionSource.Sync, txn);
            }
        }

        return {
            roomEncryption,
            summaryChanges,
            decryptPreparation,
            retryEntries
        };
    }

    async afterPrepareSync(preparation: RoomSyncPreparation | undefined, parentLog: ILogItem) {
        if (preparation?.decryptPreparation) {
            await parentLog.wrap("decrypt", async log => {
                log.set("id", this.id);
                preparation.decryptChanges = await preparation.decryptPreparation.decrypt();
                preparation.decryptPreparation = null;
            }, parentLog.level.Detail);
        }
    }

    /**
     * @package
     */
     async writeSync(
        roomResponse: LeftRoom,
        isInitialSync: boolean,
        {
            summaryChanges,
            decryptChanges,
            roomEncryption,
            retryEntries,
        }: RoomSyncPreparation,
        txn: Transaction,
        log: ILogItem
    ): Promise<RoomWriteSyncChanges> {
        log.set("id", this.id);
        const isRejoin = summaryChanges.isNewJoin(this._summary.data);
        if (isRejoin) {
            // remove all room state before calling syncWriter,
            // so no old state sticks around
            txn.roomState.removeAllForRoom(this.id);
            txn.roomMembers.removeAllForRoom(this.id);
        }
        const {entries: newEntries, updatedEntries, newLiveKey, memberChanges} =
            await log.wrap("syncWriter", log => this._syncWriter.writeSync(
                roomResponse, isRejoin, summaryChanges.hasFetchedMembers, txn, log), log?.level.Detail);
        let decryption: BatchDecryptionResult | undefined;
        if (decryptChanges) {
            decryption = await log?.wrap("decryptChanges", () => decryptChanges.write(txn));
            log?.set("decryptionResults", decryption.results.size);
            log?.set("decryptionErrors", decryption.errors.size);
            if (this._isTimelineOpen) {
                await decryption.verifyKnownSenders(txn);
            }
            decryption.applyToEntries(newEntries);
            if (retryEntries?.length) {
                decryption.applyToEntries(retryEntries);
                updatedEntries.push(...retryEntries);
            }
        }
        log.set("newEntries", newEntries.length);
        log.set("updatedEntries", updatedEntries.length);
        let encryptionChanges;
        // pass member changes to device tracker
        if (roomEncryption) {
            encryptionChanges = await roomEncryption.writeSync(roomResponse, memberChanges, txn, log);
            log.set("shouldFlushKeyShares", encryptionChanges.shouldFlush);
        }
        const allEntries = newEntries.concat(updatedEntries);
        // also apply (decrypted) timeline entries to the summary changes
        summaryChanges = summaryChanges.applyTimelineEntries(
            allEntries, isInitialSync, !this._isTimelineOpen, this._user.id);

        // if we've have left the room, remove the summary
        if (summaryChanges.membership !== "join") {
            txn.roomSummary.remove(this.id);
        } else {
            // write summary changes, and unset if nothing was actually changed
            summaryChanges = this._summary.writeData(summaryChanges, txn);
        }
        if (summaryChanges) {
            log.set("summaryChanges", summaryChanges.changedKeys(this._summary.data));
        }
        // fetch new members while we have txn open,
        // but don't make any in-memory changes yet
        let heroChanges: HeroChanges | undefined;
        // if any hero changes their display name, the summary in the room response
        // is also updated, which will trigger a RoomSummary update
        // and make summaryChanges non-falsy here
        if (summaryChanges?.needsHeroes) {
            // room name disappeared, open heroes
            if (!this._heroes) {
                this._heroes = new Heroes(this._roomId);
            }
            heroChanges = await this._heroes.calculateChanges(summaryChanges.heroes, memberChanges, txn);
        }
        let removedPendingEvents: PendingEvent[] | undefined;
        if (Array.isArray(roomResponse.timeline?.events)) {
            removedPendingEvents = await this._sendQueue.removeRemoteEchos(roomResponse.timeline!.events, txn, log);
        }
        const powerLevelsEvent = this._getPowerLevelsEvent(roomResponse);
        return {
            summaryChanges,
            roomEncryption,
            newEntries,
            updatedEntries,
            newLiveKey,
            removedPendingEvents,
            memberChanges,
            heroChanges,
            powerLevelsEvent,
            encryptionChanges,
            decryption
        };
    }

    /**
     * @package
     * Called with the changes returned from `writeSync` to apply them and emit changes.
     * No storage or network operations should be done here.
     */
    afterSync(changes: RoomWriteSyncChanges, log: ILogItem) {
        const {
            summaryChanges, newEntries, updatedEntries, newLiveKey,
            removedPendingEvents, memberChanges, powerLevelsEvent,
            heroChanges, roomEncryption, encryptionChanges
        } = changes;
        log?.set("id", this.id);
        this._syncWriter.afterSync(newLiveKey);
        this._setEncryption(roomEncryption);
        if (this._roomEncryption) {
            this._roomEncryption.afterSync(encryptionChanges);
        }
        if (memberChanges.size) {
            if (this._changedMembersDuringSync) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    this._changedMembersDuringSync.set(userId, memberChange.member);
                }
            }
            if (this._memberList) {
                this._memberList.afterSync(memberChanges);
            }
            if (this._observedMembers) {
                this._updateObservedMembers(memberChanges);
            }
            if (this._timeline) {
                for (const [userId, memberChange] of memberChanges.entries()) {
                    if (userId === this._user.id) {
                        this._timeline.updateOwnMember(memberChange.member);
                        break;
                    }
                }
            }
        }
        let emitChange = false;
        if (summaryChanges) {
            this._summary.applyChanges(summaryChanges);
            if (!this._summary.data.needsHeroes) {
                this._heroes = undefined;
            }
            emitChange = true;
        }
        if (this._heroes && heroChanges) {
            const oldName = this.name;
            this._heroes.applyChanges(heroChanges, this._summary.data, log);
            if (oldName !== this.name) {
                emitChange = true;
            }
        }
        if (powerLevelsEvent) {
            this._updatePowerLevels(powerLevelsEvent);
        }
        if (emitChange) {
            this._emitUpdate();
        }
        if (this._timeline) {
            // these should not be added if not already there
            this._timeline.replaceEntries(updatedEntries);
            this._timeline.addEntries(newEntries);
        }
        if (this._observedEvents) {
            this._observedEvents.updateEvents(updatedEntries);
            this._observedEvents.updateEvents(newEntries);
        }
        if (removedPendingEvents) {
            this._sendQueue.emitRemovals(removedPendingEvents);
        }
    }

    _updateObservedMembers(memberChanges: Map<string, MemberChange>) {
        for (const [userId, memberChange] of memberChanges) {
            const observableMember = this._observedMembers?.get(userId);
            if (observableMember) {
                observableMember.set(memberChange.member);
            }
        }
    }

    _getPowerLevelsEvent(roomResponse: LeftRoom): PowerLevelsStateEvent | undefined {
        const isPowerlevelEvent = event => event.state_key === "" && event.type === RoomEventType.PowerLevels;
        const powerLevelEvent = roomResponse.timeline?.events?.find(isPowerlevelEvent) ?? roomResponse.state?.events.find(isPowerlevelEvent);
        return powerLevelEvent as PowerLevelsStateEvent;
    }

    _updatePowerLevels(powerLevelEvent: PowerLevelsStateEvent) {
        if (this._powerLevels) {
            const newPowerLevels = new PowerLevels({
                powerLevelEvent,
                ownUserId: this._user.id,
                membership: this.membership,
            });
            this._powerLevels.set(newPowerLevels);
        }
    }

    /**
     * Only called if the result of writeSync had `needsAfterSyncCompleted` set.
     * Can be used to do longer running operations that resulted from the last sync,
     * like network operations.
     */
    async afterSyncCompleted({encryptionChanges, decryption, newEntries, updatedEntries}: RoomWriteSyncChanges, log: ILogItem) {
        const shouldFlushKeys = encryptionChanges?.shouldFlush;
        const shouldFetchUnverifiedSenders = this._isTimelineOpen && decryption?.hasUnverifiedSenders;
        // only log rooms where we actually do something
        if (shouldFlushKeys || shouldFetchUnverifiedSenders) {
            await log?.wrap({l: "room", id: this.id}, async log => {
                const promises: Promise<void>[] = [];
                if (shouldFlushKeys) {
                    promises.push(this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, null, log));
                }
                if (shouldFetchUnverifiedSenders) {
                    const promise = log.wrap("verify senders", (async log => {
                        const newlyVerifiedDecryption: BatchDecryptionResult = await decryption.fetchAndVerifyRemainingSenders(this._hsApi, log);
                        const verifiedEntries: EventEntry[] = [];
                        const updateCallback = entry => verifiedEntries.push(entry);
                        newlyVerifiedDecryption.applyToEntries(newEntries, updateCallback);
                        newlyVerifiedDecryption.applyToEntries(updatedEntries, updateCallback);
                        log.set("verifiedEntries", verifiedEntries.length);
                        this._timeline?.replaceEntries(verifiedEntries);
                        this._observedEvents?.updateEvents(verifiedEntries);
                    }));
                    promises.push(promise);
                }
                await Promise.all(promises);
            });
        }
    }

    /** @package */
    start(pendingOperations: Map<string, Operation[]> | undefined, parentLog: ILogItem) {
        if (this._roomEncryption) {
            const roomKeyShares = pendingOperations?.get("share_room_key");
            if (roomKeyShares) {
                // if we got interrupted last time sending keys to newly joined members
                parentLog.wrapDetached("flush room keys", log => {
                    log.set("id", this.id);
                    return this._roomEncryption.flushPendingRoomKeyShares(this._hsApi, roomKeyShares, log);
                });
            }
        }

        this._sendQueue.resumeSending(parentLog);
    }

    /** @package */
    async load(summary: SummaryData | undefined, txn: Transaction, log: ILogItem) {
        try {
            await super.load(summary, txn, log);
            await this._syncWriter.load(txn, log);
        } catch (err) {
            throw new WrappedError(`Could not load room ${this._roomId}`, err);
        }
    }

    async _writeGapFill(gapChunk: TimelineEvent[], txn: Transaction, log: ILogItem): Promise<PendingEvent[]> {
        const removedPendingEvents = await this._sendQueue.removeRemoteEchos(gapChunk, txn, log);
        return removedPendingEvents;
    }

    _applyGapFill(removedPendingEvents: PendingEvent[]) {
        this._sendQueue.emitRemovals(removedPendingEvents);
    }

    /** @public */
    sendEvent(eventType: string, content: Content, attachments?: Record<string, AttachmentUpload>, log?: ILogItem) {
        return this._platform.logger.wrapOrRun(log, "send", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueEvent(eventType, content, attachments, log);
        });
    }

    /** @public */
    sendRedaction(eventIdOrTxnId: string | undefined, reason: string | undefined, log: ILogItem) {
        return this._platform.logger.wrapOrRun(log, "redact", log => {
            log.set("id", this.id);
            return this._sendQueue.enqueueRedaction(eventIdOrTxnId, reason, log);
        });
    }

    /** @public */
    async ensureMessageKeyIsShared(log?: ILogItem) {
        if (!this._roomEncryption) {
            return;
        }
        return this._platform.logger.wrapOrRun(log, "ensureMessageKeyIsShared", log => {
            log.set("id", this.id);
            return this._roomEncryption.ensureMessageKeyIsShared(this._hsApi, log);
        });
    }

    get avatarColorId(): string {
        return this._heroes?.roomAvatarColorId || this._roomId;
    }

    get isUnread(): boolean {
        return this._summary.data.isUnread;
    }

    get notificationCount(): number {
        return this._summary.data.notificationCount;
    }

    get highlightCount(): number {
        return this._summary.data.highlightCount;
    }

    get isTrackingMembers(): boolean {
        return this._summary.data.isTrackingMembers;
    }

    async _getLastEventId(): Promise<string | undefined> {
        const lastKey = this._syncWriter.lastMessageKey;
        if (lastKey) {
            const txn = await this._storage.readTxn([
                this._storage.storeNames.timelineEvents,
            ]);
            const eventEntry = await txn.timelineEvents.get(this._roomId, lastKey);
            return eventEntry?.event?.event_id;
        }
    }

    async clearUnread(log?: ILogItem): Promise<void> {
        if (this.isUnread || this.notificationCount) {
            return await this._platform.logger.wrapOrRun(log, "clearUnread", async log => {
                log.set("id", this.id);
                const txn = await this._storage.readWriteTxn([
                    this._storage.storeNames.roomSummary,
                ]);
                let data;
                try {
                    data = this._summary.writeClearUnread(txn);
                } catch (err) {
                    txn.abort();
                    throw err;
                }
                await txn.complete();
                this._summary.applyChanges(data);
                this._emitUpdate();

                try {
                    const lastEventId = await this._getLastEventId();
                    if (lastEventId) {
                        await this._hsApi.receipt(this._roomId, "m.read", lastEventId);
                    }
                } catch (err) {
                    // ignore ConnectionError
                    if (err.name !== "ConnectionError") {
                        throw err;
                    }
                }
            });
        }
    }

    leave(log?: ILogItem) {
        return this._platform.logger.wrapOrRun(log, "leave room", async log => {
            log.set("id", this.id);
            await this._hsApi.leave(this.id, {log}).response();
        });
    }

    /* called by BaseRoom to pass pendingEvents when opening the timeline */
    _getPendingEvents(): SortedArray<PendingEvent> {
        return this._sendQueue.pendingEvents;
    }

    /** @package */
    writeIsTrackingMembers(value: boolean, txn: Transaction): SummaryData {
        return this._summary.writeIsTrackingMembers(value, txn);
    }

    /** @package */
    applyIsTrackingMembersChanges(changes: SummaryData) {
        this._summary.applyChanges(changes);
    }

    createAttachment(blob: Blob, filename: string): AttachmentUpload {
        return new AttachmentUpload({blob, filename, platform: this._platform});
    }

    dispose() {
        super.dispose();
        this._sendQueue.dispose();
    }
}


export type RoomSyncPreparation = {
    roomEncryption: RoomEncryption;
    summaryChanges: SummaryData;
    decryptPreparation: DecryptionPreparation;
    decryptChanges?: DecryptionChanges;
    retryEntries: EventEntry[];
}

export type RoomEncryptionWriteSyncChanges = {
    shouldFlush: boolean;
    historyVisibility: HistoryVisibility;
}

export type RoomWriteSyncChanges = {
    summaryChanges: SummaryData;
    roomEncryption: RoomEncryption;
    newEntries: EventEntry[];
    updatedEntries: EventEntry[];
    newLiveKey: EventKey;
    memberChanges: Map<string, MemberChange>;
    removedPendingEvents?: PendingEvent[];
    heroChanges?: HeroChanges;
    powerLevelsEvent?: PowerLevelsStateEvent;
    encryptionChanges?: RoomEncryptionWriteSyncChanges;
    decryption?: BatchDecryptionResult;
}