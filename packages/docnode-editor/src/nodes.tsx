// OLD PROOF OF CONCEPT - A LOT OF THINGS ARE DIFFERENT NOW, NEED TO REVISE
// import React from "react";
// import { type Doc, DocNode } from "@docukit/docnode";

// // MAYBE: should mimic the methods of Lexical/Element/DecoratorNode that are not implemented in DocNode (very few)
// // also maybe should be an interface instead of a class
// // export abstract class Base extends DocNode {
// //   abstract render(): JSX.Element;
// //   attributes?: Record<string, unknown>;
// //   selectEnd() { /* wip */ }
// //   selectStart() { /* wip */ }
// // }

// // In this comment I argue why these should be the same class: https://github.com/facebook/lexical/issues/1262#issuecomment-1186170960
// // although don't think the argument is strong considering that I can use a changeType method to change the type of a node
// type BlockState = {
//   tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "ol" | "ul" | "cl";
//   check?: true;
//   value?: number;
//   indent?: number;
//   // classes?: {readonly [classSuffix: string]: true | string}
//   // marks?: {readonly [markId: string]: string}
// };
// export class BlockNode extends DocNode<BlockState> {
//   // render() {
//   //   return <p>{this.state.tag}</p>;
//   // }
// }

// export class LineBreak extends DocNode {}

// export class Text extends DocNode {}

// /**
//  * I have to think about this one more.
//  */
// export class Table extends DocNode<{
//   rows: Doc;
//   columns: Doc;
//   columnHeader: boolean; // not sure
//   rowHeader: boolean; // not sure
//   foot: boolean; // not sure
//   caption: string; // SerializedEditorState. I don't care if it is LWW.
// }> {
//   // declare private next: DocNode; // Option 1 (TS complains)

//   render() {
//     return (
//       <div id="scrollable">
//         <table>
//           <caption></caption>
//           <colgroup></colgroup>
//           <thead></thead>
//           <tbody>
//             <tr></tr>
//             <tr></tr>
//           </tbody>
//           <tfoot></tfoot>
//         </table>
//       </div>
//     );
//   }
// }

// export class TableRow extends DocNode<{ cells: Doc }> {}
