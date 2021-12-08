/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
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

import {ViewModel} from "../../ViewModel.js";
import {RoomTileViewModel} from "./RoomTileViewModel.js";
import {InviteTileViewModel} from "./InviteTileViewModel.js";
import {RoomFilter} from "./RoomFilter.js";
import { ConcatList, MappedList } from "../../../observable/index.js";
import {FilteredMap} from "../../../observable/map/FilteredMap.js";
import {Sync3ObservableList} from "../../../matrix/Sync3ObservableList";
import {ApplyMap} from "../../../observable/map/ApplyMap.js";
import {addPanelIfNeeded} from "../../navigation/index.js";
import { PlaceholderRoomTileViewModel } from "./PlaceholderRoomTileViewModel.js";

export class LeftPanelViewModel extends ViewModel {
    constructor(options) {
        super(options);
        const {rooms, invites, compareFn, sync} = options;
        this._sync = sync;
        const sync3List = new Sync3ObservableList(sync, rooms);
        const list = new ConcatList(invites.sortValues((a,b) => a.compare(b)), sync3List);
        this._tileViewModels = this._mapTileViewModels(list);
        this._currentTileVM = null;
        this._setupNavigation();
        this._closeUrl = this.urlCreator.urlForSegment("session");
        this._settingsUrl = this.urlCreator.urlForSegment("settings");
        this._compareFn = compareFn;
    }

    _subscribeToRoom(roomId) {
        this._sync.setRoomSubscriptions([roomId]);
    }

    _mapTileViewModels(list) {
        const mapper = (roomOrInvite, emitChange) => {
            let vm;
            if (roomOrInvite === null) {
                vm = new PlaceholderRoomTileViewModel(this.childOptions({room: null, emitChange}));
            } else if (roomOrInvite.isInvite) {
                vm = new InviteTileViewModel(this.childOptions({invite: roomOrInvite, emitChange}));
            } else {
                vm = new RoomTileViewModel(this.childOptions({
                    room: roomOrInvite,
                    compareFn: this._compareFn,
                    emitChange,
                }));
            }
            if (roomOrInvite) {
                const isOpen = this.navigation.path.get("room")?.value === roomOrInvite.id;
                if (isOpen) {
                    vm.open();
                    this._updateCurrentVM(vm);
                }
            }
            return vm;
        };
        const updater = (tileViewModel, noIdea, roomOrInvite) => {
            return mapper(roomOrInvite);
        }
        return new MappedList(list, mapper, updater);
    }

    _updateCurrentVM(vm) {
        // need to also update the current vm here as
        // we can't call `_open` from the ctor as the map
        // is only populated when the view subscribes.
        this._currentTileVM?.close();
        this._currentTileVM = vm;
    }

    get closeUrl() {
        return this._closeUrl;
    }

    get settingsUrl() {
        return this._settingsUrl;
    }

    _setupNavigation() {
        const roomObservable = this.navigation.observe("room");
        this.track(roomObservable.subscribe(roomId => this._open(roomId)));

        const gridObservable = this.navigation.observe("rooms");
        this.gridEnabled = !!gridObservable.get();
        this.track(gridObservable.subscribe(roomIds => {
            const changed = this.gridEnabled ^ !!roomIds;
            this.gridEnabled = !!roomIds;
            if (changed) {
                this.emitChange("gridEnabled");
            }
        }));
    }

    _open(roomId) {
        this._currentTileVM?.close();
        this._currentTileVM = null;
        if (roomId) {
            // find the vm for the room. Previously we used a map to do this but sync3 only gives
            // us a list. We could've re-mapped things in the observable pipeline but we don't need
            // these values to be kept up-to-date when a O(n) search on click isn't particularly
            // expensive.
            let targetVM;
            for ( let vm of this._tileViewModels ) {
                if (vm.id === roomId) {
                    targetVM = vm;
                    break;
                }
            }
            if (targetVM) {
                this._subscribeToRoom(roomId);
                this._currentTileVM = targetVM;
                this._currentTileVM?.open();
            }
        }
    }

    toggleGrid() {
        const room = this.navigation.path.get("room");
        let path = this.navigation.path.until("session");
        if (this.gridEnabled) {
            if (room) {
                path = path.with(room);
                path = addPanelIfNeeded(this.navigation, path);
            }
        } else {
            if (room) {
                path = path.with(this.navigation.segment("rooms", [room.value]));
                path = path.with(room);
                path = addPanelIfNeeded(this.navigation, path);
            } else {
                path = path.with(this.navigation.segment("rooms", []));
                path = path.with(this.navigation.segment("empty-grid-tile", 0));
            }
        }
        this.navigation.applyPath(path);
    }

    get tileViewModels() {
        return this._tileViewModels;
    }

    clearFilter() {
        this._tileViewModelsFilterMap.setApply(null);
        this._tileViewModelsFilterMap.applyOnce((roomId, vm) => vm.hidden = false);
    }

    setFilter(query) {
        query = query.trim();
        if (query.length === 0) {
            this.clearFilter();
            return false;
        } else {
            const startFiltering = !this._tileViewModelsFilterMap.hasApply();
            const filter = new RoomFilter(query);
            this._tileViewModelsFilterMap.setApply((roomId, vm) => {
                vm.hidden = !filter.matches(vm);
            });
            return startFiltering;
        }
    }

    loadRoomRange(range) {
        this._sync.loadRange(range.start, range.end);
    }
}
