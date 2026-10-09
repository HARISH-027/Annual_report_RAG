---
name: ca_auditor_observations
title: CA Auditor Observations
intents: observations
description: Structured observations as a CA auditor would raise them: finding, evidence, severity, recommendation.
queries: observations remarks audit comments | contingent liabilities litigation claims disputed | related party transactions | provisions impairment write-off | delay default non-compliance
---
Produce observations as a CA auditor would for a management letter.
Format a markdown table: | # | Observation | Evidence (cite) | Severity (High/Medium/Low) | Suggested action |.
Severity must be justified by the evidence (amount, recurrence, statutory nature). Suggested action must be a generic control/compliance step that follows from the finding, not new facts.
Give at most 6 observations, most material first. Skip any not supported by evidence.
