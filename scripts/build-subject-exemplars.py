"""
Turn a teacher's essay-question slide decks into exemplar JSON for the grader.

    python3 -I scripts/build-subject-exemplars.py OUT.json DECK.pptx [DECK.pptx ...]

Each deck is a run of question slides ("Using real-world examples, discuss ...
[15 marks]"), each followed by the teacher's marking notes for it. The script
splits on question slides and keeps the notes that follow, so the grader can
be shown the notes for the bank question nearest the one it is marking.

The output is teaching material that belongs to whoever wrote the decks. This
repository is public, so the JSON must NOT be committed: write it under
`data/private/` (gitignored) locally, and copy it to the server's shared
directory (see lib/subject-exemplars.ts for where it is read from).

Slides that are only a picture -- most of the diagrams -- carry no text and are
recorded as a "[diagram]" marker, so the notes still say a diagram belongs
there.
"""

import html
import json
import re
import sys
import zipfile

QUESTION = re.compile(
    r"(using (real[- ]?(world|life)|diagrams)|with reference to|to what extent|"
    r"\[\s*15\s*(marks?)?\s*\]|\(\s*15\s*marks?\s*\))",
    re.I,
)
# Slide numbers and stray digits the decks print as their own paragraph.
NOISE = re.compile(r"^\s*\d{1,3}\s*$")
MAX_NOTES = 6000


def slides(path):
    deck = zipfile.ZipFile(path)
    names = sorted(
        (n for n in deck.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
        key=lambda n: int(re.findall(r"\d+", n)[0]),
    )
    for name in names:
        xml = deck.read(name).decode("utf8")
        paras = [
            html.unescape("".join(re.findall(r"<a:t>([^<]*)</a:t>", p))).strip()
            for p in re.findall(r"<a:p>.*?</a:p>", xml, re.S)
        ]
        paras = [p for p in paras if p and not NOISE.match(p)]
        rels = name.replace("slides/", "slides/_rels/") + ".rels"
        has_picture = rels in deck.namelist() and "media/" in deck.read(rels).decode("utf8")
        yield paras, has_picture


def is_question(paras):
    head = " ".join(paras[:2])
    return bool(paras) and len(head) < 400 and bool(QUESTION.search(head))


def build(paths):
    out = []
    for path in paths:
        current = None
        for paras, has_picture in slides(path):
            if is_question(paras):
                if current and current["notes"]:
                    out.append(current)
                current = {
                    "question": re.sub(r"^(Q\d+\s*(CH\d+)?|\(b\))\s*", "", paras[0]).strip(),
                    "notes": [],
                    "source": path.rsplit("/", 1)[-1],
                }
                rest = paras[1:]
            else:
                rest = paras
            if current is None:
                continue
            if rest:
                current["notes"].append("\n".join(rest))
            elif has_picture:
                current["notes"].append("[diagram]")
        if current and current["notes"]:
            out.append(current)

    result = []
    for item in out:
        notes = "\n\n".join(item["notes"])
        notes = re.sub(r"(\[diagram\]\s*){2,}", "[diagram]\n\n", notes)
        if len(notes.split()) < 60:
            continue  # a question list or title slide, not marking notes
        question = item["question"]
        if not QUESTION.search(question):
            # A section heading ("Past exam questions", "Essay structure I")
            # sat where the question should be; the real one is in the notes.
            found = next((line for line in notes.splitlines() if QUESTION.search(line)), None)
            if found:
                question = re.sub(r"^(Q\d+\s*(CH\d+)?|\(b\))\s*", "", found).strip()
            else:
                # A continuation of the previous question's notes.
                if result:
                    result[-1]["notes"] = (result[-1]["notes"] + "\n\n" + question + "\n" + notes)[:MAX_NOTES]
                continue
        result.append({**item, "question": question, "notes": notes[:MAX_NOTES]})
    return result


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    items = build(sys.argv[2:])
    with open(sys.argv[1], "w", encoding="utf8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    print(f"{len(items)} exemplars -> {sys.argv[1]}")
    for item in items:
        print(f"  {len(item['notes'].split()):5d} words  {item['question'][:110]}")
