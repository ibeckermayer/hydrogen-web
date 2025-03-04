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

import {BaseObservableMap} from "../map";
import {BaseObservableList} from "./BaseObservableList";
import {sortedIndex} from "../../utils/sortedIndex";
import {SubscriptionHandle} from "../BaseObservable";

/*

when a value changes, it sorting order can change. It would still be at the old index prior to firing an onUpdate event.
So how do you know where it was before it changed, if not by going over all values?

how to make this fast?

seems hard to solve with an array, because you need to map the key to it's previous location somehow, to efficiently find it,
and move it.

I wonder if we could do better with a binary search tree (BST).
The tree has a value with {key, value}. There is a plain Map mapping keys to this tuple,
for easy lookup. Now how do we find the index of this tuple in the BST?

either we store in every node the amount of nodes on the left and right, or we decend into the part
of the tree preceding the node we want to know about. Updating the counts upwards would probably be fine as this is log2 of
the size of the container.

to be able to go from a key to an index, the value would have the have a link with the tree node though

so key -> Map<key,value> -> value -> node -> *parentNode -> rootNode
with a node containing {value, leftCount, rightCount, leftNode, rightNode, parentNode}
*/

// does not assume whether or not the values are reference
// types modified outside of the collection (and affecting sort order) or not

export type Element<K, V> = { key: K, value: V }

// no duplicates allowed for now
export class SortedMapList<K, V> extends BaseObservableList<V> {
    private _sourceMap: BaseObservableMap<K, V>;
    private _comparator: (left: Element<K, V>, right: Element<K, V>) => number;
    private _sortedPairs?: Element<K, V>[];
    private _mapSubscription?: SubscriptionHandle

    constructor(sourceMap: BaseObservableMap<K, V>, comparator: (left: V, right: V) => number) {
        super();
        this._sourceMap = sourceMap;
        this._comparator = (a, b): number => comparator(a.value, b.value);
    }

    onAdd(key: K, value: V): void {
        const pair = {key, value};
        const idx = sortedIndex(this._sortedPairs!, pair, this._comparator);
        this._sortedPairs!.splice(idx, 0, pair);
        this.emitAdd(idx, value);
    }

    onRemove(key: K, value: V): void {
        const pair = {key, value};
        const idx = sortedIndex(this._sortedPairs!, pair, this._comparator);
        // assert key === this._sortedPairs[idx].key;
        this._sortedPairs!.splice(idx, 1);
        this.emitRemove(idx, value);
    }

    onUpdate(key: K, value: V, params: any): void {
        // if an update is emitted while calling source.subscribe() from onSubscribeFirst, ignore it
        if (!this._sortedPairs) {
            return;
        }
        // TODO: suboptimal for performance, see above for idea with BST to speed this up if we need to
        const oldIdx = this._sortedPairs.findIndex(p => p.key === key);
        // neccesary to remove pair from array before
        // doing sortedIndex as it relies on being sorted
        this._sortedPairs.splice(oldIdx, 1);
        const pair = {key, value};
        const newIdx = sortedIndex(this._sortedPairs, pair, this._comparator);
        this._sortedPairs.splice(newIdx, 0, pair);
        if (oldIdx !== newIdx) {
            this.emitMove(oldIdx, newIdx, value);
        }
        this.emitUpdate(newIdx, value, params);
    }

    onReset(): void {
        this._sortedPairs = [];
        this.emitReset();
    }

    onSubscribeFirst(): void {
        this._mapSubscription = this._sourceMap.subscribe(this);
        this._sortedPairs = new Array(this._sourceMap.size);
        let i = 0;
        for (let [key, value] of this._sourceMap) {
            this._sortedPairs[i] = {key, value};
            ++i;
        }
        this._sortedPairs.sort(this._comparator);
        super.onSubscribeFirst();
    }

    onUnsubscribeLast(): void {
        super.onUnsubscribeLast();
        this._sortedPairs = undefined;
        this._mapSubscription = this._mapSubscription!();
    }

    get(index): V {
        return this._sortedPairs![index].value;
    }

    get length(): number {
        return this._sourceMap.size;
    }

    [Symbol.iterator](): Iterator<V> {
        const it: IterableIterator<Element<K, V>> = this._sortedPairs!.values();
        return {
            next(): IteratorResult<V> {
                const v = it.next();
                if (v.value) {
                    v.value = v.value.value;
                }
                return v as IteratorResult<V>;
            }
        };
    }
}

import {ObservableMap} from "..";

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function tests() {
    return {
        test_sortIndex(assert): void {
            const a = [1, 5, 6, 8];
            const cmp = (a, b): number => a - b;
            let idx = sortedIndex(a, 0, cmp);
            assert.equal(idx, 0);
            idx = sortedIndex(a, 3, cmp);
            assert.equal(idx, 1);
            idx = sortedIndex(a, 5, cmp);
            assert.equal(idx, 1);
            idx = sortedIndex(a, 8, cmp);
            assert.equal(idx, 3);
        },

        test_sortIndex_reverse(assert): void {
            let idx = sortedIndex([8, 6, 5, 1], 6, (a, b) => b - a);
            assert.equal(idx, 1);
        },

        test_sortIndex_comparator_Array_compatible(assert): void {
            const a = [5, 1, 8, 2];
            const cmp = (a, b): number => a - b;
            a.sort(cmp);
            assert.deepEqual(a, [1, 2, 5, 8]);
            let idx = sortedIndex(a, 2, cmp);
            assert.equal(idx, 1);
        },

        test_initial_values(assert): void {
            const map = new ObservableMap([
                ["a", 50],
                ["b", 6],
                ["c", -5],
            ]);
            const list = new SortedMapList(map, (a, b) => a - b);
            list.subscribe({
                onReset(){}, onUpdate(){}, onAdd(){}, onMove(){}, onRemove(){}
            }); //needed to populate iterator
            assert.deepEqual(Array.from(list), [-5, 6, 50]);
            assert.equal(list.length, 3);
        },

        test_add(assert): void {
            const map = new ObservableMap([["a", 50], ["b", 6], ["c", -5]]);
            const list = new SortedMapList(map, (a, b) => a - b);
            let fired = 0;
            list.subscribe({
                onAdd(idx, value) {
                    fired++;
                    assert.equal(idx, 2);
                    assert.equal(value, 20);
                },
                onReset(){}, onUpdate(){}, onRemove(){}, onMove(){}
            });
            map.add("d", 20);
            assert.equal(fired, 1);
            assert.equal(list.length, 4);
        },

        test_remove(assert): void {
            const map = new ObservableMap([["a", 50], ["b", 6], ["c", -5]]);
            const list = new SortedMapList(map, (a, b) => a - b);
            let fired = 0;
            list.subscribe({
                onRemove(idx, value) {
                    fired++;
                    assert.equal(idx, 2);
                    assert.equal(value, 50);
                },
                onReset(){}, onUpdate(){}, onAdd(){}, onMove(){}
            });
            map.remove("a");
            assert.equal(fired, 1);
            assert.equal(list.length, 2);
        },

        test_move_reference(assert): void {
            const a = {number: 3};
            const map = new ObservableMap([
                ["a", a],
                ["b", {number: 11}],
                ["c", {number: 1}],
            ]);
            const list = new SortedMapList(map, (a, b) => a.number - b.number);
            let updateFired = 0, moveFired = 0;
            list.subscribe({
                onUpdate(idx, value, param) {
                    updateFired++;
                    assert.equal(idx, 2);
                    assert.equal(value, a);
                    assert.equal(param, "number");
                },

                onMove(oldIdx, newIdx, value) {
                    moveFired++;
                    assert.equal(oldIdx, 1);
                    assert.equal(newIdx, 2);
                    assert.equal(value, a);
                },

                onReset(){}, onAdd(){}, onRemove(){},
            });
            a.number = 111;
            map.update("a", "number");
            assert.equal(moveFired, 1);
            assert.equal(updateFired, 1);
        },

        test_update_without_move(assert): void {
            const a = {number: 3};
            const map = new ObservableMap([
                ["a", a],
                ["b", {number: 11}],
                ["c", {number: 1}],
            ]);
            const list = new SortedMapList(map, (a, b) => a.number - b.number);
            let updateFired = 0, moveFired = 0;
            list.subscribe({
                onUpdate(idx, value, param) {
                    updateFired++;
                    assert.equal(idx, 1);
                    assert.equal(value, a);
                    assert.equal(param, "number");
                },

                onMove() {
                    moveFired++;
                },

                onReset(){}, onAdd(){}, onRemove(){},
            });
            assert.deepEqual(Array.from(list).map(v => v.number), [1, 3, 11]);
            // asume some part of a that doesn't affect
            // sorting order has changed here
            map.update("a", "number");
            assert.equal(moveFired, 0);
            assert.equal(updateFired, 1);
            assert.deepEqual(Array.from(list).map(v => v.number), [1, 3, 11]);
        },
    };
}
