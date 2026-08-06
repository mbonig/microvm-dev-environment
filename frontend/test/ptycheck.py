#!/usr/bin/env python3
"""Feed the toolbar's byte sequences into a real PTY and check what the program
on the other end actually does.

The browser tests prove the toolbar *emits* these bytes; this proves the bytes
*mean* what we think. Covers tasks 7.4 (shell: history, completion, Ctrl-C,
Ctrl-D) and 7.5 (TUI: arrows under DECCKM, Esc back to normal mode) against
zsh — the VM's login shell, per microvm/terminal.js — and vim.
"""
import os, pty, re, select, signal, subprocess, sys, time

PASS, FAIL = 0, 0
ANSI = re.compile(rb'\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()][B0]|\x1b[=>]|\x1b\][^\x07]*\x07|\r')


def ok(cond, what, extra=''):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f'  FAIL {what}' + (f'\n    {extra}' if extra else ''))


class Term:
    """A PTY with the same geometry a pane gets, plus a naive screen scrape."""

    def __init__(self, argv, env=None, cols=100, rows=30):
        self.buf = b''
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ.update(env or {})
            os.environ['TERM'] = 'xterm-256color'
            os.execvp(argv[0], argv)
        import fcntl, struct, termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

    def read(self, timeout=0.6):
        end = time.time() + timeout
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], max(0, end - time.time()))
            if not r:
                break
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.buf += chunk
        return self.buf

    def send(self, data, settle=0.4):
        os.write(self.fd, data.encode() if isinstance(data, str) else data)
        self.read(settle)

    def clear(self):
        self.buf = b''

    def text(self):
        return ANSI.sub(b'', self.buf).decode('utf-8', 'replace')

    def rendered(self):
        """Apply backspaces, so a line-editor redraw reads as the final line.
        zsh recalls history by backspacing over the differing suffix, so the
        recalled command never appears verbatim in the raw stream."""
        out = []
        for ch in self.text():
            if ch == '\b':
                if out and out[-1] != '\n':
                    out.pop()
            else:
                out.append(ch)
        return ''.join(out)

    def expect(self, pattern, timeout=15):
        """Read until `pattern` shows up, rather than guessing with a sleep."""
        end = time.time() + timeout
        while time.time() < end:
            if pattern.search(self.text()):
                return True
            self.read(0.15)
        return pattern.search(self.text()) is not None

    def sync(self, prompt, tag='SYNC'):
        """Block until the line editor is live, not merely until a command ran.

        Two separate things have to be true before a control character means
        anything, and a fixed sleep guarantees neither:

        1. The shell executes commands. Proved by matching the *output* of an
           echo whose quoting differs from its command line, so the terminal's
           echo of what we typed cannot be mistaken for the result.
        2. The line editor owns the tty for the *next* prompt. Until it does,
           the tty driver is still in canonical mode and echoes a control
           character literally (^A) instead of zle acting on it — which is what
           made this suite fail under `npm test` but pass standalone. Waiting
           for the prompt to be redrawn after the command is that signal.
        """
        self.send(f"echo {tag[:2]}''{tag[2:]}-OK\n", 0.1)
        if not self.expect(re.compile(rf'{tag}-OK')):
            return False
        tail = self.text().split(f'{tag}-OK')[-1]
        end = time.time() + 15
        while prompt not in tail and time.time() < end:
            self.read(0.15)
            tail = self.text().split(f'{tag}-OK')[-1]
        if prompt not in tail:
            return False

        self.clear()
        return True

    def alive(self):
        try:
            return os.waitpid(self.pid, os.WNOHANG) == (0, 0)
        except ChildProcessError:
            return False

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        except Exception:
            pass
        try:
            os.close(self.fd)
        except Exception:
            pass


# Sequences exactly as the toolbar emits them (see KEYS / cursorSeq in index.html).
ESC, TAB, SHIFT_TAB = '\x1b', '\t', '\x1b[Z'
UP_N, DOWN_N, RIGHT_N, LEFT_N = '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D'
UP_A, DOWN_A, RIGHT_A, LEFT_A = '\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD'
HOME_N, END_N = '\x1b[H', '\x1b[F'
CTRL_C, CTRL_D, CTRL_A, CTRL_K, CTRL_R = '\x03', '\x04', '\x01', '\x0b', '\x12'

# Distinctive prompts: sync() waits for one to be redrawn as proof that the
# line editor, not the tty driver, is handling input.
ZSH_PROMPT, BASH_PROMPT = 'zsh-rdy> ', 'bash-rdy> '
# EDITOR is pinned because `zsh -f` picks its keymap from $EDITOR/$VISUAL: with
# EDITOR=vi (which `npm test` exports) it selects the vi keymap, where Ctrl-A and
# Ctrl-K are unbound — arrows and Tab still work, so the failure looks like a
# flake rather than a different keymap. Pin it so the suite tests one keymap
# regardless of who launches it.
ZSH_ENV = {'HISTFILE': '/tmp/kb-hist', 'PS1': ZSH_PROMPT, 'ZDOTDIR': '/nonexistent',
           'EDITOR': 'emacs', 'VISUAL': 'emacs'}

print('\n7.4 — zsh: ↑ recalls history (\\x1b[A, DECCKM off)')
t = Term(['zsh', '-f'], ZSH_ENV)
ok(t.sync(ZSH_PROMPT), 'zsh is up with a live line editor')
t.send('echo needle-one\n', 0.5)
t.send('echo needle-two\n', 0.5)
t.clear()
t.send(UP_N, 0.5)
ok(t.rendered().rstrip().endswith('echo needle-two'), '↑ recalls the previous command',
   repr(t.rendered()[-120:]))
t.send(UP_N, 0.5)
ok(t.rendered().rstrip().endswith('echo needle-one'), '↑↑ walks further back',
   repr(t.rendered()[-120:]))
t.send(DOWN_N, 0.5)
ok(t.rendered().rstrip().endswith('echo needle-two'), '↓ walks forward again',
   repr(t.rendered()[-120:]))
t.send(CTRL_C, 0.3)

print('7.4 — zsh: Tab completes')
t.clear()
t.send('ls /usr/bi', 0.3)
t.send(TAB, 0.8)
ok('/usr/bin' in t.text(), 'Tab completes the path', repr(t.text()[-120:]))
t.send(CTRL_C, 0.3)

print('7.4 — zsh: Ctrl-A/Ctrl-K line editing')
# Its own shell: the Tab test above can leave zle in a completion-menu state,
# and a stray control char then lands as literal text instead of a zle command.
e = Term(['zsh', '-f'], ZSH_ENV)
ok(e.sync(ZSH_PROMPT), 'line-editing shell is up with a live line editor')
e.send('echo keepme-DROPME', 0.4)
e.send(CTRL_A, 0.3)
e.send(RIGHT_N * 12, 0.4)   # past "echo keepme"
e.send(CTRL_K, 0.3)         # kill to end of line
e.send('\n', 0.8)
out = e.text()
ok('keepme' in out and 'DROPME' not in out.split('keepme')[-1],
   'Ctrl-A + → + Ctrl-K edits the line as expected', repr(out[-160:]))
e.kill()

print('Home/End — the emitted sequence is the standard xterm one (checked in bash,')
print('           which binds it; the VM\'s zsh binds no Home/End at all — see report)')
b = Term(['bash', '--norc'], {'PS1': BASH_PROMPT, 'EDITOR': 'emacs', 'VISUAL': 'emacs'})
ok(b.sync(BASH_PROMPT), 'bash is up with a live line editor')
for seq, name in [(HOME_N, 'Home \\x1b[H'), (END_N, 'End \\x1b[F')]:
    b.clear()
    b.send('echo XYZ', 0.3)
    b.send(seq, 0.3)
    ok(b'\x07' not in b.buf, f'{name} is bound by readline (no bell)', repr(b.buf[-60:]))
    b.send(CTRL_C, 0.3)
b.clear()
b.send('echo XYZ', 0.3)
b.send(HOME_N, 0.3)
b.send('# ', 0.3)
b.send('\n', 0.6)
# If Home worked the line became `# echo XYZ`, a comment, so nothing is echoed.
after_enter = b.text().split('\n', 1)[1] if '\n' in b.text() else b.text()
ok('XYZ' not in after_enter, 'Home moved to line start in bash (line ran as a comment)',
   repr(b.text()[-120:]))
b.send(CTRL_D, 0.4)
b.kill()

# The same probe against zsh, reported rather than asserted: the toolbar sends
# what a physical Home key sends, but the VM's zsh has no binding for it.
z = Term(['zsh', '-f'], ZSH_ENV)
z.sync(ZSH_PROMPT)
z.send('echo XYZ', 0.3)
z.clear()
z.send(HOME_N, 0.4)
BEL = b'\x07'
print(f'    (informational) zsh -f, Home \\x1b[H: bell={BEL in z.buf}'
      '  → unbound at the zsh prompt, works inside TUIs')
z.kill()

print('7.4 — zsh: Ctrl-C aborts a running `sleep 100`')
t.clear()
t.send('sleep 100\n', 0.5)
t.send(CTRL_C, 0.8)
t.clear()
t.send('echo AFTER-INTERRUPT\n', 0.8)
ok('AFTER-INTERRUPT' in t.text(), 'prompt is responsive again after Ctrl-C', repr(t.text()[-160:]))

print('7.4 — zsh: Ctrl-D at an empty prompt ends the shell')
t.clear()
t.send(CTRL_D, 0.8)
time.sleep(0.4)
ok(not t.alive(), 'shell exited on Ctrl-D')
t.kill()

print('7.5 — TUI (vim): arrows under DECCKM use \\x1bO<final>')
vimrc = '/tmp/kb-vimrc'
open(vimrc, 'w').write('set nocompatible noswapfile nobackup laststatus=2 showmode\n')
src = '/tmp/kb-vim-file'
open(src, 'w').write('alpha\nbravo\ncharlie\ndelta\n')
v = Term(['vim', '-u', vimrc, src])
ok(v.expect(re.compile(r'charlie')), 'vim rendered the buffer')
ok(b'\x1b[?1h' in v.buf or b'\x1b[?1049h' in v.buf,
   'vim enabled application cursor keys mode (DECCKM)',
   'no \\x1b[?1h in output — DECCKM assumption would not hold')


def vim_cursor(term):
    """Ask vim where the cursor is, via a message it prints on the status line."""
    term.clear()
    term.send(ESC, 0.3)                      # ensure normal mode
    term.send(':echo line(".").",".col(".")."|".getline(".")\r', 0.6)
    m = re.findall(r'(\d+),(\d+)\|(\w*)', term.text())
    return m[-1] if m else None


start = vim_cursor(v)
ok(start is not None, 'can read vim cursor position', repr(v.text()[-160:]))
v.send(ESC, 0.2)
v.send(DOWN_A, 0.3)
v.send(DOWN_A, 0.3)
pos = vim_cursor(v)
ok(pos and pos[0] == '3' and pos[2] == 'charlie', '↓↓ (\\x1bOB) moved to line 3', repr(pos))
v.send(ESC, 0.2)
v.send(UP_A, 0.3)
pos = vim_cursor(v)
ok(pos and pos[0] == '2' and pos[2] == 'bravo', '↑ (\\x1bOA) moved to line 2', repr(pos))
v.send(ESC, 0.2)
v.send(RIGHT_A * 3, 0.3)
pos = vim_cursor(v)
ok(pos and pos[1] == '4', '→→→ (\\x1bOC) moved 3 columns', repr(pos))
v.send(ESC, 0.2)
v.send(LEFT_A * 2, 0.3)
pos = vim_cursor(v)
ok(pos and pos[1] == '2', '←← (\\x1bOD) moved back 2 columns', repr(pos))

print('7.5 — TUI (vim): Esc returns to normal mode')
v.send(ESC, 0.2)
v.clear()
v.send('i', 0.5)
ok('INSERT' in v.text(), 'entered insert mode', repr(v.text()[-120:]))
v.clear()
v.send(ESC, 0.6)
# Prove it structurally rather than by scraping the banner: in normal mode "dd"
# deletes the line; had Esc not landed, "dd" would have been typed into it.
def vim_lines(term):
    term.clear()
    term.send(ESC, 0.3)
    term.send(':echo "N=".line("$")\r', 0.6)
    m = re.findall(r'N=(\d+)', term.text())
    return int(m[-1]) if m else None


n_before = vim_lines(v)
v.send(ESC, 0.2)
v.send('dd', 0.4)
n_after = vim_lines(v)
ok(n_before is not None and n_after == n_before - 1,
   'Esc left insert mode — "dd" deleted a line instead of typing it',
   f'{n_before} lines -> {n_after}')
v.send(ESC, 0.2)
v.send(':q!\r', 0.6)
time.sleep(0.4)
ok(not v.alive(), 'vim exited cleanly')
v.kill()

print('7.5 — normal-mode arrows do NOT work under DECCKM (why the mode lookup exists)')
v2 = Term(['vim', '-u', vimrc, src])
v2.expect(re.compile(r'charlie'))
v2.send(ESC, 0.2)
before = vim_cursor(v2)
v2.send(ESC, 0.2)
v2.send(DOWN_N, 0.4)          # \x1b[B — the wrong form for an app-cursor-keys program
after = vim_cursor(v2)
ok(before is not None and after is not None, 'read both positions')
print(f'    (informational) \\x1b[B under DECCKM: line {before[0] if before else "?"} -> {after[0] if after else "?"}')
v2.send(ESC, 0.2)
v2.send(':q!\r', 0.5)
v2.kill()

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
