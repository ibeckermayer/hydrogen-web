import { ILogItem } from '../../logging/types';
import { ObservableMap } from '../../observable';
import { IncomingRoomKey } from '../e2ee/megolm/decryption/RoomKey';
import { Rooms } from '../net/types/sync';
import { Session } from '../Session';
import { Transaction } from '../storage/idb/Transaction';
import { InstantMessageRoomManager } from './InstantMessageRoomManager';

// An IRoomManager is responsible for managing the lifecycle of a particular
// room type (https://spec.matrix.org/v1.4/client-server-api/#types).
//
// These responsibilities include managing the in-memory and on-disk representations
// of a room type, and updating these representations upon a sync response, for each of
// "invite", "join", and "leave" ("knock" is currently not supported).
export interface IRoomManager<J, I, L> {
    /**
     * init is called once when the application is first loaded,
     * giving it a chance to store a reference to the Session if necessary.
     */
    init(session: Session): void;

    /**
     * storesForLoad returns a list of the idb store names required in the
     * Transaction passed to createLoadPromises.
     */
    get storesForLoad(): string[];
    /**
     * createLoadPromises is called once when the application is first loaded.
     * This is typically where you would create promises to load existing room
     * data saved in idb into memory.
     *
     * The api asks for a list of Promise<void> back so that async operations
     * can be run concurrently with those of other IRoomManagers.
     */
    createLoadPromises(txn: Transaction, log: ILogItem): Promise<Promise<void>[]>;

    /**
     * initSync is called when a new sync response is received. It is where any of the room manager's
     * state from the previous sync can be reset and/or initialized for the upcoming sync cycle.
     */
    initSync(roomsResponse: Rooms | undefined, isInitialSync: boolean, log: ILogItem): Promise<void>;
    /**
     * storesForPrepareSync returns a list of the idb store names required in the
     * Transaction passed to prepareSync.
     */
    get storesForPrepareSync(): string[];
    /**
     * prepareSync is the idb read phase of the sync cycle
     * @param roomsResponse the rooms section of the sync response
     * @param newKeysByRoom new keys returned by this sync response, mapped to room id
     * @param prepareTxn read transaction with the stores returned by storesForPrepareSync
     */
    prepareSync(
        roomsResponse: Rooms | undefined,
        newKeysByRoom: Map<string, IncomingRoomKey[]> | undefined,
        prepareTxn: Transaction,
        log: ILogItem
    ): Promise<void>;
    /**
     * called after prepareSync
     */
    afterPrepareSync(log: ILogItem): Promise<void>; // todo(isaiah): can we just get rid of this and push this processing to prepareSync?
    /**
     * storesForWriteSync returns a list of the idb store names required in the
     * Transaction passed to writeSync.
     */
    get storesForWriteSync(): string[];
    /**
     * prepareSync is the idb write phase of the sync cycle
     * @param syncTxn write transaction with the stores returned by storesForWriteSync
     */
    writeSync(syncTxn: Transaction, isInitialSync: boolean, log: ILogItem): Promise<void>;
    /**
     * afterSync is the in-memory update phase of the sync cycle.
     * This is where any in-memory representations of objects that were
     * changed by sync should be updated.
     */
    afterSync(log: ILogItem): Promise<void>;
    /**
     * called after afterSync
     */
    afterSyncCompleted(log: ILogItem): Promise<void>; // todo(isaiah): can we just get rid of this and push this processing to prepareSync?

    /**
     * dispose is where to take care of any references that need to be explicitly
     * disposed to avoid memory leaks, or any other cleanup tasks.
     */
    dispose(): Promise<void>;

    /**
     * The in-memory representation of "join" rooms
     */
    get joinRooms(): ObservableMap<string, J>;
    /**
     * The in-memory representation of "invite" rooms
     */
    get inviteRooms(): ObservableMap<string, I>;
    /**
     * The in-memory representation of "leave" rooms
     */
    get leaveRooms(): ObservableMap<string, L>;
}

export function getDefaultRoomManagers(): Map<string, IRoomManager<any, any, any>> {
    return new Map([['imRooms', new InstantMessageRoomManager()]])
}