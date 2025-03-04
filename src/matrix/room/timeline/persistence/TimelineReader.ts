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

import {directionalConcat, directionalAppend} from "./common";
import {Direction} from "../Direction";
import {EventEntry} from "../entries/EventEntry";
import {FragmentBoundaryEntry} from "../entries/FragmentBoundaryEntry";
import type {Transaction} from "../../../storage/idb/Transaction";
import type {EventKey} from "../EventKey";
import type {FragmentIdComparer} from "../FragmentIdComparer";
import type {Storage} from "../../../storage/idb/Storage";
import type {StoreNames} from "../../../storage/common";
import type {ILogItem} from "../../../../logging/types";
import type {DecryptionRequest} from "../../BaseRoom";

class ReaderRequest {
    decryptRequest?: DecryptionRequest;
    private _promise: Promise<EventEntry[]>;

    constructor(fn: (r: any, log: ILogItem) => Promise<EventEntry[]>, log: ILogItem) {
        this._promise = fn(this, log);
    }

    complete(): Promise<EventEntry[]> {
        return this._promise;
    }

    dispose(): void {
        if (this.decryptRequest) {
            this.decryptRequest.dispose();
            this.decryptRequest = undefined;
        }
    }
}

/**
 * Raw because it doesn't do decryption and in the future it should not read relations either.
 * It is just about reading entries and following fragment links
 */
 async function readRawTimelineEntriesWithTxn(
    roomId: string,
    eventKey: EventKey | null,
    direction: Direction,
    amount: number,
    fragmentIdComparer: FragmentIdComparer,
    txn: Transaction
): Promise<EventEntry[]> {
    let entries: EventEntry[] = [];
    const timelineStore = txn.timelineEvents;
    const fragmentStore = txn.timelineFragments;

    while (entries.length < amount && eventKey) {
        let eventsWithinFragment;
        if (direction.isForward) {
            // TODO: should we pass amount - entries.length here?
            eventsWithinFragment = await timelineStore.eventsAfter(roomId, eventKey, amount);
        } else {
            eventsWithinFragment = await timelineStore.eventsBefore(roomId, eventKey, amount);
        }
        let eventEntries = eventsWithinFragment.map(e => new EventEntry(e, fragmentIdComparer));
        entries = directionalConcat(entries, eventEntries, direction);
        // prepend or append eventsWithinFragment to entries, and wrap them in EventEntry

        if (entries.length < amount) {
            const fragment = await fragmentStore.get(roomId, eventKey.fragmentId);
            // TODO: why does the first fragment not need to be added? (the next *is* added below)
            // it looks like this would be fine when loading in the sync island
            // (as the live fragment should be added already) but not for permalinks when we support them
            //
            // fragmentIdComparer.addFragment(fragment);
            let fragmentEntry = new FragmentBoundaryEntry(fragment, direction.isBackward, fragmentIdComparer);
            // append or prepend fragmentEntry, reuse func from GapWriter?
            directionalAppend(entries, fragmentEntry, direction);
            // only continue loading if the fragment boundary can't be backfilled
            if (!fragmentEntry.token && fragmentEntry.hasLinkedFragment) {
                const nextFragment = await fragmentStore.get(roomId, fragmentEntry.linkedFragmentId);
                fragmentIdComparer.add(nextFragment);
                const nextFragmentEntry = new FragmentBoundaryEntry(nextFragment, direction.isForward, fragmentIdComparer);
                directionalAppend(entries, nextFragmentEntry, direction);
                eventKey = nextFragmentEntry.asEventKey();
            } else {
                eventKey = null;
            }
        }
    }
    return entries;
}

type Options = {roomId: string, storage: Storage, fragmentIdComparer: FragmentIdComparer};

type DecryptEntriesFn = (entries: EventEntry[], txn: Transaction, log?: ILogItem) => DecryptionRequest;

export class TimelineReader {
    private _roomId: string;
    private _storage: Storage;
    private _fragmentIdComparer: FragmentIdComparer;
    private _decryptEntries?: DecryptEntriesFn;

    constructor({roomId, storage, fragmentIdComparer}: Options) {
        this._roomId = roomId;
        this._storage = storage;
        this._fragmentIdComparer = fragmentIdComparer;

    }

    enableEncryption(decryptEntries: DecryptEntriesFn | undefined): void {
        this._decryptEntries = decryptEntries;
    }

    get readTxnStores(): StoreNames[] {
        const stores = [
            this._storage.storeNames.timelineEvents,
            this._storage.storeNames.timelineFragments,
        ];
        if (this._decryptEntries) {
            stores.push(this._storage.storeNames.inboundGroupSessions);
        }
        return stores;
    }

    readFrom(eventKey: EventKey, direction: Direction, amount: number, log: ILogItem): ReaderRequest {
        return new ReaderRequest(async (r: any, log: ILogItem): Promise<EventEntry[]> => {
            const txn = await this._storage.readTxn(this.readTxnStores);
            return await this._readFrom(eventKey, direction, amount, r, txn, log);
        }, log);
    }

    readFromEnd(amount: number, existingTxn: Transaction | undefined = undefined, log: any): ReaderRequest {
        return new ReaderRequest(async (r, log) => {
            const txn = existingTxn || await this._storage.readTxn(this.readTxnStores);
            const liveFragment = await txn.timelineFragments.liveFragment(this._roomId);
            let entries;
            // room hasn't been synced yet
            if (!liveFragment) {
                entries = [];
            } else {
                this._fragmentIdComparer.add(liveFragment);
                const liveFragmentEntry = FragmentBoundaryEntry.end(liveFragment, this._fragmentIdComparer);
                const eventKey = liveFragmentEntry.asEventKey();
                entries = await this._readFrom(eventKey, Direction.Backward, amount, r, txn, log);
                entries.unshift(liveFragmentEntry);
            }
            return entries;
        }, log);
    }

    async readById(id: string, log?: ILogItem): Promise<EventEntry | undefined> {
        let stores = [this._storage.storeNames.timelineEvents];
        if (this._decryptEntries) {
            stores.push(this._storage.storeNames.inboundGroupSessions);
        }
        const txn = await this._storage.readTxn(stores); // todo: can we just use this.readTxnStores here? probably
        const storageEntry = await txn.timelineEvents.getByEventId(this._roomId, id);
        if (storageEntry) {
            const entry = new EventEntry(storageEntry, this._fragmentIdComparer);
            if (this._decryptEntries) {
                const request = this._decryptEntries([entry], txn, log);
                await request.complete();
            }
            return entry;
        }
    }

    async _readFrom(eventKey: EventKey, direction: Direction, amount: number, r, txn: Transaction, log: ILogItem): Promise<EventEntry[]> {
        const entries = await readRawTimelineEntriesWithTxn(this._roomId, eventKey, direction, amount, this._fragmentIdComparer, txn);
        if (this._decryptEntries) {
            r.decryptRequest = this._decryptEntries(entries, txn, log);
            try {
                await r.decryptRequest.complete();
            } finally {
                r.decryptRequest = null;
            }
        }
        return entries;
    }
}
