import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $getNearestNodeOfType, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  SELECTION_CHANGE_COMMAND,
  UNDO_COMMAND,
} from "lexical";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Italic,
  Redo2,
  Underline,
  Undo2,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";

function Divider() {
  return <div className="bg-fd-border mx-0.5 h-5 w-px shrink-0" />;
}

function ToolbarButton({
  onClick,
  disabled,
  isActive,
  ariaLabel,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  isActive?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
        disabled
          ? "text-fd-muted-foreground/50 cursor-not-allowed"
          : isActive
            ? "bg-fd-primary/15 text-fd-primary"
            : "text-fd-muted-foreground hover:bg-fd-accent hover:text-fd-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}

export default function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isHeading1, setIsHeading1] = useState(false);

  const $updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      setIsBold(selection.hasFormat("bold"));
      setIsItalic(selection.hasFormat("italic"));
      setIsUnderline(selection.hasFormat("underline"));

      const anchorNode = selection.anchor.getNode();
      const headingNode = $getNearestNodeOfType(anchorNode, HeadingNode);

      setIsHeading1(headingNode?.getTag() === "h1");
    }
  }, []);

  const toggleHeading1 = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () =>
          isHeading1 ? $createParagraphNode() : $createHeadingNode("h1"),
        );
      }
    });
  };

  useEffect(() => {
    return mergeRegister(
      editor.registerUpdateListener(({ editorState }) => {
        editorState.read(
          () => {
            $updateToolbar();
          },
          { editor },
        );
      }),
      editor.registerCommand(
        SELECTION_CHANGE_COMMAND,
        () => {
          editor.read(() => {
            $updateToolbar();
          });
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CAN_UNDO_COMMAND,
        (payload) => {
          setCanUndo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        CAN_REDO_COMMAND,
        (payload) => {
          setCanRedo(payload);
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, $updateToolbar]);

  return (
    <div className="border-fd-border bg-fd-secondary flex h-10 flex-nowrap items-center gap-0.5 overflow-x-auto border-b px-1.5 py-1">
      <ToolbarButton
        onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
        disabled={!canUndo}
        ariaLabel="Undo"
      >
        <Undo2 size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
        disabled={!canRedo}
        ariaLabel="Redo"
      >
        <Redo2 size={16} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={toggleHeading1}
        isActive={isHeading1}
        ariaLabel="Toggle Heading 1"
      >
        <Heading1 size={16} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
        isActive={isBold}
        ariaLabel="Bold"
      >
        <Bold size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
        isActive={isItalic}
        ariaLabel="Italic"
      >
        <Italic size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
        isActive={isUnderline}
        ariaLabel="Underline"
      >
        <Underline size={16} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, "left")}
        ariaLabel="Align Left"
      >
        <AlignLeft size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, "center")}
        ariaLabel="Align Center"
      >
        <AlignCenter size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, "right")}
        ariaLabel="Align Right"
      >
        <AlignRight size={16} />
      </ToolbarButton>
    </div>
  );
}
