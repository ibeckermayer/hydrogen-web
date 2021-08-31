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
import {Store} from "../Store";

export interface SessionEntry {
    key: string;
    value: any;
}

export class SessionStore {
    private _sessionStore: Store<SessionEntry>

    constructor(sessionStore: Store<SessionEntry>) {
        this._sessionStore = sessionStore;
    }

    async get(key: IDBValidKey): Promise<any> {
        const entry = await this._sessionStore.get(key);
        if (entry) {
            return entry.value;
        }
    }

    set(key: string, value: any): void {
        this._sessionStore.put({key, value});
    }

    add(key: string, value: any): void {
        this._sessionStore.add({key, value});
    }

    remove(key: IDBValidKey): void {
        this._sessionStore.delete(key);
    }
}
