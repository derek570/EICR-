Malformed output — string literal missing closing quote. Parser MUST fail loudly, not fall back to empty recommendations.

```json
{
  "recommendations": [
    {
      "title": "Broken title with unclosed string,
      "description": "This block is not recoverable.",
      "category": "broken"
    }
  ],
  "summary": "Intentionally broken for test."
}
```
