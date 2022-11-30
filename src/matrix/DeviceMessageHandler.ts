/*
Copyright 2020 The Matrix.org Foundation C.I.C.

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

import {OLM_ALGORITHM} from "./e2ee/common";
import {countBy, groupBy} from "../utils/groupBy";

import type {Storage} from "./storage/idb/Storage";
import type {Decryption as OlmDecryption, DecryptionChanges as OlmDecryptionChanges} from "./e2ee/olm/Decryption";
import type {Decryption as MegOlmDecryption} from "./e2ee/megolm/Decryption";
import type {OlmEncryptedEvent} from "./e2ee/olm/types";
import type {ILogItem} from "../logging/types";
import type {ILock} from "../utils/Lock";
import type {Transaction} from "./storage/idb/Transaction";
import type {IncomingRoomKey} from "./e2ee/megolm/decryption/RoomKey";
import type {ToDeviceEvent} from "./net/types/sync";

export class DeviceMessageHandler {
    private _storage: Storage;
    private _olmDecryption?: OlmDecryption;
    private _megolmDecryption?: MegOlmDecryption;
    constructor({storage}: {storage: Storage}) {
        this._storage = storage;
    }

    enableEncryption(encryption: {olmDecryption: OlmDecryption, megolmDecryption: MegOlmDecryption}) {
        this._olmDecryption = encryption.olmDecryption;
        this._megolmDecryption = encryption.megolmDecryption;
    }

    obtainSyncLock(toDeviceEvents: OlmEncryptedEvent[]): Promise<ILock> | undefined {
        return this._olmDecryption?.obtainDecryptionLock(toDeviceEvents);
    }

    async prepareSync(toDeviceEvents: ToDeviceEvent[], lock: ILock | undefined, txn: Transaction, log: ILogItem): Promise<SyncPreparation | undefined> {
        log.set("messageTypes", countBy(toDeviceEvents, e => e.type));
        const encryptedEvents = toDeviceEvents.filter(e => e.type === "m.room.encrypted");
        if (!this._olmDecryption) {
            log.log("can't decrypt, encryption not enabled", log.level.Warn);
            return;
        }
        // only know olm for now
        const olmEvents = encryptedEvents.filter(e => e.content?.algorithm === OLM_ALGORITHM) as OlmEncryptedEvent[];
        if (olmEvents.length) {
            if (!lock) throw new Error("attempted to decrypt without obtaining lock")
            if (!this._megolmDecryption) throw new Error("attempted to decrypt messages before enabling encryption")
            const olmDecryptChanges = await this._olmDecryption.decryptAll(olmEvents, lock, txn);
            log.set("decryptedTypes", countBy(olmDecryptChanges.results, r => r.event?.type));
            for (const err of olmDecryptChanges.errors) {
                log.child("decrypt_error").catch(err);
            }
            const newRoomKeys = this._megolmDecryption.roomKeysFromDeviceMessages(olmDecryptChanges.results, log);
            return new SyncPreparation(olmDecryptChanges, newRoomKeys);
        }
    }

    /** check that prep is not undefined before calling this */
    async writeSync(prep: SyncPreparation, txn: Transaction): Promise<boolean> {
        // write olm changes
        prep.olmDecryptChanges.write(txn);
        const didWriteValues = await Promise.all(prep.newRoomKeys.map(key => this._megolmDecryption?.writeRoomKey(key, txn)));
        return didWriteValues.some(didWrite => !!didWrite);
    }
}

export class SyncPreparation {
    olmDecryptChanges: OlmDecryptionChanges;
    newRoomKeys: IncomingRoomKey[];
    newKeysByRoom: Map<string, IncomingRoomKey[]>;

    constructor(olmDecryptChanges: OlmDecryptionChanges, newRoomKeys: IncomingRoomKey[]) {
        this.olmDecryptChanges = olmDecryptChanges;
        this.newRoomKeys = newRoomKeys;
        this.newKeysByRoom = groupBy(newRoomKeys, r => r.roomId);
    }
}
