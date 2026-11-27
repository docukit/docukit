// Yjs 14 (@y/y) adapter for crdt-benchmarks (upstream @796f7025 has no Yjs 14 factory). Same as upstream's Yjs 13
// factory (V2 updates), with the new API: every shared type is a `YNode` (`ydoc.get(name)`); text and array are its
// children and the map is its attributes (`setAttr` / `getAttrs`).
//
// Plain JavaScript on purpose: setup.sh copies it into the crdt-benchmarks checkout as benchmarks/yjs14/factory.js,
// next to upstream's JS factories, and it must load exactly like them (no TypeScript type stripping on the module
// path), so every Yjs version is loaded the same way by scripts/fair/child.ts.
import * as Y from '@y/y'

export const name = 'yjs14'

export class Yjs14Factory {
  create (updateHandler) {
    return new Yjs14CRDT(updateHandler)
  }

  load (updateHandler, bin) {
    const crdt = new Yjs14CRDT(updateHandler)
    crdt.applyUpdate(bin)
    return crdt
  }

  getName () {
    return name
  }
}

export class Yjs14CRDT {
  constructor (updateHandler) {
    this.ydoc = new Y.Doc()
    this.ydoc.on('updateV2', update => {
      updateHandler(update)
    })
    this.yarray = this.ydoc.get('array')
    this.ymap = this.ydoc.get('map')
    this.ytext = this.ydoc.get('text')
  }

  getEncodedState () {
    return Y.encodeStateAsUpdateV2(this.ydoc)
  }

  applyUpdate (update) {
    Y.applyUpdateV2(this.ydoc, update)
  }

  insertArray (index, elems) {
    this.yarray.insert(index, elems)
  }

  deleteArray (index, len) {
    this.yarray.delete(index, len)
  }

  getArray () {
    return this.yarray.toArray()
  }

  insertText (index, text) {
    this.ytext.insert(index, text)
  }

  deleteText (index, len) {
    this.ytext.delete(index, len)
  }

  getText () {
    return this.ytext.toString()
  }

  transact (f) {
    this.ydoc.transact(() => f(this))
  }

  setMap (key, val) {
    this.ymap.setAttr(key, val)
  }

  getMap () {
    return this.ymap.getAttrs()
  }
}
