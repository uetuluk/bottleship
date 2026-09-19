import React, { useCallback, useRef } from "react";
import { cx } from "../ui/cx";
import s from "./App.module.css";

/**
 * On-screen keys a soft keyboard lacks (arrows, Enter, Escape, Space, Tab). Each key is a
 * real held level — down on touch, up on lift — so both message-loop and state-polling
 * guests see it. Presses never move focus (the soft-keyboard proxy may hold it).
 */
export interface TouchKeypadProps {
    onKey: (vk: number, down: boolean) => void;
}

const VK_TAB = 0x09, VK_RETURN = 0x0d, VK_ESCAPE = 0x1b, VK_SPACE = 0x20;
const VK_LEFT = 0x25, VK_UP = 0x26, VK_RIGHT = 0x27, VK_DOWN = 0x28;

interface KeyDef { vk: number; label: string; aria: string; cell?: string; wide?: boolean }

const ARROWS: KeyDef[] = [
    { vk: VK_UP, label: "▲", aria: "Arrow up", cell: "up" },
    { vk: VK_LEFT, label: "◀", aria: "Arrow left", cell: "left" },
    { vk: VK_DOWN, label: "▼", aria: "Arrow down", cell: "down" },
    { vk: VK_RIGHT, label: "▶", aria: "Arrow right", cell: "right" },
];
const ACTIONS: KeyDef[] = [
    { vk: VK_ESCAPE, label: "Esc", aria: "Escape" },
    { vk: VK_TAB, label: "Tab", aria: "Tab" },
    { vk: VK_SPACE, label: "Space", aria: "Space", wide: true },
    { vk: VK_RETURN, label: "Enter", aria: "Enter", wide: true },
];

export function TouchKeypad({ onKey }: TouchKeypadProps): React.ReactElement {
    // One pointer per key: a second finger on the same key must not double-press or
    // release it early.
    const held = useRef(new Map<number, number>());

    const press = useCallback((event: React.PointerEvent<HTMLButtonElement>, vk: number) => {
        event.preventDefault();
        if (held.current.has(vk)) return;
        held.current.set(vk, event.pointerId);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* already released */ }
        onKey(vk, true);
    }, [onKey]);
    const release = useCallback((event: React.PointerEvent<HTMLButtonElement>, vk: number) => {
        if (held.current.get(vk) !== event.pointerId) return;
        held.current.delete(vk);
        onKey(vk, false);
    }, [onKey]);

    const renderKey = (k: KeyDef) => (
        <button
            key={k.vk}
            type="button"
            className={cx(s, "emu-keypad__key", k.wide && "emu-keypad__key--wide")}
            style={k.cell ? { gridArea: k.cell } : undefined}
            aria-label={k.aria}
            onPointerDown={(e) => press(e, k.vk)}
            onPointerUp={(e) => release(e, k.vk)}
            onPointerCancel={(e) => release(e, k.vk)}
            onMouseDown={(e) => e.preventDefault()}
            onContextMenu={(e) => e.preventDefault()}
        >
            {k.label}
        </button>
    );

    return (
        <div className={s["emu-keypad"]} aria-label="Touch keypad">
            <div className={s["emu-keypad__actions"]}>{ACTIONS.map(renderKey)}</div>
            <div className={s["emu-keypad__arrows"]}>{ARROWS.map(renderKey)}</div>
        </div>
    );
}
