#!/usr/bin/env node
// Render a prompt template with {{PLACEHOLDER}} substitutions.
//
// Usage:
//   render-prompt.js <template.md> <vars.json> <output.md>
//
// vars.json is a flat object: { "KEY": "string value", ... }
// Missing keys render as empty strings (logged to stderr).

const fs = require('fs');
const path = require('path');

const [, , templatePath, varsPath, outputPath] = process.argv;

if (!templatePath || !varsPath || !outputPath) {
  console.error('Usage: render-prompt.js <template.md> <vars.json> <output.md>');
  process.exit(1);
}

let template;
try {
  template = fs.readFileSync(templatePath, 'utf8');
} catch (e) {
  console.error(`ERROR: cannot read template ${templatePath}: ${e.message}`);
  process.exit(1);
}

let vars;
try {
  vars = JSON.parse(fs.readFileSync(varsPath, 'utf8'));
} catch (e) {
  console.error(`ERROR: cannot parse vars JSON ${varsPath}: ${e.message}`);
  process.exit(1);
}

const used = new Set();
const rendered = template.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, key) => {
  used.add(key);
  if (Object.prototype.hasOwnProperty.call(vars, key)) {
    const v = vars[key];
    return v == null ? '' : String(v);
  }
  console.error(`WARN: placeholder {{${key}}} has no value — rendering empty`);
  return '';
});

// Note any vars that weren't used (likely typos)
for (const key of Object.keys(vars)) {
  if (!used.has(key)) {
    console.error(`WARN: var ${key} provided but not referenced by template`);
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, rendered, 'utf8');
