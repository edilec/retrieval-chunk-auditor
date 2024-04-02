// Call only after JSON.parse succeeds. The scanner tracks each object's decoded
// member names without treating quoted values or names in other objects as keys.
export function hasDuplicateJsonKey(text) {
  const stack = []
  const consumeValue = () => {
    const parent = stack.at(-1)
    if (parent && (parent.state === 'value' || parent.state === 'valueOrClose')) {
      parent.state = 'commaOrClose'
    }
  }
  let at = 0
  while (at < text.length) {
    const char = text[at]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') { at += 1; continue }
    if (char === '"') {
      const start = at
      at += 1
      while (at < text.length) {
        if (text[at] === '\\') { at += 2; continue }
        if (text[at] === '"') { at += 1; break }
        at += 1
      }
      const parent = stack.at(-1)
      if (parent?.kind === 'object' && parent.state === 'keyOrClose') {
        const key = JSON.parse(text.slice(start, at))
        if (parent.keys.has(key)) return true
        parent.keys.add(key)
        parent.state = 'colon'
      } else consumeValue()
      continue
    }
    if (char === '{' || char === '[') {
      consumeValue()
      stack.push(char === '{'
        ? { kind: 'object', state: 'keyOrClose', keys: new Set() }
        : { kind: 'array', state: 'valueOrClose' })
      at += 1
      continue
    }
    if (char === '}' || char === ']') { stack.pop(); at += 1; continue }
    if (char === ':') { stack.at(-1).state = 'value'; at += 1; continue }
    if (char === ',') {
      const parent = stack.at(-1)
      parent.state = parent.kind === 'object' ? 'keyOrClose' : 'valueOrClose'
      at += 1
      continue
    }
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at += 1
    consumeValue()
  }
  return false
}
