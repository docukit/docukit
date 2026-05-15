# Selection Memory

`selectionMemory` is local state in `syncDocNodeToLexical`.

It is not undo metadata. Undo metadata restores the selection for the editor that
executes undo/redo. `selectionMemory` keeps another editor's current selection
coherent while remote operations arrive.

Example:

1. Reference selects `em th` in `Item three.`
2. Other Device deletes `em`
3. Reference can now only select ` th`, because `em` no longer exists
4. Other Device undoes the deletion
5. Reference should select `em th` again

The undo item can restore Other Device's selection, but it does not know
Reference's previous selection. Reference needs temporary local memory to know
that its current ` th` selection used to include the deleted `em` prefix.

The risky case is false restoration: after a remote edit deletes enough content
to clear Reference's selection, a later unrelated remote edit at the same offset
could look like the text is coming back. `selectionMemory` should only restore
selection when the later edit is logically the inverse of the edit that affected
the selection, not merely because the offsets line up.
