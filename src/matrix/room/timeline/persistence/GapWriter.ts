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

import {EventKey} from "../EventKey";
import {EventEntry} from "../entries/EventEntry";
import {createEventEntry, directionalAppend} from "./common";
import {RoomMember} from "../../members/RoomMember";
import {RoomEventType} from "../../../net/types/roomEvents";
import {MemberStateEvent} from "../../../net/types/roomEvents";
import type {Storage} from "../../../storage/idb/Storage";

type Options = {
    roomId: string;
    storage: Storage;
    fragmentIdComparer: FragmentIdComparer;
    relationWriter: RelationWriter;
};

export class GapWriter {
    private _roomId: string;
    private _storage: Storage;
    private _fragmentIdComparer: FragmentIdComparer;
    private _relationWriter: RelationWriter;

    constructor({roomId, storage, fragmentIdComparer, relationWriter}: Options) {
        this._roomId = roomId;
        this._storage = storage;
        this._fragmentIdComparer = fragmentIdComparer;
        this._relationWriter = relationWriter;
    }

    async _findOverlappingEvents(
        fragmentEntry: FragmentBoundaryEntry,
        events: any[],
        txn: Transaction,
        log: ILogItem
    ): Promise<{
        nonOverlappingEvents: any[];
        neighbourFragmentEntry: FragmentBoundaryEntry;
    }> {
        const eventIds = events.map(e => e.event_id);
        const existingEventKeyMap = await txn.timelineEvents.getEventKeysForIds(this._roomId, eventIds);
        log.set("existingEvents", existingEventKeyMap.size);
        const nonOverlappingEvents = events.filter(e => !existingEventKeyMap.has(e.event_id));
        log.set("nonOverlappingEvents", nonOverlappingEvents.length);
        let neighbourFragmentEntry: FragmentBoundaryEntry;
        if (fragmentEntry.hasLinkedFragment) {
            log.set("linkedFragmentId", fragmentEntry.linkedFragmentId);
            for (const eventKey of existingEventKeyMap.values()) {
                if (eventKey.fragmentId === fragmentEntry.linkedFragmentId) {
                    log.set("foundLinkedFragment", true);
                    const neighbourFragment = await txn.timelineFragments.get(this._roomId, fragmentEntry.linkedFragmentId);
                    neighbourFragmentEntry = fragmentEntry.createNeighbourEntry(neighbourFragment);
                    break;
                }
            }
        }
        return {nonOverlappingEvents, neighbourFragmentEntry};
    }

    async _findFragmentEdgeEventKey(fragmentEntry: FragmentBoundaryEntry, txn: Transaction): Promise<EventKey> {
        const {fragmentId, direction} = fragmentEntry;
        const event = await this._findFragmentEdgeEvent(fragmentId, direction, txn);
        if (event) {
            return new EventKey(event.fragmentId, event.eventIndex);
        } else {
            // no events yet in the fragment ... odd, but let's not fail and take the default key
            return EventKey.defaultFragmentKey(fragmentEntry.fragmentId);
        }
    }

    async _findFragmentEdgeEvent(fragmentId: number, direction: Direction, txn: Transaction): Promise<TimelineEventEntry> {
        if (direction.isBackward) {
            const [firstEvent] = await txn.timelineEvents.firstEvents(this._roomId, fragmentId, 1);
            return firstEvent;
        } else {
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, fragmentId, 1);
            return lastEvent;
        }
    }

    async _storeEvents(
        events: any[],
        startKey: EventKey,
        direction: Direction,
        state: StateEvent[],
        txn: Transaction,
        log: ILogItem
    ): Promise<{ entries: EventEntry[]; updatedEntries: EventEntry[] }> {
        const entries: EventEntry[] = [];
        const updatedEntries: EventEntry[] = [];
        // events is in reverse chronological order for backwards pagination,
        // e.g. order is moving away from the `from` point.
        let key = startKey;
        for (let i = 0; i < events.length; ++i) {
            const event = events[i];
            key = key.nextKeyForDirection(direction);
            const eventStorageEntry = createEventEntry(key, this._roomId, event);
            const member = this._findMember(event.sender, state, events, i, direction);
            if (member) {
                eventStorageEntry.displayName = member.displayName;
                eventStorageEntry.avatarUrl = member.avatarUrl;
            }
            // this will modify eventStorageEntry if it is a relation target
            const updatedRelationTargetEntries = await this._relationWriter.writeGapRelation(eventStorageEntry, direction, txn, log);
            if (updatedRelationTargetEntries) {
                updatedEntries.push(...updatedRelationTargetEntries);
            }
            if (await txn.timelineEvents.tryInsert(eventStorageEntry, log)) {
                const eventEntry = new EventEntry(eventStorageEntry, this._fragmentIdComparer);
                directionalAppend(entries, eventEntry, direction);
            }
        }
        return {entries, updatedEntries};
    }

    _findMember(
        userId: string,
        state: StateEvent[],
        events: StateEvent[],
        index: number,
        direction: Direction
    ): RoomMember | undefined {
        function isOurUser(event: StateEvent): boolean {
            return event.type === RoomEventType.Member && event.state_key === userId;
        }
        // older messages are at a higher index in the array when going backwards
        const inc = direction.isBackward ? 1 : -1;
        for (let i = index + inc; i >= 0 && i < events.length; i += inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromMemberEvent(this._roomId, event as MemberStateEvent);
            }
        }
        // look into newer events, but using prev_content if found.
        // We do this before looking into `state` because it is not well specified
        // in the spec whether the events in there represent state before or after `chunk`.
        // So we look both directions first in chunk to make sure it doesn't matter.
        for (let i = index; i >= 0 && i < events.length; i -= inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromReplacingMemberEvent(this._roomId, event);
            }
        }
        // assuming the member hasn't changed within the chunk, just take it from state if it's there.
        // Don't assume state is set though, as it can be empty at the top of the timeline in some circumstances
        const stateMemberEvent = state?.find(isOurUser);
        if (stateMemberEvent) {
            return RoomMember.fromMemberEvent(this._roomId, stateMemberEvent as MemberStateEvent);
        }
    }

    async _updateFragments(
        fragmentEntry: FragmentBoundaryEntry,
        neighbourFragmentEntry: FragmentBoundaryEntry,
        end: string,
        entries: EventEntry[],
        txn: Transaction,
        log: ILogItem
    ): Promise<FragmentEntry[]> {
        const {direction} = fragmentEntry;
        const changedFragments: FragmentEntry[] = [];
        directionalAppend(entries, fragmentEntry, direction);
        // set `end` as token, and if we found an event in the step before, link up the fragments in the fragment entry
        if (neighbourFragmentEntry) {
            // if neighbourFragmentEntry was found, it means the events were overlapping,
            // so no pagination should happen anymore.
            log.set("closedGapWith", neighbourFragmentEntry.fragmentId);
            neighbourFragmentEntry.token = null;
            fragmentEntry.token = null;

            txn.timelineFragments.update(neighbourFragmentEntry.fragment);
            directionalAppend(entries, neighbourFragmentEntry, direction);

            // fragments that need to be changed in the fragmentIdComparer here
            // after txn succeeds
            changedFragments.push(fragmentEntry.fragment);
            changedFragments.push(neighbourFragmentEntry.fragment);
        } else {
            fragmentEntry.token = end;
        }
        txn.timelineFragments.update(fragmentEntry.fragment);

        return changedFragments;
    }

    async writeFragmentFill(
        fragmentEntry: FragmentBoundaryEntry,
        response: any,
        txn: Transaction,
        log: ILogItem
    ): Promise<{
        entries: EventEntry[];
        updatedEntries: EventEntry[];
        fragments: FragmentEntry[];
    }> {
        const {fragmentId, direction} = fragmentEntry;
        // chunk is in reverse-chronological order when backwards
        const {chunk, start, state}: {chunk: any[], start: number, state: StateEvent[]} = response;
        let {end}: {end: string} = response;

        if (!Array.isArray(chunk)) {
            throw new Error("Invalid chunk in response");
        }
        if (typeof end !== "string" && typeof end !== "undefined") {
            throw new Error("Invalid end token in response");
        }

        // make sure we have the latest fragment from the store
        const fragment = await txn.timelineFragments.get(this._roomId, fragmentId);
        if (!fragment) {
            throw new Error(`Unknown fragment: ${fragmentId}`);
        }
        fragmentEntry = fragmentEntry.withUpdatedFragment(fragment);
        // check that the request was done with the token we are aware of (extra care to avoid timeline corruption)
        if (fragmentEntry.token !== start) {
            throw new Error("start is not equal to prev_batch or next_batch");
        }

        // begin (or end) of timeline reached
        if (chunk.length === 0) {
            fragmentEntry.edgeReached = true;
            await txn.timelineFragments.update(fragmentEntry.fragment);
            return {entries: [fragmentEntry], updatedEntries: [], fragments: []};
        }

        // find last event in fragment so we get the eventIndex to begin creating keys at
        let lastKey = await this._findFragmentEdgeEventKey(fragmentEntry, txn);
        log.set("lastKey", lastKey.toString());
        // find out if any event in chunk is already present using findFirstOrLastOccurringEventId
        const {
            nonOverlappingEvents,
            neighbourFragmentEntry
        } = await this._findOverlappingEvents(fragmentEntry, chunk, txn, log);
        // create entries for all events in chunk, add them to entries
        const {entries, updatedEntries} = await this._storeEvents(nonOverlappingEvents, lastKey, direction, state, txn, log);
        const fragments = await this._updateFragments(fragmentEntry, neighbourFragmentEntry, end, entries, txn, log);

        return {entries, updatedEntries, fragments};
    }
}

import {FragmentIdComparer} from "../FragmentIdComparer";
import {RelationWriter} from "./RelationWriter";
import {createMockStorage} from "../../../../mocks/Storage";
import {FragmentBoundaryEntry} from "../entries/FragmentBoundaryEntry";
import {NullLogger, NullLogItem} from "../../../../logging/NullLogger";
import {TimelineMock, eventIds, eventId} from "../../../../mocks/TimelineMock";
import {SyncWriter} from "./SyncWriter";
import {MemberWriter} from "./MemberWriter";
import {KeyLimits} from "../../../storage/common";
import { Transaction } from "../../../storage/idb/Transaction";
import { ILogItem } from "../../../../logging/types";
import { Direction } from "../Direction";
import { TimelineEventEntry } from "../../../storage/idb/stores/TimelineEventStore";
import { StateEvent, TimelineEvent } from "../../../storage/types";
import { FragmentEntry } from "../../../storage/idb/stores/TimelineFragmentStore";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function tests() {
    const roomId = "!room:hs.tdl";
    const alice = "alice@hs.tdl";
    const logger = new NullLogItem(new NullLogger());

    async function createGapFillTxn(storage: Storage): Promise<Transaction> {
        return storage.readWriteTxn([
            storage.storeNames.roomMembers,
            storage.storeNames.pendingEvents,
            storage.storeNames.timelineEvents,
            storage.storeNames.timelineRelations,
            storage.storeNames.timelineFragments,
        ]);
    }

    async function setup(): Promise<{
        storage: Storage;
        txn: Transaction;
        fragmentIdComparer: FragmentIdComparer;
        gapWriter: GapWriter;
        syncWriter: SyncWriter;
        timelineMock: TimelineMock;
    }> {
        const storage = await createMockStorage();
        const txn = await createGapFillTxn(storage);
        const fragmentIdComparer = new FragmentIdComparer([]);
        const relationWriter = new RelationWriter({
            roomId, fragmentIdComparer, ownUserId: alice,
        });
        const gapWriter = new GapWriter({
            roomId, storage, fragmentIdComparer, relationWriter
        });
        const memberWriter = new MemberWriter(roomId);
        const syncWriter = new SyncWriter({
            roomId,
            fragmentIdComparer,
            memberWriter,
            relationWriter
        });
        return { storage, txn, fragmentIdComparer, gapWriter, syncWriter, timelineMock: new TimelineMock("") };
    }

    async function syncAndWrite(
        mocks: {
            storage?: Storage;
            txn: any;
            fragmentIdComparer: any;
            gapWriter?: GapWriter;
            syncWriter: SyncWriter;
            timelineMock: TimelineMock;
        },
        { previous, limit }: { previous?: any, limit?: any } = { previous: undefined, limit: undefined }
        ): Promise<{
            syncResponse: {
                next_batch: string;
                timeline: {
                    prev_batch: string;
                    events: TimelineEvent[];
                    limited: boolean;
                };
            };
            fragmentEntry: any;
        }> {
        const {txn, timelineMock, syncWriter, fragmentIdComparer} = mocks;
        const syncResponse = timelineMock.sync(previous?.next_batch, limit);
        const {newLiveKey} = await syncWriter.writeSync(syncResponse, false, false, txn, logger);
        syncWriter.afterSync(newLiveKey!);
        return {
            syncResponse,
            fragmentEntry: newLiveKey ? FragmentBoundaryEntry.start(
                await txn.timelineFragments.get(roomId, newLiveKey.fragmentId),
                fragmentIdComparer,
            ) : null,
        };
    }

    async function backfillAndWrite(mocks, fragmentEntry, limit): Promise<void> {
        const {txn, timelineMock, gapWriter} = mocks;
        const messageResponse = timelineMock.messages(fragmentEntry.token, undefined, fragmentEntry.direction.asApiString(), limit);
        await gapWriter.writeFragmentFill(fragmentEntry, messageResponse, txn, logger);
    }

    async function allFragmentEvents(mocks, fragmentId): Promise<any> {
        const {txn} = mocks;
        const entries = await txn.timelineEvents.eventsAfter(roomId, new EventKey(fragmentId, KeyLimits.minStorageKey));
        return entries.map(e => e.event);
    }

    async function fetchFragment(mocks, fragmentId): Promise<any> {
        const {txn} = mocks;
        return txn.timelineFragments.get(roomId, fragmentId);
    }

    function assertFilledLink(assert, fragment1, fragment2): void {
        assert.equal(fragment1.nextId, fragment2.id);
        assert.equal(fragment2.previousId, fragment1.id);
        assert.equal(fragment1.nextToken, null);
        assert.equal(fragment2.previousToken, null);
    }

    function assertGapLink(assert, fragment1, fragment2): void {
        assert.equal(fragment1.nextId, fragment2.id);
        assert.equal(fragment2.previousId, fragment1.id);
        assert.notEqual(fragment2.previousToken, null);
    }

    return {
        "Backfilling after one sync": async (assert): Promise<void> => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(30);
            const {fragmentEntry} = await syncAndWrite(mocks);
            await backfillAndWrite(mocks, fragmentEntry, 10);
            const events = await allFragmentEvents(mocks, fragmentEntry.fragmentId);
            assert.deepEqual(events.map(e => e.event_id), eventIds(10, 30));
            await mocks.txn.complete();
        },
        "Backfilling a fragment that is expected to close a gap, and does": async (assert): Promise<void> => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks, { limit: 10 });
            timelineMock.append(15);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, { previous: syncResponse, limit: 10 });
            await backfillAndWrite(mocks, secondFragmentEntry, 10);

            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertFilledLink(assert, firstFragment, secondFragment);
            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), eventIds(10, 25));
            await mocks.txn.complete();
        },
        "Backfilling a fragment that is expected to close a gap, but doesn't yet": async (assert): Promise<void> => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks, { limit: 10 });
            timelineMock.append(20);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, { previous: syncResponse, limit: 10 });
            await backfillAndWrite(mocks, secondFragmentEntry, 10);

            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertGapLink(assert, firstFragment, secondFragment);
            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), eventIds(10, 30));
            await mocks.txn.complete();
        },
        "Receiving a sync with the same events as the current fragment does not create infinite link": async (assert): Promise<void> => {
            const mocks = await setup();
            const { txn, timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: fragmentEntry} = await syncAndWrite(mocks, { limit: 10 });
            // Mess with the saved token to receive old events in backfill
            fragmentEntry.token = syncResponse.next_batch;
            txn.timelineFragments.update(fragmentEntry.fragment);
            await backfillAndWrite(mocks, fragmentEntry, 10);

            const fragment = await fetchFragment(mocks, fragmentEntry.fragmentId);
            assert.notEqual(fragment.nextId, fragment.id);
            assert.notEqual(fragment.previousId, fragment.id);
            await mocks.txn.complete();
        },
        "An event received by sync does not interrupt backfilling": async (assert): Promise<void> => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks, { limit: 10 });
            timelineMock.append(11);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, { previous: syncResponse, limit: 10 });
            timelineMock.insertAfter(eventId(9), 5);
            await backfillAndWrite(mocks, secondFragmentEntry, 10);

            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), [...eventIds(21,26), ...eventIds(10, 21)]);
            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertFilledLink(assert, firstFragment, secondFragment);
            await mocks.txn.complete();
        }
    };
}
