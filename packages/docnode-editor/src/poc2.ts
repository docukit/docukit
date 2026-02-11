import { Doc, type Extension } from "@docukit/docnode";

class Editor extends Doc {
  selection: unknown;
}

export interface EditorExtension extends Extension {
  onClick: (ev: MouseEvent) => void;
  onKeyDown: (ev: KeyboardEvent) => void;
  onKeyUp: (ev: KeyboardEvent) => void;
  onKeyPress: (ev: KeyboardEvent) => void;
  onMouseDown: (ev: MouseEvent) => void;
  onMouseUp: (ev: MouseEvent) => void;
  onMouseMove: (ev: MouseEvent) => void;
  onMouseEnter: (ev: MouseEvent) => void;
  onMouseLeave: (ev: MouseEvent) => void;
  onMouseOver: (ev: MouseEvent) => void;
  onMouseOut: (ev: MouseEvent) => void;
  onMouseWheel: (ev: MouseEvent) => void;
  onMouseClick: (ev: MouseEvent) => void;
  onMouseDoubleClick: (ev: MouseEvent) => void;
}

const _editor = new Editor({ type: "editor", extensions: [] });
