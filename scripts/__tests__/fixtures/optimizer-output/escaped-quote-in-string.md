Covers the case where a string value contains an escaped quote (`\"`). The repair pass MUST NOT flip its "inside string" state on the escaped quote, otherwise it will mis-classify subsequent newlines.

```json
{
  "recommendations": [
    {
      "title": "Handle escaped quotes",
      "description": "User said \"the installation is sound\" and we need to preserve that exact quote.",
      "explanation": "Escaped-quote test.",
      "category": "parser",
      "token_impact": 0,
      "file": "Resources/default_config.json",
      "old_code": "\"quoted\": false",
      "new_code": "\"quoted\": true"
    }
  ],
  "summary": "Escaped-quote fixture — \"quoted\" content survives round-trip."
}
```
