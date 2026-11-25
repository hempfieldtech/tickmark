---
tags: [demo, reference]
---
# Formatting

Regular **markdown**: *italics*, `code`, ~~strikethrough~~, [links](https://example.com), > quotes, tables and lists.

| Shortcut | Does |
| --- | --- |
| `Ctrl+B` | Bold |
| `Ctrl+L` | Checklist item |
| `Ctrl+Shift+Enter` | Zen mode |

## Code blocks

```js
// Highlighted by language
const done = tasks.filter((t) => t.checked).length;
```

```python
def greet(name):
    return f"Hello, {name}"
```

## Embeds

An embed shows another note (or one heading of it) inside this one:

![[Tasks and states#Checkbox states]]

## HTML and CSS

Notes can hold HTML and their own CSS. The CSS only styles the note, never the app around it.

<style>
.callout { border-left: 4px solid var(--accent); padding: 8px 14px; background: var(--accent-soft); border-radius: 6px; }
</style>

<div class="callout">A callout made with a <code>&lt;div&gt;</code> and a <code>&lt;style&gt;</code> block.</div>

<details><summary>Click to open</summary>Hidden until you open it.</details>
