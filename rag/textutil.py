import re

_TOK = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")


def tokenize(s: str):
    s = s.lower().replace(",", "")
    return _TOK.findall(s)
