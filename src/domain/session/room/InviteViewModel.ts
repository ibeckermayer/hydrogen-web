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

import {IGridItemViewModel} from './IGridItemViewModel';
import {avatarInitials, getIdentifierColorNumber, getAvatarHttpUrl} from "../../avatar";
import {ViewModel} from "../../ViewModel";
import type {Options as ViewModelOptions} from "../../ViewModel";
import type {Invite} from "../../../matrix/room/Invite";
import type {MediaRepository} from "../../../matrix/net/MediaRepository";
import type {RoomMember} from "../../../matrix/room/members/RoomMember";
import type {Platform} from "../../../platform/web/Platform";


type Options = ViewModelOptions & {
    invite: Invite,
    mediaRepository: MediaRepository
}

export class InviteViewModel extends ViewModel implements IGridItemViewModel {
    private _invite: Invite;
    private _mediaRepository: MediaRepository;
    private _closeUrl: string;
    private _roomDescription: string;
    private _inviter?: RoomMemberViewModel;
    private _error?: Error;

    constructor(options: Options) {
        super(options);
        const {invite, mediaRepository} = options;
        this._invite = invite;
        this._mediaRepository = mediaRepository;
        this._onInviteChange = this._onInviteChange.bind(this);
        this._closeUrl = this.urlRouter.urlUntilSegment("session");
        this._invite.on("change", this._onInviteChange);
        if (this._invite.inviter) {
            this._inviter = new RoomMemberViewModel(this._invite.inviter, mediaRepository, this.platform);
        }
        this._roomDescription = this._createRoomDescription();
    }

    get kind(): string { return "invite"; }
    get closeUrl(): string { return this._closeUrl; }
    get name(): string { return this._invite.name; }
    get id(): string { return this._invite.id; }
    get isEncrypted(): boolean { return this._invite.isEncrypted; }
    get isDirectMessage(): boolean { return this._invite.isDirectMessage; }
    get inviter(): RoomMemberViewModel | undefined { return this._inviter; }
    get busy(): string { return this._invite.accepting || this._invite.rejecting; }

    get error(): string {
        if (this._error) {
            return `Something went wrong: ${this._error.message}`;
        }
        return "";
    }

    get avatarLetter(): string | undefined {
        return avatarInitials(this.name);
    }

    get avatarColorNumber(): number {
        return getIdentifierColorNumber(this._invite.avatarColorId);
    }

    avatarUrl(size: number): string | null {
        return getAvatarHttpUrl(this._invite.avatarUrl, size, this.platform, this._mediaRepository);
    }

    _createRoomDescription(): string {
        const parts: string[] = [];
        if (this._invite.isPublic) {
            parts.push("Public room");
        } else {
            parts.push("Private room");
        }

        if (this._invite.canonicalAlias) {
            parts.push(this._invite.canonicalAlias);
        }
        return parts.join(" • ");
    }

    get roomDescription(): string {
        return this._roomDescription;
    }

    get avatarTitle(): string {
        return this.name;
    }

    focus(): void {}

    async accept(): Promise<void> {
        try {
            await this._invite.accept();
        } catch (err) {
            this._error = err;
            this.emitChange("error");
        }
    }

    async reject(): Promise<void> {
        try {
            await this._invite.reject();
        } catch (err) {
            this._error = err;
            this.emitChange("error");
        }
    }

    _onInviteChange(): void {
        this.emitChange("invite");
    }

    dispose(): void {
        super.dispose();
        this._invite.off("change", this._onInviteChange);
    }
}

class RoomMemberViewModel {
    private _member: RoomMember;
    private _mediaRepository: MediaRepository;
    private _platform: Platform;

    constructor(member, mediaRepository, platform) {
        this._member = member;
        this._mediaRepository = mediaRepository;
        this._platform = platform;
    }

    get id(): string {
        return this._member.userId;
    }

    get name(): string {
        return this._member.name;
    }

    get avatarLetter(): string | undefined {
        return avatarInitials(this.name);
    }

    get avatarColorNumber():number {
        return getIdentifierColorNumber(this._member.userId);
    }

    avatarUrl(size): string | null {
        return getAvatarHttpUrl(this._member.avatarUrl, size, this._platform, this._mediaRepository);
    }

    get avatarTitle(): string {
        return this.name;
    }
}
