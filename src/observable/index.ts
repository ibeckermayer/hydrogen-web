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

import { _SortedMapList } from "./list/SortedMapList";
import { _MappedMap, Mapper, Updater } from "./map/MappedMap";
import { _FilteredMap, Filter } from "./map/FilteredMap";
import { _JoinedMap } from "./map/JoinedMap";
import { BaseObservableMap } from "./map/BaseObservableMap";
import { _ObservableMap } from "./map/ObservableMap";

// re-export "root" (of chain) collection
export { ObservableArray } from "./list/ObservableArray";
export { SortedArray } from "./list/SortedArray";
export { MappedList } from "./list/MappedList";
export { AsyncMappedList } from "./list/AsyncMappedList";
export { ConcatList } from "./list/ConcatList";

type GConstructor<T = {}> = abstract new (...args: any[]) => T;
type MapConstructor<K, V> = GConstructor<BaseObservableMap<K, V>>;

// TODO(ibeckermayer): this should go in SortedMapList.ts when
// its TS conversion is made.
type Comparator<V> = (a: V, b: V) => number;

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function addTransformers<K, V, T extends MapConstructor<K, V>>(MyClass: T) {
    abstract class ClassWithTransformers extends MyClass {
        sortValues(comparator: Comparator<V>): _SortedMapList {
            return new _SortedMapList(this, comparator);
        }

        mapValues(mapper: Mapper<V>, updater?: Updater<V>): _MappedMap<K, V> {
            return new _MappedMap(this, mapper, updater);
        }

        filterValues(filter: Filter<K, V>): _FilteredMap<K, V> {
            return new _FilteredMap(this, filter);
        }

        join(...otherMaps: BaseObservableMap<K, V>[]): _JoinedMap<K, V> {
            return new _JoinedMap(
                [this as BaseObservableMap<K, V>].concat(otherMaps)
            );
        }
    }
    return ClassWithTransformers;
}

export const SortedMapList = addTransformers(_SortedMapList);
export const MappedMap = addTransformers(_MappedMap);
export const FilteredMap = addTransformers(_FilteredMap);
export const JoinedMap = addTransformers(_JoinedMap);
export const ObservableMap = addTransformers(_ObservableMap);
