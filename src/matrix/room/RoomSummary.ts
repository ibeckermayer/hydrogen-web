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

import {MEGOLM_ALGORITHM} from "../e2ee/common";
import {Membership, RoomEventType} from "../net/types/roomEvents";
import type {ClientEventWithoutRoomID, JoinedRoom, LeftRoom, RoomSummary as SyncRoomSummary, SyncEvent, UnreadNotificationCounts} from "../net/types/sync";
import type {Storage} from "../storage/idb/Storage";
import type {Transaction} from "../storage/idb/Transaction";
import { Content } from "../storage/types";
import { EncryptionParams } from "./BaseRoom";
import type {EventEntry} from "./timeline/entries/EventEntry";

function applyTimelineEntries(data: SummaryData, timelineEntries: EventEntry[], isInitialSync: boolean, canMarkUnread: boolean, ownUserId?: string): SummaryData {
    if (timelineEntries.length) {
        data = timelineEntries.reduce((data, entry) => {
            return processTimelineEvent(data, entry,
                isInitialSync, canMarkUnread, ownUserId);
        }, data);
    }
    return data;
}

export function reduceStateEvents(
    roomResponse: JoinedRoom | LeftRoom,
    callback: (value: SummaryData, event: ClientEventWithoutRoomID) => SummaryData,
    value: SummaryData
): SummaryData {
    const stateEvents = roomResponse?.state?.events;
    // state comes before timeline
    if (Array.isArray(stateEvents)) {
        value = stateEvents.reduce(callback, value);
    }
    const timelineEvents = roomResponse?.timeline?.events;
    // and after that state events in the timeline
    if (Array.isArray(timelineEvents)) {
        value = timelineEvents.reduce((data, event) => {
            if (typeof event.state_key === "string") {
                value = callback(value, event);
            }
            return value;
        }, value);
    }
    return value;
}

function applySyncResponse(
    data: SummaryData,
    roomResponse: JoinedRoom | LeftRoom,
    membership?: Membership,
    ownUserId?: string
): SummaryData {
    if ("summary" in roomResponse && roomResponse.summary) {
        data = updateSummary(data, roomResponse.summary);
    }
    if (membership !== data.membership) {
        data = data.cloneIfNeeded();
        data.membership = membership;
    }
    if (roomResponse.account_data) {
        data = roomResponse.account_data.events.reduce(processRoomAccountData, data);
    }
    // process state events in state and in timeline.
    // non-state events are handled by applyTimelineEntries
    // so decryption is handled properly
    data = reduceStateEvents(roomResponse, (data, event) => processStateEvent(data, event, ownUserId), data);
    if ("unread_notifications" in roomResponse) {
        const unreadNotifications = roomResponse.unread_notifications;
        if (unreadNotifications) {
            data = processNotificationCounts(data, unreadNotifications);
        }
    }

    return data;
}

function processNotificationCounts(data: SummaryData, unreadNotifications: UnreadNotificationCounts): SummaryData {
    const highlightCount = unreadNotifications.highlight_count || 0;
    if (highlightCount !== data.highlightCount) {
        data = data.cloneIfNeeded();
        data.highlightCount = highlightCount;
    }
    const notificationCount = unreadNotifications.notification_count;
    if (notificationCount !== data.notificationCount) {
        data = data.cloneIfNeeded();
        data.notificationCount = notificationCount ?? 0;
    }
    return data;
}

function processRoomAccountData(data: SummaryData, event: SyncEvent): SummaryData {
    if (event?.type === "m.tag") {
        let tags = event?.content?.tags;
        if (!tags || Array.isArray(tags) || typeof tags !== "object") {
            tags = undefined;
        }
        data = data.cloneIfNeeded();
        data.tags = tags;
    }
    return data;
}

export function processStateEvent(data: SummaryData, event: ClientEventWithoutRoomID, ownUserId?: string): SummaryData {
    if (event.type === RoomEventType.Create) {
        data = data.cloneIfNeeded();
        data.lastMessageTimestamp = event.origin_server_ts;
    } else if (event.type === RoomEventType.Encryption) {
        const algorithm = event.content?.algorithm;
        if (!data.encryption && algorithm === MEGOLM_ALGORITHM) {
            data = data.cloneIfNeeded();
            data.encryption = event.content as EncryptionParams;
        }
    } else if (event.type === RoomEventType.Name) {
        const newName = event.content?.name;
        if (newName !== data.name) {
            data = data.cloneIfNeeded();
            data.name = newName;
        }
    } else if (event.type === RoomEventType.Avatar) {
        const newUrl = event.content?.url;
        if (newUrl !== data.avatarUrl) {
            data = data.cloneIfNeeded();
            data.avatarUrl = newUrl;
        }
    } else if (event.type === RoomEventType.CanonicalAlias) {
        const content = event.content;
        data = data.cloneIfNeeded();
        data.canonicalAlias = content.alias;
    } else if (event.type === RoomEventType.Member) {
        const content = event.content;
        if (content.is_direct === true && content.membership === "invite" && !data.isDirectMessage) {
            let other;
            if (event.sender === ownUserId) {
                other = event.state_key;
            } else if (event.state_key === ownUserId) {
                other = event.sender;
            }
            if (other) {
                data = data.cloneIfNeeded();
                data.isDirectMessage = true;
                data.dmUserId = other;
            }
        } else if (content.membership === "leave" && data.isDirectMessage && data.dmUserId === event.state_key) {
            data = data.cloneIfNeeded();
            data.isDirectMessage = false;
            data.dmUserId = undefined;
        }
    }
    return data;
}

function processTimelineEvent(data: SummaryData, eventEntry: EventEntry, isInitialSync: boolean, canMarkUnread: boolean, ownUserId?: string): SummaryData {
    if (eventEntry.eventType === "m.room.message") {
        if (!data.lastMessageTimestamp || eventEntry.timestamp > data.lastMessageTimestamp) {
            data = data.cloneIfNeeded();
            data.lastMessageTimestamp = eventEntry.timestamp;
        }
        if (!isInitialSync && eventEntry.sender !== ownUserId && canMarkUnread) {
            data = data.cloneIfNeeded();
            data.isUnread = true;
        }
    }
    return data;
}

function updateSummary(data: SummaryData, summary: SyncRoomSummary): SummaryData {
    const heroes = summary["m.heroes"];
    const joinCount = summary["m.joined_member_count"];
    const inviteCount = summary["m.invited_member_count"];
    // TODO: we could easily calculate if all members are available here and set hasFetchedMembers?
    // so we can avoid calling /members...
    // we'd need to do a count query in the roomMembers store though ...
    if (heroes && Array.isArray(heroes)) {
        data = data.cloneIfNeeded();
        data.heroes = heroes;
    }
    if (Number.isInteger(inviteCount)) {
        data = data.cloneIfNeeded();
        data.inviteCount = inviteCount!;
    }
    if (Number.isInteger(joinCount)) {
        data = data.cloneIfNeeded();
        data.joinCount = joinCount!;
    }
    return data;
}

export type SerializedSummaryData = {
    roomId?: string;
    name?: string;
    lastMessageTimestamp?: number;
    isUnread: boolean;
    encryption?: EncryptionParams;
    membership?: Membership;
    inviteCount: number;
    joinCount: number;
    heroes?: string[];
    canonicalAlias?: string;
    hasFetchedMembers: boolean;
    isTrackingMembers: boolean;
    avatarUrl?: string;
    notificationCount: number;
    highlightCount: number;
    tags?: Content;
    isDirectMessage: boolean;
    dmUserId?: string;
    isSpace: boolean;
}

export class SummaryData {
    roomId?: string;
    name?: string;
    lastMessageTimestamp?: number;
    isUnread: boolean;
    encryption?: EncryptionParams;
    membership?: Membership;
    inviteCount: number;
    joinCount: number;
    heroes?: string[];
    canonicalAlias?: string;
    hasFetchedMembers: boolean;
    isTrackingMembers: boolean;
    avatarUrl?: string;
    notificationCount: number;
    highlightCount: number;
    tags?: Content;
    isDirectMessage: boolean;
    dmUserId?: string;
    cloned: boolean;
    isSpace: boolean;

    constructor(copy?: SummaryData | SerializedSummaryData, roomId?: string, isSpace?: boolean) {
        this.roomId = copy?.roomId ?? roomId;
        this.name = copy?.name;
        this.lastMessageTimestamp = copy?.lastMessageTimestamp;
        this.isUnread = copy ? copy.isUnread : false;
        this.encryption = copy?.encryption;
        this.membership = copy?.membership;
        this.inviteCount = copy?.inviteCount ?? 0;
        this.joinCount = copy?.joinCount ?? 0;
        this.heroes = copy?.heroes;
        this.canonicalAlias = copy?.canonicalAlias;
        this.hasFetchedMembers = copy?.hasFetchedMembers ?? false;
        this.isTrackingMembers = copy?.isTrackingMembers ?? false;
        this.avatarUrl = copy?.avatarUrl;
        this.notificationCount = copy?.notificationCount ?? 0;
        this.highlightCount = copy?.highlightCount ?? 0;
        this.tags = copy?.tags;
        this.isDirectMessage = copy?.isDirectMessage ?? false;
        this.dmUserId = copy?.dmUserId;
        this.cloned = copy ? true : false;
        this.isSpace = copy ? copy.isSpace : isSpace ?? false;
    }

    changedKeys(other: { [x: string]: any; }): string[] {
        const props = Object.getOwnPropertyNames(this);
        return props.filter(prop => {
            return prop !== "cloned" && this[prop] !== other[prop]
        });
    }

    cloneIfNeeded(): SummaryData {
        if (this.cloned) {
            return this;
        } else {
            return new SummaryData(this);
        }
    }

    serialize(): SerializedSummaryData {
        return Object.entries(this).reduce((obj, [key, value]) => {
            if (key !== "cloned") {
                obj[key] = value;
            }
            return obj;
        }, {} as SerializedSummaryData)
    }

    applyTimelineEntries(timelineEntries: EventEntry[], isInitialSync: boolean, canMarkUnread: boolean, ownUserId?: string): SummaryData {
        return applyTimelineEntries(this, timelineEntries, isInitialSync, canMarkUnread, ownUserId);
    }

    applySyncResponse(roomResponse: JoinedRoom | LeftRoom, membership?: Membership, ownUserId?: string): SummaryData {
        return applySyncResponse(this, roomResponse, membership, ownUserId);
    }

    get needsHeroes(): boolean {
        return !this.name && !this.canonicalAlias && this.heroes !== undefined && this.heroes.length > 0;
    }

    isNewJoin(oldData: SummaryData): boolean {
        return this.membership === "join" && oldData.membership !== "join";
    }
}

export class RoomSummary {
    private _data: SummaryData;

	constructor(roomId: string, isSpace?: boolean) {
        this.applyChanges(new SummaryData(undefined, roomId, isSpace));
	}

    get data(): SummaryData {
        return this._data;
    }

    writeClearUnread(txn: Transaction): SummaryData {
        const data = new SummaryData(this._data);
        data.isUnread = false;
        data.notificationCount = 0;
        data.highlightCount = 0;
        txn.roomSummary.set(data.serialize());
        return data;
    }

    writeHasFetchedMembers(value: boolean, txn: Transaction): SummaryData {
        const data = new SummaryData(this._data);
        data.hasFetchedMembers = value;
        txn.roomSummary.set(data.serialize());
        return data;
    }

    writeIsTrackingMembers(value: boolean, txn: Transaction): SummaryData {
        const data = new SummaryData(this._data);
        data.isTrackingMembers = value;
        txn.roomSummary.set(data.serialize());
        return data;
    }

	writeData(data: SummaryData, txn: Transaction): SummaryData | undefined {
		if (data !== this._data) {
            txn.roomSummary.set(data.serialize());
            return data;
		}
	}

    /** move summary to archived store when leaving the room */
    writeArchivedData(data: SummaryData, txn: Transaction): SummaryData | undefined {
        if (data !== this._data) {
            txn.archivedRoomSummary.set(data.serialize());
            return data;
        }
    }

    async writeAndApplyData(data: SummaryData, storage: Storage): Promise<boolean> {
        if (data === this._data) {
            return false;
        }
        const txn = await storage.readWriteTxn([
            storage.storeNames.roomSummary,
        ]);
        try {
            txn.roomSummary.set(data.serialize());
        } catch (err) {
            txn.abort();
            throw err;
        }
        await txn.complete();
        this.applyChanges(data);
        return true;
    }

    applyChanges(data: SummaryData) {
        this._data = data;
        // clear cloned flag, so cloneIfNeeded makes a copy and
        // this._data is not modified if any field is changed.
        this._data.cloned = false;
    }

	async load(summary: SummaryData | SerializedSummaryData) {
        this.applyChanges(new SummaryData(summary));
	}
}

export function tests() {
    return {
        "serialize doesn't include null fields or cloned": assert => {
            const roomId = "!123:hs.tld";
            const data = new SummaryData(undefined, roomId);
            const clone = data.cloneIfNeeded();
            const serialized = clone.serialize();
            assert.strictEqual((serialized as SerializedSummaryData & {cloned?: any}).cloned, undefined);
            assert.equal(serialized.roomId, roomId);
            const nullCount = Object.values(serialized).reduce((count, value) => (count as any) + (value as any) === null ? 1 : 0, 0);
            assert.strictEqual(nullCount, 0);
        }
    }
}
