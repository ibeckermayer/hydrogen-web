import {
    InstantMessageRoom,
    InstantMessageRoomPreparation,
    InstantMessageRoomWriteChanges,
} from './InstantMessageRoom';
import { IRoomManager } from './RoomManager';
import { Invite } from './Invite';
import { ArchivedRoom } from './ArchivedRoom';
import { IncomingRoomKey } from '../e2ee/megolm/decryption/RoomKey';
import { Transaction } from '../storage/idb/Transaction';
import { ILogItem } from '../../logging/types';
import { ObservableMap } from '../../observable';
import { InvitedRoom, JoinedRoom, LeftRoom, Rooms } from '../net/types/sync';
import { timelineIsEmpty } from '../Sync';
import { RoomStatus } from '../../lib';
import { StoreNames } from '../storage/common';
import { PendingEntry } from '../storage/idb/stores/PendingEventStore';
import { PendingEventData } from './sending/PendingEvent';
import { Session } from '../Session';
import { Membership } from '../net/types/roomEvents';
import { MemberData } from './members/RoomMember';

export class InstantMessageRoomManager implements IRoomManager<InstantMessageRoom, Invite, ArchivedRoom> {
    private _session?: Session;
    private _rooms: ObservableMap<string, InstantMessageRoom> = new ObservableMap();
    private _roomSyncStates: RoomSyncProcessState[] = [];
    private _invites: ObservableMap<string, Invite> = new ObservableMap();
    private _inviteSyncStates: InviteSyncProcessState[] = [];
    private _archivedRooms: ObservableMap<string, ArchivedRoom> = new ObservableMap();
    private _archivedRoomSyncStates: ArchivedRoomSyncProcessState[] = [];

    constructor() {
        // Bind to this so that it behaves correctly when passed to other objects.
        this._forgetArchivedRoom = this._forgetArchivedRoom.bind(this);
    }

    init(session: Session) {
        this._session = session;
    }

    get storesForLoad(): string[] {
        return [
            StoreNames.roomSummary,
            StoreNames.invites,
            StoreNames.roomMembers,
            StoreNames.timelineEvents,
            StoreNames.timelineFragments,
            StoreNames.pendingEvents,
        ]
    }

    async createLoadPromises(txn: Transaction, log: ILogItem): Promise<Promise<void>[]> {
        // const pendingEventsByRoomId = await this._getPendingEventsByRoom(txn);
        // const invites = await txn.invites.getAll();
        // const roomSummaries = await txn.roomSummary.getAll();
        const [pendingEventsByRoomId, invites, roomSummaries] = await Promise.all([this._getPendingEventsByRoom(txn), txn.invites.getAll(), txn.roomSummary.getAll()]);

        const inviteLoadPromises = invites.map(async inviteData => {
            const invite = this._createInvite(inviteData.roomId);
            if (log) { log.wrap("invite", log => invite.load(inviteData, log)); } else { invite.load(inviteData, log) };
            this._invites.add(invite.id, invite);
        });

        const roomLoadPromises = roomSummaries.map(async summary => {
            const room = this._createJoinedRoom(summary.roomId!, pendingEventsByRoomId.get(summary.roomId!));
            await log.wrap("room", log => room.load(summary, txn, log));
            this._rooms.add(room.id, room);
        });

        return [...inviteLoadPromises, ...roomLoadPromises]
    }

    async initSync(roomsResponse: Rooms | undefined, isInitialSync: boolean, log: ILogItem): Promise<void> {
        this._resetSyncStates();
        this._parseInvites(roomsResponse);
        await this._parseRoomsResponse(roomsResponse, isInitialSync, log);
    }

    get storesForPrepareSync(): string[] {
        return [
            StoreNames.inboundGroupSessions,
            // to read fragments when loading sync writer when rejoining archived room
            StoreNames.timelineFragments,
            // to read fragments when loading sync writer when rejoining archived room
            // to read events that can now be decrypted
            StoreNames.timelineEvents,
        ]
    }

    async prepareSync(
        roomsResponse: Rooms | undefined,
        newKeysByRoom: Map<string, IncomingRoomKey[]> | undefined,
        prepareTxn: Transaction,
        log: ILogItem
    ) {
        // add any rooms with new keys but no sync response to the list of rooms to be synced
        if (newKeysByRoom) {
            const { hasOwnProperty } = Object.prototype;
            for (const roomId of newKeysByRoom.keys()) {
                const isRoomInResponse =
                    roomsResponse?.join && hasOwnProperty.call(roomsResponse.join, roomId);
                if (!isRoomInResponse) {
                    let room = this._rooms?.get(roomId);
                    if (room) {
                        this._roomSyncStates.push(
                            new RoomSyncProcessState(room, false, {}, room.membership)
                        );
                    }
                }
            }
        }

        await Promise.all(this._roomSyncStates.map(async jrss => {
            const newKeys = newKeysByRoom?.get(jrss.room.id) ?? [];
            jrss.preparation = await log.wrap('room', async log => {
                // if previously joined and we still have the timeline for it,
                // this loads the syncWriter at the correct position to continue writing the timeline
                if (jrss.isNewRoom) {
                    await jrss.room.load(undefined, prepareTxn, log);
                }
                return jrss.room.prepareSync(
                    jrss.roomResponse, jrss.membership, newKeys, prepareTxn, log);
            }, log.level.Detail);
        }));
    }

    async afterPrepareSync(log: ILogItem): Promise<void> {
        await Promise.all(this._roomSyncStates.map(jrss => {
            return jrss.room.afterPrepareSync(jrss.preparation, log);
        }));
    }

    get storesForWriteSync(): string[] {
        return [
            StoreNames.roomSummary,
            StoreNames.archivedRoomSummary,
            StoreNames.invites,
            StoreNames.roomState,
            StoreNames.roomMembers,
            StoreNames.timelineEvents,
            StoreNames.timelineRelations,
            StoreNames.timelineFragments,
            StoreNames.pendingEvents,
        ]
    }

    async writeSync(syncTxn: Transaction, isInitialSync: boolean, log: ILogItem): Promise<void> {
        await Promise.all(this._inviteSyncStates.map(async irss => {
            irss.changes = await log.wrap("invite", log => irss.invite.writeSync(
                irss.membership, irss.roomResponse, syncTxn, log));
        }));
        await Promise.all(this._roomSyncStates.map(async jrss => {
            jrss.changes = await log.wrap("room", log => jrss.room.writeSync(
                jrss.preparation!, jrss.roomResponse, isInitialSync, syncTxn, log));
        }));
        // important to do this after this._joinRoomSyncStates,
        // as we're referring to the roomState to get the summaryChanges
        await Promise.all(this._archivedRoomSyncStates.map(async lrss => {
            const summaryChanges = lrss.roomState?.summaryChanges;
            lrss.changes = await log.wrap("archivedRoom", log => lrss.archivedRoom.writeSync(
                summaryChanges, lrss.roomResponse, lrss.membership, syncTxn, log));
        }));
    }

    async afterSync(log: ILogItem): Promise<void> {
        for(let ars of this._archivedRoomSyncStates) {
            log.wrap("archivedRoom", log => {
                ars.archivedRoom.afterSync(ars.changes, log);
                ars.archivedRoom.release();
            }, log.level.Detail);
        }
        for(let rs of this._roomSyncStates) {
            if (!rs.changes) throw new Error("missing changes")
            log.wrap("room", log => rs.room.afterSync(rs.changes!, log), log.level.Detail);
        }
        for(let is of this._inviteSyncStates) {
            log.wrap("invite", log => is.invite.afterSync(is.changes, log), log.level.Detail);
        }

        this._applyRoomCollectionChangesAfterSync(log);
    }

    async afterSyncCompleted(log: ILogItem): Promise<void> {
        const roomsPromises = this._roomSyncStates.map(async rss => {
            try {
                if (!rss.changes) throw new Error("missing changes")
                await rss.room.afterSyncCompleted(rss.changes, log);
            } catch (err) {} // error is logged, but don't fail roomsPromises
        });
        await Promise.all(roomsPromises)
    }

    async dispose() {
        for (const [_, room] of this._rooms) {
            room.dispose();
        }
    }

    get joinRooms(): ObservableMap<string, InstantMessageRoom> {
        return this._rooms;
    }
    get inviteRooms(): ObservableMap<string, Invite> {
        return this._invites;
    }
    get leaveRooms(): ObservableMap<string, ArchivedRoom> {
        return this._archivedRooms;
    }

    private get session(): Session {
        if (this._session === undefined) {
            throw new Error("cannot be used until init(session) has been called");
        }
        return this._session;
    }

    private _resetSyncStates() {
        this._roomSyncStates = [];
        this._inviteSyncStates = [];
        this._archivedRoomSyncStates = [];
    }

    private _parseInvites(roomsResponse?: Rooms) {
        if (roomsResponse?.invite) {
            for (const [roomId, _roomResponse] of Object.entries(roomsResponse.invite)) {
                const roomResponse = _roomResponse as InvitedRoom;
                let invite = this._invites.get(roomId);
                let isNewInvite = false;
                if (!invite) {
                    invite = this._createInvite(roomId);
                    isNewInvite = true;
                }
                this._inviteSyncStates.push(new InviteSyncProcessState(invite, isNewInvite, roomResponse, "invite"));
            }
        }
    }

    private async _parseRoomsResponse(
        roomsResponse: Rooms | undefined,
        isInitialSync: boolean,
        log: ILogItem
    ): Promise<void> {
        if (roomsResponse) {
            const allMemberships: ('join' | 'leave')[] = ['join', 'leave'];
            for (const membership of allMemberships) {
                const membershipSection = roomsResponse[membership];
                if (membershipSection) {
                    for (const [roomId, _roomResponse] of Object.entries(membershipSection)) {
                        const roomResponse: JoinedRoom | LeftRoom = _roomResponse;
                        // ignore rooms with empty timelines during initial sync,
                        // see https://github.com/vector-im/hydrogen-web/issues/15
                        if (isInitialSync && timelineIsEmpty(roomResponse)) {
                            continue;
                        }
                        const invite = this._invites.get(roomId);
                        // if there is an existing invite, add a process state for it
                        // so its writeSync and afterSync will run and remove the invite
                        if (invite) {
                            this._inviteSyncStates.push(new InviteSyncProcessState(invite, false, undefined, membership));
                        }
                        const roomState = this._createRoomSyncState( roomId, roomResponse, membership, isInitialSync);
                        if (roomState) {
                            this._roomSyncStates.push(roomState);
                        }
                        const ars = await this._createArchivedRoomSyncState(
                            roomId, roomState, roomResponse, membership, isInitialSync, log);
                        if (ars) {
                            this._archivedRoomSyncStates.push(ars);
                        }
                    }
                }
            }
        }
    }

    private _createRoomSyncState(roomId: string, roomResponse: JoinedRoom | LeftRoom, membership: "join" | "leave", isInitialSync: boolean): RoomSyncProcessState | undefined {
        let isNewRoom = false;
        let room = this._rooms.get(roomId);
        // create room only either on new join,
        // or for an archived room during initial sync,
        // where we create the summaryChanges with a joined
        // room to then adopt by the archived room.
        // This way the limited timeline, members, ...
        // we receive also gets written.
        // In any case, don't create a room for a rejected invite
        if (!room && (membership === "join" || (isInitialSync && membership === "leave"))) {
            room = this._createJoinedRoom(roomId);
            isNewRoom = true;
        }
        if (room) {
            return new RoomSyncProcessState(
                room, isNewRoom, roomResponse, membership);
        }
    }

    private async _createArchivedRoomSyncState(
        roomId: string,
        roomState: RoomSyncProcessState | undefined,
        roomResponse: JoinedRoom | LeftRoom,
        membership: 'join' | 'leave',
        isInitialSync: boolean,
        log: ILogItem
      ): Promise<ArchivedRoomSyncProcessState | undefined> {
        let archivedRoom: ArchivedRoom | undefined;
        if (roomState?.shouldAdd && !isInitialSync) {
            // when adding a joined room during incremental sync,
            // always create the archived room to write the removal
            // of the archived summary
            archivedRoom = this._createOrGetArchivedRoomForSync(roomId);
        } else if (membership === "leave") {
            if (roomState) {
                // we still have a roomState, so we just left it
                // in this case, create a new archivedRoom
                archivedRoom = this._createOrGetArchivedRoomForSync(roomId);
            } else {
                // this is an update of an already left room, restore
                // it from storage first, so we can increment it.
                // this happens for example when our membership changes
                // after leaving (e.g. being (un)banned, possibly after being kicked), etc
                archivedRoom = await this.loadArchivedRoom(roomId, log);
            }
        }
        if (archivedRoom) {
            return new ArchivedRoomSyncProcessState(
                archivedRoom, roomState, roomResponse, membership);
        }
    }

    /**
     * Creates an empty (summary isn't loaded) the archived room if it isn't
     * loaded already, assuming sync will either remove it (when rejoining) or
     * write a full summary adopting it from the joined room when leaving.
    */
    private _createOrGetArchivedRoomForSync(roomId: string): ArchivedRoom {
        let archivedRoom = this._archivedRooms.get(roomId);
        if (archivedRoom) {
            archivedRoom.retain();
        } else {
            archivedRoom = this._createArchivedRoom(roomId);
        }
        return archivedRoom;
    }

    private _applyRoomCollectionChangesAfterSync(log: ILogItem) {
        // update the collections after sync
        for (const rs of this._roomSyncStates) {
            if (rs.shouldAdd) {
                this._rooms?.add(rs.id, rs.room);
                this.session._tryReplaceRoomBeingCreated(rs.id, log);
            } else if (rs.shouldRemove) {
                this._rooms?.remove(rs.id);
            }
        }
        for (const is of this._inviteSyncStates) {
            if (is.shouldAdd) {
                this._invites.add(is.id, is.invite);
            } else if (is.shouldRemove) {
                this._invites.remove(is.id);
            }
        }
        // now all the collections are updated, update the room status
        // so any listeners to the status will find the collections
        // completely up to date
        if (this.session._observedRoomStatus.size !== 0) {
            for (const ars of this._archivedRoomSyncStates) {
                if (ars.shouldAdd) {
                    this.session._observedRoomStatus.get(ars.id)?.set(RoomStatus.Archived);
                }
            }
            for (const rs of this._roomSyncStates) {
                if (rs.shouldAdd) {
                    this.session._observedRoomStatus.get(rs.id)?.set(RoomStatus.Joined);
                }
            }
            for (const is of this._inviteSyncStates) {
                const statusObservable = this.session._observedRoomStatus.get(is.id);
                if (statusObservable) {
                    const withInvited = statusObservable.get() | RoomStatus.Invited;
                    if (is.shouldAdd) {
                        statusObservable.set(withInvited);
                    } else if (is.shouldRemove) {
                        const withoutInvited = withInvited ^ RoomStatus.Invited;
                        statusObservable.set(withoutInvited);
                    }
                }
            }
        }
    }

    private async _getPendingEventsByRoom(txn: Transaction): Promise<Map<string, [PendingEntry]>> {
        const pendingEvents = await txn.pendingEvents.getAll();
        return pendingEvents.reduce((groups, pe) => {
            const group = groups.get(pe.roomId);
            if (group) {
                group.push(pe);
            } else {
                groups.set(pe.roomId, [pe]);
            }
            return groups;
        }, new Map<string, [PendingEntry]>());
    }

    private _createInvite(roomId: string): Invite {
        return new Invite({
            roomId,
            hsApi: this.session.hsApi,
            emitCollectionUpdate: (invite: Invite, params: any) => this._invites.update(invite.id, params),
            mediaRepository: this.session.mediaRepository,
            user: this.session.user,
            platform: this.session.platform,
        });
    }

    private _createJoinedRoom(roomId: string, pendingEvents?: PendingEventData[]): InstantMessageRoom {
        return new InstantMessageRoom({
            roomId,
            getSyncToken: this.session._getSyncToken,
            storage: this.session.storage,
            emitCollectionChange: (room, params) => this._rooms?.update(room.id, params),
            hsApi: this.session.hsApi,
            mediaRepository: this.session.mediaRepository,
            pendingEvents,
            user: this.session.user,
            createRoomEncryption: this.session._createRoomEncryption,
            platform: this.session.platform
        });
    }

    loadArchivedRoom(roomId: string, log?: ILogItem): ArchivedRoom | undefined {
        return this.session.platform.logger.wrapOrRun(log, "loadArchivedRoom", async log => {
            log.set("id", roomId);
            const activeArchivedRoom = this._archivedRooms.get(roomId);
            if (activeArchivedRoom) {
                activeArchivedRoom.retain();
                return activeArchivedRoom;
            }
            const txn = await this.session.storage.readTxn([
                this.session.storage.storeNames.archivedRoomSummary,
                this.session.storage.storeNames.roomMembers,
            ]);
            const summary = await txn.archivedRoomSummary.get(roomId);
            if (summary) {
                const room = this._createArchivedRoom(roomId);
                await room.load(summary, txn, log);
                return room;
            }
        });
    }

    private _forgetArchivedRoom(roomId: string) {
        const statusObservable = this.session._observedRoomStatus.get(roomId);
        if (statusObservable) {
            statusObservable.set((statusObservable.get() | RoomStatus.Archived) ^ RoomStatus.Archived);
        }
    }

    /** @internal */
    private _createArchivedRoom(roomId: string): ArchivedRoom {
        const room = new ArchivedRoom({
            roomId,
            getSyncToken: this.session._getSyncToken,
            storage: this.session.storage,
            emitCollectionChange: () => {},
            releaseCallback: () => this._archivedRooms.remove(roomId),
            forgetCallback: this._forgetArchivedRoom,
            hsApi: this.session.hsApi,
            mediaRepository: this.session.mediaRepository,
            user: this.session.user,
            createRoomEncryption: this.session._createRoomEncryption,
            platform: this.session.platform
        });
        this._archivedRooms.set(roomId, room);
        return room;
    }
}

class RoomSyncProcessState {
    /**
     * @param {Object} roomResponse - a matrix Joined Room type or matrix Left Room type
     */
    room: InstantMessageRoom;
    isNewRoom: boolean;
    roomResponse: JoinedRoom | LeftRoom;
    membership?: Membership;
    preparation?: InstantMessageRoomPreparation;
    changes?: InstantMessageRoomWriteChanges;

    constructor(room: InstantMessageRoom, isNewRoom: boolean, roomResponse: JoinedRoom | LeftRoom, membership?: Membership) {
        this.room = room;
        this.isNewRoom = isNewRoom;
        this.roomResponse = roomResponse;
        this.membership = membership;
    }

    get id() {
        return this.room.id;
    }

    get shouldAdd() {
        return this.isNewRoom && this.membership === "join";
    }

    get shouldRemove() {
        return !this.isNewRoom && this.membership !== "join";
    }

    get summaryChanges() {
        return this.changes?.summaryChanges;
    }
}


class ArchivedRoomSyncProcessState {
    archivedRoom: ArchivedRoom;
    roomState: RoomSyncProcessState | undefined;
    roomResponse: JoinedRoom | LeftRoom;
    membership: "join" | "leave";
    isInitialSync?: boolean;
    changes?: {};

    constructor(archivedRoom: ArchivedRoom, roomState: RoomSyncProcessState | undefined, roomResponse: JoinedRoom | LeftRoom, membership: "join" | "leave", isInitialSync?: boolean) {
        this.archivedRoom = archivedRoom;
        this.roomState = roomState;
        this.roomResponse = roomResponse;
        this.membership = membership;
        this.isInitialSync = isInitialSync;
    }

    get id(): string {
        return this.archivedRoom.id;
    }

    get shouldAdd(): boolean | undefined {
        return (this.roomState || this.isInitialSync) && this.membership === "leave";
    }

    get shouldRemove(): boolean {
        return this.membership === "join";
    }
}

// TODO: move this to a more appropriate file
// https://spec.matrix.org/v1.4/client-server-api/#mroomjoin_rules
type JoinRule = "public" | "knock" | "invite" | "private" | "restricted"

// TODO: move to Invite.js when that gets converted to typescript.
// It's the return value of Invite._createData().
type InviteData = {
    roomId: string,
    isEncrypted: boolean,
    isDirectMessage: boolean,
    name?: string,
    avatarUrl?: string,
    avatarColorId: string | null,
    canonicalAlias: string | null,
    timestamp: number,
    joinRule: JoinRule | null,
    inviter?: MemberData,
}

// TODO: move to Invite.js when that gets converted to typescript.
// It's the return value of Invite.writeSync().
type InviteWriteSyncChanges =
  | { removed: true; membership: "join" | "leave" | "invite" }
  | { inviteData: InviteData; inviter?: MemberData };

class InviteSyncProcessState {
    invite: Invite;
    isNewInvite: boolean;
    roomResponse: InvitedRoom | undefined;
    membership: "join" | "leave" | "invite";
    changes?: InviteWriteSyncChanges;

    constructor(invite: Invite, isNewInvite: boolean, roomResponse: InvitedRoom | undefined, membership: "join" | "leave" | "invite") {
        this.invite = invite;
        this.isNewInvite = isNewInvite;
        this.membership = membership;
        this.roomResponse = roomResponse;
    }

    get id(): string {
        return this.invite.id;
    }

    get shouldAdd(): boolean {
        return this.isNewInvite;
    }

    get shouldRemove(): boolean {
        return this.membership !== "invite";
    }
}

