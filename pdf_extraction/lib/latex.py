"""
LaTeX normalization — fixes the display/rendering problems.

Problem: DeepSeek emits inconsistent math formatting:
  - Bare operators: "8 m s^{-1}" with no $...$ delimiters
  - Currency $ collides with math $: "$0.40 per minute"
  - Mixed delimiters: backslash-paren vs $...$ vs bare

This module normalizes everything to ONE convention:
  - Inline math:   $...$
  - Display math:  $$...$$
  - Currency:      \\$ (escaped so KaTeX ignores it)
"""
import re

# ---------------------------------------------------------
# 1. Currency protection
# ---------------------------------------------------------
# A $ followed by a digit and common currency patterns → \$ (escaped)
# Order matters: do this BEFORE math normalization.
_CURRENCY_RE = re.compile(
    r"\$(?=\s?\d)"          # $ optionally-space then digit
)

# ---------------------------------------------------------
# 2. Bare math detection — wrap specific operator tokens, NOT surrounding prose
# ---------------------------------------------------------
# Each pattern matches a *self-contained* math token that is not already inside $...$
# We deliberately keep these narrow to avoid swallowing sentences.

_BARE_PATTERNS = [
    # standalone \frac{a}{b}  (process FIRST so inner x^3 isn't separately wrapped)
    (re.compile(r"(?<![\w$])(\\frac\{[^}]+\}\{[^}]+\})"), r"$\1$"),
    # standalone \sqrt{...}
    (re.compile(r"(?<![\w$])(\\sqrt\{[^}]+\})"), r"$\1$"),
    # superscript with braces:  x^{-1}  v^{2}   (not inside {…})
    (re.compile(r"(?<![\w${])([a-zA-Z]\^\{-?\d+\})"), r"$\1$"),
    # subscript with braces:  x_{1}   (not inside {…})
    (re.compile(r"(?<![\w${])([a-zA-Z]_\{\d+\})"), r"$\1$"),
    # single-char superscript:  x^2   (allow digit prefix like 3x^2; not inside {…})
    (re.compile(r"(?<![{])([a-zA-Z]\^\d)(?!\})"), r"$\1$"),
    # inverse trig / functions:  sin^{-1}  cos^{-1}  tan^{-1}
    (re.compile(r"(?<![\w$\\])((?:sin|cos|tan)\^\{-?1\})"), r"$\1$"),
    # single greek letters
    (re.compile(r"(?<![\w$])(\\(?:theta|alpha|beta|pi|lambda|mu|sigma|omega))\b"), r"$\1$"),
]


def _escape_currency(text: str) -> str:
    """Escape $ that precede digits (currency) as \\$."""
    return _CURRENCY_RE.sub(r"\\$", text)


def _wrap_bare_math(text: str) -> str:
    """Wrap self-contained bare-LaTeX tokens in $...$ so they render."""
    for pat, repl in _BARE_PATTERNS:
        # We can't use a plain sub with a string replacement because the
        # replacement may itself contain backrefs; but the negative lookbehind
        # in the pattern already guards against inside-$...$ runs at the token
        # boundary. To be safe against mid-math matches, walk the string and
        # skip replacements that fall between an odd count of $.
        out = []
        last = 0
        dollar_count = 0
        for m in pat.finditer(text):
            # count $ up to this match start
            dollar_count = text[: m.start()].count("$") - dollar_count
            # simpler: recompute parity fresh
            parity = text[: m.start()].count("$") % 2
            if parity == 1:
                # we're inside math already
                continue
            out.append(text[last : m.start()])
            out.append(m.expand(repl))
            last = m.end()
        out.append(text[last:])
        text = "".join(out)
    return text


def _normalize_existing_delimiters(text: str) -> str:
    """Convert \\( ... \\) and \\[ ... \\] to $...$ and $$...$$."""
    # Display: \[ ... \]
    text = re.sub(r"\\\[\s*(.*?)\s*\\\]", r"$$\1$$", text, flags=re.DOTALL)
    # Inline: \( ... \)
    text = re.sub(r"\\\(\s*(.*?)\s*\\\)", r"$\1$", text, flags=re.DOTALL)
    return text


def _fix_fractions(text: str) -> str:
    """Convert simple a/b inside math to \\frac{a}{b} when it looks like math."""
    # Only touch fractions already inside $...$
    def repl_math(m):
        inner = m.group(1)
        # 7/15 → \frac{7}{15}, but leave coordinate (3,4) alone
        inner = re.sub(
            r"(?<![\w.])(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)",
            r"\\frac{\1}{\2}",
            inner,
        )
        return f"${inner}$"
    return re.sub(r"\$([^$]+)\$", repl_math, text)


def normalize_latex(text: str) -> str:
    """
    Full normalization pipeline. Idempotent — safe to run on new or existing text.
    """
    if not text:
        return text
    # 1. protect currency $ first
    text = _escape_currency(text)
    # 2. unify delimiter style
    text = _normalize_existing_delimiters(text)
    # 3. wrap bare operators
    text = _wrap_bare_math(text)
    # 4. upgrade simple fractions inside math
    text = _fix_fractions(text)
    return text


def is_mark_scheme_json(content: str) -> bool:
    """Detect rows that are MS JSON blobs misfiled as question content."""
    return content.lstrip().startswith('{"marking_points"')
