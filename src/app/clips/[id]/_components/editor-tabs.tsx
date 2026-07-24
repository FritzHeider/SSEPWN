"use client";

import { useRef, type ComponentType } from "react";

import type { EditorTab } from "@/lib/editor/keymap";

/** One tab's identity: id, visible label, and its lucide icon component. */
export interface TabDef {
  id: EditorTab;
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
}

/**
 * The right-pane tablist (item 6): real `role="tablist"` buttons with
 * `aria-selected`, an accent underline on the active tab, and arrow-key roving
 * focus (Left/Right move, Home/End jump). Each tab carries a `data-testid`
 * (`editor-tab-<id>`) so the e2e specs can switch panes.
 */
export function EditorTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly TabDef[];
  active: EditorTab;
  onSelect: (tab: EditorTab) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    onSelect(target.id);
    refs.current[target.id]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Editor sections"
      className="flex gap-1 overflow-x-auto border-b border-border-subtle"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[tab.id] = el;
            }}
            type="button"
            role="tab"
            id={`editor-tab-${tab.id}`}
            data-testid={`editor-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`editor-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={`flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              selected
                ? "border-accent text-text"
                : "border-transparent text-text-muted hover:text-text"
            }`}
          >
            <tab.Icon className="h-4 w-4" aria-hidden />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
