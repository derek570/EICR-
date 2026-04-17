Analysis — description contains a literal tab (U+0009) instead of `\t`.

```json
{
  "recommendations": [
    {
      "title": "Review tabular output formatting",
      "description": "Row A	Row B	Row C — three columns should survive JSON parse after repair.",
      "explanation": "Just a tab repair test.",
      "category": "formatting",
      "token_impact": 0,
      "file": "scripts/analyze-session.js",
      "old_code": "console.log('a');",
      "new_code": "console.log('a');"
    }
  ],
  "summary": "Tab fixture."
}
```
