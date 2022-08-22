/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import {ViewModel} from "../../ViewModel";
import type {Options as BaseOptions} from "../../ViewModel";
import type {SegmentType, Path} from "../../navigation";
import {RoomDetailsViewModel} from "./RoomDetailsViewModel.js";
import {MemberListViewModel} from "./MemberListViewModel";
import {MemberDetailsViewModel} from "./MemberDetailsViewModel";
import type {Room} from "../../../matrix/room/Room";
import type {Session} from "../../../matrix/Session";
import type {MemberList} from "../../../matrix/room/members/MemberList";
import type {MediaRepository} from "../../../matrix/net/MediaRepository";
import type {RoomMember} from "../../../matrix/room/members/RoomMember";
import type {PowerLevels} from "../../../matrix/room/PowerLevels.js";
import type {RetainedObservableValue} from "../../../lib";

type Options = {
    room: Room,
    session: Session,
} & BaseOptions;

export class RightPanelViewModel extends ViewModel {
    private _room: Room;
    private _session: Session;
    private _members?: MemberList;
    private _activeViewModel?: ActiveViewModel;

    constructor(options: Options) {
        super(options);
        this._room = options.room;
        this._session = options.session;
        this._members = null;
        this._setupNavigation();
    }

    get activeViewModel(): ActiveViewModel { return this._activeViewModel; }

    async _getMemberListArguments(): Promise<
        {
            members: MemberList,
            powerLevelsObservable: PowerLevelsObservable,
            mediaRepository: MediaRepository
        }
    > {
        if (!this._members) {
            this._members = await this._room.loadMemberList();
            this.track(() => this._members.release());
        }
        const room = this._room;
        const powerLevelsObservable = await this._room.observePowerLevels();
        return {members: this._members, powerLevelsObservable, mediaRepository: room.mediaRepository};
    }


    async _getMemberDetailsArguments(): Promise<false |
        {
            observableMember: ObservableMember;
            isEncrypted: boolean;
            powerLevelsObservable: PowerLevelsObservable;
            mediaRepository: MediaRepository;
            session: Session;
        }
    > {
        const segment = this.navigation.path.get("member");
        const userId = segment!.value;
        const observableMember = await this._room.observeMember(userId);
        if (!observableMember) {
            return false;
        }
        const isEncrypted = this._room.isEncrypted;
        const powerLevelsObservable = await this._room.observePowerLevels();
        return {
            observableMember,
            isEncrypted,
            powerLevelsObservable,
            mediaRepository: this._room.mediaRepository,
            session: this._session,
        };
    }

    _setupNavigation(): void {
        this._hookUpdaterToSegment("details", RoomDetailsViewModel, () =>  Promise.resolve({room: this._room}));
        this._hookUpdaterToSegment("members", MemberListViewModel, () => this._getMemberListArguments());
        this._hookUpdaterToSegment("member", MemberDetailsViewModel, () => this._getMemberDetailsArguments(),
            () => {
                // If we fail to create the member details panel, fallback to memberlist
                const url = `${this.urlCreator.urlUntilSegment("room")}/members`;
                this.urlCreator.pushUrl(url);
            }
        );
    }

    _hookUpdaterToSegment(
        segment: keyof SegmentType,
        viewmodel: ActiveViewModel,
        argCreator: () => Promise<boolean | object>,
        failCallback: VoidFunction = (): void => {}
    ): void {
        const observable = this.navigation.observe(segment);
        const updater = this._setupUpdater(
            segment,
            viewmodel,
            argCreator,
            failCallback
        );
        this.track(observable.subscribe(updater as (b: boolean) => void));
    }

    _setupUpdater(
        segment: keyof SegmentType,
        viewmodel: ActiveViewModel,
        argCreator: () => Promise<boolean | object>,
        failCallback: VoidFunction = (): void => {}
    ): Updater {
        const updater = async (skipDispose = false): Promise<void> => {
            if (!skipDispose) {
                this._activeViewModel = this.disposeTracked(
                    this._activeViewModel
                );
            }
            const enable = !!this.navigation.path.get(segment)?.value;
            if (enable) {
                const args = await argCreator();
                if (!args && failCallback) {
                    failCallback();
                    return;
                }
                this._activeViewModel = this.track(
                    new viewmodel(this.childOptions(args))
                );
            }
            this.emitChange("activeViewModel");
        };
        void updater(true);
        return updater;
    }

    closePanel(): void {
        const path = this.navigation.path.until("room");
        this.navigation.applyPath(path);
    }

    showPreviousPanel(): void {
        const segmentName = this.activeViewModel.previousSegmentName;
        if (segmentName) {
            let path: Path<SegmentType> | undefined = this.navigation.path.until("room");
            path = path!.with(this.navigation.segment("right-panel", true));
            path = path!.with(this.navigation.segment(segmentName, true));
            this.navigation.applyPath(path!);
        }
    }
}

type ActiveViewModel = RoomDetailsViewModel | MemberListViewModel | MemberDetailsViewModel;
type Updater = (skipDispose?: boolean) => Promise<void>;
type PowerLevelsObservable = RetainedObservableValue<PowerLevels>;
type ObservableMember = RetainedObservableValue<RoomMember>;