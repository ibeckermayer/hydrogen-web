/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020, 2021 The Matrix.org Foundation C.I.C.

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

import {ObservableValue, RetainedObservableValue} from "../observable/ObservableValue";

import type {InstantMessageRoom, InstantMessageRoomPreparation, InstantMessageRoomWriteChanges} from "./room/InstantMessageRoom";
import type {LogItem} from "../logging/LogItem";
import type {ILogger, ILogItem} from "../logging/types";
import type {HomeServerApi} from "./net/HomeServerApi";
import type {IHomeServerRequest} from "./net/HomeServerRequest";
import type {JoinedRoom, LeftRoom, InvitedRoom, Rooms, SyncResponse} from "./net/types/sync";
import type {Session, Changes} from "./Session";
import type {Storage} from "./storage/idb/Storage";
import type {ILock} from "../utils/Lock";
import type {SyncPreparation} from "./DeviceMessageHandler";
import type {MemberData} from "./room/members/RoomMember";
import type {ArchivedRoom} from "./room/ArchivedRoom";
import type {Invite} from "./room/Invite";
import type {Transaction} from "./storage/idb/Transaction";
import { Membership } from "./net/types/roomEvents";
import { RoomStatus } from "./room/common";

const INCREMENTAL_TIMEOUT = 30000;

export enum SyncStatus {
    InitialSync = "InitialSync",
    CatchupSync = "CatchupSync",
    Syncing = "Syncing",
    Stopped = "Stopped"
}

export function timelineIsEmpty(roomResponse: JoinedRoom | LeftRoom): boolean {
    try {
        const events = roomResponse?.timeline?.events;
        return Array.isArray(events) && events.length === 0;
    } catch (err) {
        return true;
    }
}

type Options = {
    hsApi: HomeServerApi,
    session: Session,
    storage: Storage,
    logger: ILogger
}

/**
 * Sync steps in js-pseudocode:
 * ```js
 * // can only read some stores
 * const preparation = await room.prepareSync(roomResponse, membership, newRoomKeys, prepareTxn);
 * // can do async work that is not related to storage (such as decryption)
 * await room.afterPrepareSync(preparation);
 * // writes and calculates changes
 * const changes = await room.writeSync(roomResponse, isInitialSync, preparation, syncTxn);
 * // applies and emits changes once syncTxn is committed
 * room.afterSync(changes);
 * // can do network requests
 * await room.afterSyncCompleted(changes);
 * ```
 */
export class Sync {
    private _hsApi: HomeServerApi;
    private _logger: ILogger;
    private _session: Session;
    private _storage: Storage;
    private _currentRequest?: IHomeServerRequest<any> | IHomeServerRequest<SyncResponse>
    private _status = new ObservableValue(SyncStatus.Stopped);
    private _error?: any;

    constructor({hsApi, session, storage, logger}: Options) {
        this._hsApi = hsApi;
        this._logger = logger;
        this._session = session;
        this._storage = storage;
    }

    get status(): ObservableValue<SyncStatus> {
        return this._status;
    }

    /** the error that made the sync stop */
    get error(): any {
        return this._error;
    }

    start() {
        // not already syncing?
        if (this._status.get() !== SyncStatus.Stopped) {
            return;
        }
        this._error = null;
        let syncToken = this._session.syncToken;
        if (syncToken) {
            this._status.set(SyncStatus.CatchupSync);
        } else {
            this._status.set(SyncStatus.InitialSync);
        }
        void this._syncLoop(syncToken);
    }

    async _syncLoop(syncToken?: string): Promise<void> {
        // if syncToken is falsy, it will first do an initial sync ...
        while(this._status.get() !== SyncStatus.Stopped) {
            let sessionChanges: Changes | undefined;
            let wasCatchupOrInitial = this._status.get() === SyncStatus.CatchupSync || this._status.get() === SyncStatus.InitialSync;
            await this._logger.run("sync", async log => {
                log.set("token", syncToken);
                log.set("status", this._status.get());
                try {
                    // unless we are happily syncing already, we want the server to return
                    // as quickly as possible, even if there are no events queued. This
                    // serves two purposes:
                    //
                    // * When the connection dies, we want to know asap when it comes back,
                    //   so that we can hide the error from the user. (We don't want to
                    //   have to wait for an event or a timeout).
                    //
                    // * We want to know if the server has any to_device messages queued up
                    //   for us. We do that by calling it with a zero timeout until it
                    //   doesn't give us any more to_device messages.
                    const timeout = this._status.get() === SyncStatus.Syncing ? INCREMENTAL_TIMEOUT : 0;
                    const syncResult = await this._syncRequest(syncToken, timeout, log);
                    syncToken = syncResult.syncToken;
                    sessionChanges = syncResult.sessionChanges;
                    // initial sync or catchup sync
                    if (this._status.get() !== SyncStatus.Syncing && syncResult.hadToDeviceMessages) {
                        this._status.set(SyncStatus.CatchupSync);
                    } else {
                        this._status.set(SyncStatus.Syncing);
                    }
                } catch (err) {
                    // retry same request on timeout
                    if (err.name === "ConnectionError" && err.isTimeout) {
                        // don't run afterSyncCompleted
                        return;
                    }
                    this._error = err;
                    if (err.name !== "AbortError") {
                        // sync wasn't asked to stop, but is stopping
                        // because of the error.
                        log.error = err;
                        log.logLevel = log.level.Fatal;
                    }
                    log.set("stopping", true);
                    this._status.set(SyncStatus.Stopped);
                }
                if (this._status.get() !== SyncStatus.Stopped) {
                    // TODO: if we're not going to run this phase in parallel with the next
                    // sync request (because this causes OTKs to be uploaded twice)
                    // should we move this inside _syncRequest?
                    // Alternatively, we can try to fix the OTK upload issue while still
                    // running in parallel.
                    await log.wrap("afterSyncCompleted", log => this._afterSyncCompleted(sessionChanges, log));
                }
            },
            this._logger.level.Info,
            (filter, log: LogItem) => {
                if (log.durationWithoutType("network") || 0 >= 2000 || log.error || wasCatchupOrInitial) {
                    return filter.minLevel(log.level.Detail);
                } else {
                    return filter.minLevel(log.level.Info);
                }
            });
        }
    }

    async _afterSyncCompleted(sessionChanges: Changes | undefined, log: ILogItem): Promise<void> {
        const isCatchupSync = this._status.get() === SyncStatus.CatchupSync;
        try {
            await log.wrap("session", log => this._session.afterSyncCompleted(sessionChanges, isCatchupSync, log));
        } catch (err) {} // error is logged, but don't fail sessionPromise
        for (const roomTypeManager of this._session.roomManagers.values()) {
            await roomTypeManager.afterSyncCompleted(log);
        }
    }

    async _syncRequest(
        syncToken: string | undefined,
        timeout: number,
        log: ILogItem
      ): Promise<{
        syncToken: string;
        sessionChanges?: Changes;
        hadToDeviceMessages: boolean;
      }> {
        let {syncFilterId} = this._session;
        if (typeof syncFilterId !== "string") {
            this._currentRequest = this._hsApi.createFilter(this._session.user.id, {room: {state: {lazy_load_members: true}}}, {log});
            syncFilterId = (await this._currentRequest.response()).filter_id;
        }
        const totalRequestTimeout = timeout + (80 * 1000);  // same as riot-web, don't get stuck on wedged long requests
        this._currentRequest = this._hsApi.sync(syncToken, syncFilterId, timeout, {timeout: totalRequestTimeout, log});
        const response = await (this._currentRequest as IHomeServerRequest<SyncResponse>).response();

        const isInitialSync = !syncToken;
        const sessionState = new SessionSyncProcessState();

        for (const roomTypeManager of this._session.roomManagers.values()) {
            await roomTypeManager.initSync(response.rooms, isInitialSync, log);
        }

        try {
            // take a lock on olm sessions used in this sync so sending a message doesn't change them while syncing
            sessionState.lock = await log.wrap("obtainSyncLock", () => this._session.obtainSyncLock(response));
            await log.wrap("prepare", log => this._prepareSync(sessionState, response, log));
            await log.wrap("afterPrepareSync", log => this._afterPrepareSync(log));
            await log.wrap("write", async log => this._writeSync(sessionState, response, syncFilterId, isInitialSync, log));
        } finally {
            sessionState.dispose();
        }
        // sync txn comitted, emit updates and apply changes to in-memory state
        log.wrap("after", log => this._afterSync(sessionState, log));

        const toDeviceEvents = response.to_device?.events;
        return {
            syncToken: response.next_batch,
            sessionChanges: sessionState.changes,
            hadToDeviceMessages: Array.isArray(toDeviceEvents) && toDeviceEvents.length > 0,
        };
    }

    _openPrepareSyncTxn(): Promise<Transaction> {
        const storeNames = this._storage.storeNames;
        let prepareSyncStoreNames: string[] = [storeNames.olmSessions];
        for (const roomTypeManager of this._session.roomManagers.values()) {
            prepareSyncStoreNames = [...prepareSyncStoreNames, ...roomTypeManager.storesForPrepareSync]
        }
        // dedup just in case
        prepareSyncStoreNames = [...new Set(prepareSyncStoreNames)];

        return this._storage.readTxn(prepareSyncStoreNames);
    }

    async _prepareSync(sessionState: SessionSyncProcessState, syncResponse: SyncResponse, log: ILogItem): Promise<void> {
        const prepareTxn = await this._openPrepareSyncTxn();
        sessionState.preparation = await log.wrap("session", log => this._session.prepareSync(
            syncResponse, sessionState.lock, prepareTxn, log));

        const newKeysByRoom = sessionState.preparation?.newKeysByRoom;

        for (const roomTypeManager of this._session.roomManagers.values()) {
            await roomTypeManager.prepareSync(syncResponse.rooms, newKeysByRoom, prepareTxn, log);
        }

        // This is needed for safari to not throw TransactionInactiveErrors on the syncTxn. See docs/INDEXEDDB.md
        await prepareTxn.complete();
    }

    async _afterPrepareSync(log: ILogItem) {
        for (const roomTypeManager of this._session.roomManagers.values()) {
            await roomTypeManager.afterPrepareSync(log);
        }
    }

    async _writeSync(
        sessionState: SessionSyncProcessState,
        response: SyncResponse,
        syncFilterId: number | undefined,
        isInitialSync: boolean,
        log: ILogItem,
      ): Promise<void> {
        const writeSyncTxn = await this._openWriteSyncTxn();
        try {
            sessionState.changes = await log.wrap("session", log => this._session.writeSync(
                response, syncFilterId, sessionState.preparation, writeSyncTxn, log));
            for (const roomTypeManager of this._session.roomManagers.values()) {
                await roomTypeManager.writeSync(writeSyncTxn, isInitialSync, log);
            }
        } catch(err) {
            // avoid corrupting state by only
            // storing the sync up till the point
            // the exception occurred
            writeSyncTxn.abort(log);
            throw writeSyncTxn.getCause(err);
        }
        await writeSyncTxn.complete(log);
    }

    async _afterSync(
        sessionState: SessionSyncProcessState,
        log: ILogItem
    ): Promise<void> {
        log.wrap("session", log => this._session.afterSync(sessionState.changes), log.level.Detail);
        for (const roomTypeManager of this._session.roomManagers.values()) {
            await roomTypeManager.afterSync(log);
        }
    }

    _openWriteSyncTxn(): Promise<Transaction> {
        const storeNames = this._storage.storeNames;
        let writeSyncStoreNames: string[] = [
            storeNames.session,
            storeNames.userIdentities,
            storeNames.groupSessionDecryptions,
            storeNames.deviceIdentities,
            // to discard outbound session when somebody leaves a room
            // and to create room key messages when somebody joins
            storeNames.outboundGroupSessions,
            storeNames.operations,
            storeNames.accountData,
            // to decrypt and store new room keys
            storeNames.olmSessions,
            storeNames.inboundGroupSessions,
        ]
        for (const roomTypeManager of this._session.roomManagers.values()) {
            writeSyncStoreNames = [...writeSyncStoreNames, ...roomTypeManager.storesForWriteSync]
        }
        // dedup just in case
        writeSyncStoreNames = [...new Set(writeSyncStoreNames)];
        return this._storage.readWriteTxn(writeSyncStoreNames);
    }

    stop() {
        if (this._status.get() === SyncStatus.Stopped) {
            return;
        }
        this._status.set(SyncStatus.Stopped);
        if (this._currentRequest) {
            this._currentRequest.abort();
            this._currentRequest = undefined;
        }
    }
}

class SessionSyncProcessState {
    lock?: ILock;
    preparation?: SyncPreparation;
    changes: Changes;

    dispose() {
        this.lock?.release();
    }
}