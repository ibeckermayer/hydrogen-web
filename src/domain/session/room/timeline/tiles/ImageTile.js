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

import {BaseMediaTile} from "./BaseMediaTile";

export class ImageTile extends BaseMediaTile {
    constructor(entry, options) {
        super(entry, options);
        this._lightboxUrl = this.urlCreator.urlForSegments([
            // ensure the right room is active if in grid view
            this.navigation.segment("room", this._room.id),
            this.navigation.segment("lightbox", this._entry.id)
        ]);
    }

    get lightboxUrl() {
        if (!this.isPending) {
            return this._lightboxUrl;
        }
        return "";
    }

    get shape() {
        return "image";
    }
}
