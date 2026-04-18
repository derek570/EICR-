Analysis of session: all fields captured cleanly, no multi-line edits needed.

```json
{
  "recommendations": [
    {
      "title": "Raise keyword boost for 'Ze'",
      "description": "Deepgram transcribed 'Ze' correctly in all utterances but confidence was borderline.",
      "explanation": "Tiny tweak — no behaviour change expected, just extra safety.",
      "category": "keyword_boost",
      "token_impact": 0,
      "file": "Resources/default_config.json",
      "old_code": "\"ze\": 1.5",
      "new_code": "\"ze\": 2.0"
    }
  ],
  "sonnet_prompt_audit": {
    "current_estimated_tokens": 0,
    "suggested_trims": [],
    "redundant_fields": [],
    "net_token_change": 0
  },
  "summary": "Clean session. One minor keyword-boost tweak proposed."
}
```
