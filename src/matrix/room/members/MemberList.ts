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

import {ObservableMap} from "../../../observable";
import {RetainedValue} from "../../../utils/RetainedValue";
import type {MemberChange, RoomMember} from "./RoomMember";

export class MemberList extends RetainedValue {
    private _members: ObservableMap<string, RoomMember>;

    constructor({members, closeCallback}: {members: (RoomMember | undefined)[], closeCallback: VoidFunction}) {
        super(closeCallback);
        this._members = new ObservableMap<string, RoomMember>();
        for (const member of members) {
            if (member) this._members.add(member.userId, member);
        }
    }

    afterSync(memberChanges: Map<string, MemberChange>): void {
        for (const [userId, memberChange] of memberChanges.entries()) {
            this._members.set(userId, memberChange.member);
        }
    }

    get members(): ObservableMap<string, RoomMember> {
        return this._members;
    }
}
