import type { Doc } from "@docukit/docnode";

export class Editor {
  doc: Doc; // equivalent to editorState in Lexical
  // selection: Selection;

  constructor(doc: Doc) {
    this.doc = doc;
  }
}

export type EditorConfig = {
  formats: ("bold" | "italic" | "underline" | "strikethrough" | "code")[]; // Or enabledFormats, or textFormats
  blocks: (
    | "paragraph"
    | "heading"
    | "orderedList"
    | "unorderedList"
    | "checkList"
    | "quote"
    | "code"
  )[];

  components: {
    inline: []; // Array<JSX.Element> or NodeDefinition<"inlineComponent">[] ?
    block: []; // Array<JSX.Element> or NodeDefinition<"blockComponent">[] ?
  };

  // or rangeDecorators or ranges?
  decorators: []; // NodeDefinition<"decorator">[] ? (used for things like comments)

  plugins: []; // Array<Plugin> () IndentPlugin, TablePlugin, DebugPlugin, CommentPlugin, etc.

  // TO-DECIDE?
  // - conceptually how are links defined? or inline code?
  // - perhaps rangeDecorator wants to be a wrapper and not just style the text nodes (example,
  //   you want to make a circular border without it being "cut" by the edges that the formats would cause)
};

// useEditor beside passing the editor could pass the editorConfig

// in DocNode, "decorator" will be a range that lives outside the node (I think it's similar in Prosemirror)
// what in Lexical is called "DecoratorNode", in DocNode would be a "Component"
