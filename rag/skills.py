import re
from . import config as C


class Skill:
    def __init__(self, name, title, intents, description, queries, body):
        self.name, self.title, self.intents = name, title, intents
        self.description, self.queries, self.body = description, queries, body


def load_skills():
    skills = {}
    for p in sorted(C.SKILLS_DIR.glob("*.md")):
        raw = p.read_text(encoding="utf-8")
        m = re.match(r"---\r?\n(.*?)\r?\n---\r?\n(.*)", raw, re.S)
        if not m:
            continue
        fm = {}
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
        s = Skill(fm["name"], fm.get("title", fm["name"]),
                  [x.strip() for x in fm.get("intents", "").split(",") if x.strip()],
                  fm.get("description", ""),
                  [q.strip() for q in fm.get("queries", "").split("|") if q.strip()],
                  m.group(2).strip())
        skills[s.name] = s
    return skills


# intent -> skills to read
INTENT_SKILLS = {
    "audit": ["ca_auditor"],
    "observations": ["ca_auditor_observations", "ca_auditor"],
    "risk": ["risk_analysis"],
    "painpoint": ["pain_points"],
    "financial": ["financial_analysis"],
    "compare": ["comparison"],
    "general": [],
}
