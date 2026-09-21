/**
 * TranslateMessage core: WM_KEYDOWN / WM_SYSKEYDOWN → posted WM_CHAR / WM_SYSCHAR,
 * shared by the TranslateMessage export and the JS modal-dialog loop.
 */
import { System } from '../../core/system';
import { vkToChar } from '../../runtime/input/us-keyboard-layout';

const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSCHAR = 0x0106;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_CAPITAL = 0x14;

/** Returns true when a character message was posted. */
export function translateKeyMessage(hwnd: number, message: number, wParam: number, lParam: number): boolean {
    if (message !== WM_KEYDOWN && message !== WM_SYSKEYDOWN) return false;
    // Modifier state as the message queue sees it (GetKeyState: synchronous, with the
    // CapsLock toggle bit) — not the live async level, which may already have moved on
    // by the time the app pumps the queued WM_KEYDOWN.
    const inputManager = System.getInstance().inputManager;
    const shiftDown = (inputManager.getKeyState(VK_SHIFT) & 0x8000) !== 0;
    const capsLock = (inputManager.getKeyState(VK_CAPITAL) & 0x0001) !== 0;
    const ctrlDown = message === WM_KEYDOWN && (inputManager.getKeyState(VK_CONTROL) & 0x8000) !== 0;
    const charCode = vkToChar(wParam & 0xFF, shiftDown, capsLock, ctrlDown);
    if (charCode === 0) return false;
    System.getInstance().windowManager.postMessage(
        hwnd, message === WM_SYSKEYDOWN ? WM_SYSCHAR : WM_CHAR, charCode, lParam);
    return true;
}
