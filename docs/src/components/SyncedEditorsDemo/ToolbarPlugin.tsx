"use client";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, HeadingNode } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $getNearestNodeOfType, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  SELECTION_CHANGE_COMMAND,
} from "lexical";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading1,
  Italic,
  Pilcrow,
  Underline,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type BlockType = "paragraph" | "h1";

function Divider() {
  return <div className="mx-1 h-6 w-px bg-slate-600" />;
}

interface ToolbarButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isActive?: boolean;
  ariaLabel: string;
  children: React.ReactNode;
}

function ToolbarButton({
  onClick,
  disabled,
  isActive,
  ariaLabel,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-all duration-150 ${
        disabled
          ? "cursor-not-allowed text-slate-600"
          : isActive
            ? "bg-emerald-500/20 text-emerald-400 shadow-inner"
            : "text-slate-300 hover:bg-slate-700 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

export function ToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [blockType, setBlockType] = useState<BlockType>();

  const $updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      setIsBold(selection.hasFormat("bold"));
      setIsItalic(selection.hasFormat("italic"));
      setIsUnderline(selection.hasFormat("underline"));

      const anchorNode = selection.anchor.getNode();
      const headingNode = $getNearestNodeOfType(anchorNode, HeadingNode);

      if (headingNode?.getTag() === "h1") {
        setBlockType("h1");
      } else {
        setBlockType("paragraph");
      }
    }
  }, []);

  const formatParagraph = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createParagraphNode());
      }
    });
  };

  const formatHeading1 = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode("h1"));
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
    );
  }, [editor, $updateToolbar]);

  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-t-xl border-b border-slate-700 bg-slate-800/80 px-2 py-1.5 backdrop-blur-sm">
      {/* Block type */}
      <ToolbarButton
        onClick={formatParagraph}
        isActive={blockType === "paragraph"}
        ariaLabel="Paragraph"
      >
        <Pilcrow size={16} />
      </ToolbarButton>
      <ToolbarButton
        onClick={formatHeading1}
        isActive={blockType === "h1"}
        ariaLabel="Heading 1"
      >
        <Heading1 size={16} />
      </ToolbarButton>

      <Divider />

      {/* Text format */}
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

      {/* Alignment */}
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
