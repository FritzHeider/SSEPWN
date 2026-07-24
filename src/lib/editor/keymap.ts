/**
 * Pure keymap → action resolution for the clip editor's global shortcuts (item
 * 11). The editor page's keydown handler is a thin wire: it normalises a keyboard
 * event into a {@link KeyInput}, asks this module what to do, and dispatches the
 * returned {@link EditorAction}. Keeping the mapping here — not in the component —
 * makes every binding (and every "ignored while typing" / tab-dependent rule)
 * unit-testable without a DOM, the same DEC-005 split the timeline maths use.
 *
 * Bindings (from the task):
 *  - Space: play/pause
 *  - ←/→: seek ∓1 s; Shift ∓5 s; Alt ∓0.1 s (fine nudge)
 *  - I/O: set the timeline trim in/out when the Timeline tab is active, else jump
 *    to the clip in/out point
 *  - S: split at playhead (Timeline tab)
 *  - Delete/Backspace: remove the selected segment (Timeline tab)
 *  - Cmd/Ctrl+Z: undo; Cmd/Ctrl+Shift+Z: redo
 *  - ?: open the shortcuts overlay; Escape: close it
 *
 * All bindings are ignored while typing in an input/textarea, except Escape,
 * which still closes an open overlay so focus in a field can't trap the user.
 */

/** The editor's five right-pane tabs; several bindings are tab-sensitive. */
export type EditorTab = "crop" | "timeline" | "captions" | "template" | "export";

/** A resolved editor action, as a discriminated union the component dispatches. */
export type EditorAction =
  | { type: "toggle-play" }
  | { type: "seek"; delta: number }
  | { type: "split" }
  | { type: "delete" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "set-in" }
  | { type: "set-out" }
  | { type: "jump-in" }
  | { type: "jump-out" }
  | { type: "toggle-help" }
  | { type: "close-help" };

/** A keyboard event reduced to the fields the mapping needs. */
export interface KeyInput {
  key: string;
  shift?: boolean;
  alt?: boolean;
  /** Cmd on macOS. */
  meta?: boolean;
  /** Ctrl elsewhere. */
  ctrl?: boolean;
}

/** The editor state the mapping depends on. */
export interface KeyContext {
  activeTab: EditorTab;
  /** True when focus is in an input/textarea/contenteditable — most keys are ignored. */
  typing: boolean;
  /** Whether the shortcuts overlay is open (Escape closes it). */
  helpOpen: boolean;
}

/** Seek step sizes in seconds: Alt = fine nudge, Shift = coarse, else one second. */
const SEEK_FINE = 0.1;
const SEEK_COARSE = 5;
const SEEK_STEP = 1;

/** Whether a key is an undo/redo chord (Cmd/Ctrl+Z, optionally +Shift for redo). */
function isUndoChord(input: KeyInput): boolean {
  return (input.meta || input.ctrl) === true && input.key.toLowerCase() === "z";
}

/**
 * The action a key should trigger given the editor's state, or `null` for a key
 * that is not bound (so the component can leave the event alone). Modifier chords
 * (undo/redo) are checked before plain letters so a Cmd/Ctrl+Z never falls through
 * to a bare-`z` binding.
 */
export function resolveKey(input: KeyInput, ctx: KeyContext): EditorAction | null {
  // Escape closes the overlay even from within a field; nothing else fires while typing.
  if (input.key === "Escape") {
    return ctx.helpOpen ? { type: "close-help" } : null;
  }
  if (ctx.typing) return null;

  if (isUndoChord(input)) {
    return input.shift ? { type: "redo" } : { type: "undo" };
  }
  // Any other modifier chord is left to the browser/OS.
  if (input.meta || input.ctrl) return null;

  switch (input.key) {
    case "?":
      return { type: "toggle-help" };
    case " ":
    case "Spacebar":
      return { type: "toggle-play" };
    case "ArrowLeft":
    case "ArrowRight": {
      const magnitude = input.alt ? SEEK_FINE : input.shift ? SEEK_COARSE : SEEK_STEP;
      const sign = input.key === "ArrowLeft" ? -1 : 1;
      return { type: "seek", delta: sign * magnitude };
    }
    case "i":
    case "I":
      return ctx.activeTab === "timeline" ? { type: "set-in" } : { type: "jump-in" };
    case "o":
    case "O":
      return ctx.activeTab === "timeline" ? { type: "set-out" } : { type: "jump-out" };
    case "s":
    case "S":
      return ctx.activeTab === "timeline" ? { type: "split" } : null;
    case "Delete":
    case "Backspace":
      return ctx.activeTab === "timeline" ? { type: "delete" } : null;
    default:
      return null;
  }
}
