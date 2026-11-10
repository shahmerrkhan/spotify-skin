#!/usr/bin/env python3
# Tiny X11 helper for spotify-app.js (Python standard library + libX11 only).
#
#   xwin.py withdraw <id>...   take windows away from the window manager: no taskbar,
#                              no Alt+Tab, nothing on screen (the app keeps running)
#   xwin.py show <id>...       hand them back as normal windows
#   xwin.py iconify <id>...    hand them back minimised (in the taskbar, not on screen)
#
# Withdrawing works whether the window is on screen or minimised (ICCCM
# XWithdrawWindow sends the synthetic UnmapNotify a plain unmap can't).

import ctypes
import sys

NormalState, IconicState, StateHint = 1, 3, 1 << 1


class XWMHints(ctypes.Structure):
    _fields_ = [
        ('flags', ctypes.c_long), ('input', ctypes.c_int), ('initial_state', ctypes.c_int),
        ('icon_pixmap', ctypes.c_ulong), ('icon_window', ctypes.c_ulong),
        ('icon_x', ctypes.c_int), ('icon_y', ctypes.c_int),
        ('icon_mask', ctypes.c_ulong), ('window_group', ctypes.c_ulong),
    ]


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ('withdraw', 'show', 'iconify'):
        print(__doc__, file=sys.stderr)
        return 2
    cmd, ids = sys.argv[1], [int(a, 0) for a in sys.argv[2:]]

    x = ctypes.cdll.LoadLibrary('libX11.so.6')
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x.XWithdrawWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
    x.XGetWMHints.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XGetWMHints.restype = ctypes.POINTER(XWMHints)
    x.XAllocWMHints.restype = ctypes.POINTER(XWMHints)
    x.XSetWMHints.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWMHints)]
    x.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]

    # A window that vanished meanwhile must not kill the helper (Xlib exits on errors by default).
    failed = []
    handler_t = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    on_error = handler_t(lambda _d, _e: failed.append(1) or 0)
    x.XSetErrorHandler(on_error)

    d = x.XOpenDisplay(None)
    if not d:
        print('no display', file=sys.stderr)
        return 1
    for w in ids:
        if cmd == 'withdraw':
            x.XWithdrawWindow(d, w, x.XDefaultScreen(d))
        else:
            hints = x.XGetWMHints(d, w)
            h = hints if hints else x.XAllocWMHints()
            if h:
                h.contents.flags |= StateHint
                h.contents.initial_state = IconicState if cmd == 'iconify' else NormalState
                x.XSetWMHints(d, w, h)
                x.XFree(h)
            x.XMapWindow(d, w)
    x.XSync(d, 0)
    x.XCloseDisplay(d)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
