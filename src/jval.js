// Arc Jval/Hparser 宽松解析器（Hjson 超集）的最小实现
// 支持：注释 # ///* */、根大括号可省、无引号 key/值、单双引号、''' 多行、
// 逗号可选、引号内裸换行、重复 key 后值生效、严格 JSON 数字（前导 0 非法）。
// BOM 不剥离（游戏会把 BOM 并进第一个 key）。

function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function skipWhitespace(text, state) {
  while (state.index < text.length) {
    const char = text[state.index];
    if (isSpace(char)) {
      state.index += 1;
      continue;
    }
    if (char === '#') {
      const end = text.indexOf('\n', state.index);
      state.index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && text[state.index + 1] === '/') {
      const end = text.indexOf('\n', state.index);
      state.index = end === -1 ? text.length : end;
      continue;
    }
    if (char === '/' && text[state.index + 1] === '*') {
      const end = text.indexOf('*/', state.index + 2);
      state.index = end === -1 ? text.length : end + 2;
      continue;
    }
    break;
  }
}

function parseEscape(text, state) {
  const char = text[state.index];
  state.index += 1;
  switch (char) {
    case 'b': return '\b';
    case 'f': return '\f';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'u': {
      const hex = text.slice(state.index, state.index + 4);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        state.index += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      return 'u';
    }
    default: return char ?? '';
  }
}

function readQuoted(text, state, quote) {
  state.index += 1;
  let value = '';
  while (state.index < text.length) {
    const char = text[state.index];
    if (char === '\\') {
      state.index += 1;
      value += parseEscape(text, state);
      continue;
    }
    if (char === quote) {
      state.index += 1;
      return value;
    }
    // 引号内允许裸换行（Jval 行为，严格 HJSON 会拒绝）
    value += char;
    state.index += 1;
  }
  throw new Error('未闭合的字符串');
}

function readMultiline(text, state) {
  state.index += 3;
  const start = state.index;
  const end = text.indexOf("'''", state.index);
  if (end === -1) throw new Error('未闭合的多行字符串');
  const body = text.slice(start, end);
  state.index = end + 3;
  const lines = body.split(/\r?\n/);
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^[ \t]*/)[0].length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(indent)).join('\n');
}

function looksLikeNumber(token) {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token);
}

function readQuotelessValue(text, state, stopAtSpace = false) {
  const start = state.index;
  while (state.index < text.length) {
    const char = text[state.index];
    if (char === ',' || char === ']' || char === '}' || char === '\n' || char === '\r') break;
    if (stopAtSpace && isSpace(char)) break;
    // 只有注释出现在 token 起始或空白之后才算注释；URL/作者名里的 #、// 要保留完整
    const previous = state.index === start ? null : text[state.index - 1];
    const atTokenBoundary = previous === null || isSpace(previous);
    if (
      atTokenBoundary &&
      (char === '#' ||
        (char === '/' && (text[state.index + 1] === '/' || text[state.index + 1] === '*')))
    ) {
      break;
    }
    state.index += 1;
  }
  const token = text.slice(start, state.index).trim();
  if (token.length === 0) throw new Error('缺少值');
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  return looksLikeNumber(token) ? Number(token) : token;
}

function readValue(text, state, stopAtSpace = false) {
  skipWhitespace(text, state);
  if (state.index >= text.length) throw new Error('缺少值');
  const char = text[state.index];
  if (char === '{') return readObject(text, state);
  if (char === '[') return readArray(text, state);
  if (char === '"' || char === "'") {
    if (text.startsWith("'''", state.index)) return readMultiline(text, state);
    return readQuoted(text, state, char);
  }
  return readQuotelessValue(text, state, stopAtSpace);
}

function readKey(text, state) {
  skipWhitespace(text, state);
  if (state.index >= text.length) throw new Error('缺少 key');
  const char = text[state.index];
  if (char === '"' || char === "'") return readQuoted(text, state, char);
  const start = state.index;
  while (state.index < text.length) {
    const current = text[state.index];
    if (isSpace(current) || '{}[],:'.includes(current)) break;
    state.index += 1;
  }
  if (state.index === start) throw new Error('缺少 key');
  return text.slice(start, state.index);
}

function readObjectBody(text, state, braced) {
  const result = {};
  while (state.index < text.length) {
    skipWhitespace(text, state);
    if (state.index >= text.length) break;
    if (braced && text[state.index] === '}') {
      state.index += 1;
      return result;
    }
    const key = readKey(text, state);
    skipWhitespace(text, state);
    if (text[state.index] !== ':') throw new Error('key 后缺少冒号');
    state.index += 1;
    result[key] = readValue(text, state);
    skipWhitespace(text, state);
    if (text[state.index] === ',') {
      state.index += 1;
      continue;
    }
    if (braced && text[state.index] === '}') {
      state.index += 1;
      return result;
    }
    // 逗号完全可选，继续读下一个 key
  }
  if (braced) throw new Error('未闭合的对象');
  return result;
}

function readObject(text, state) {
  state.index += 1;
  return readObjectBody(text, state, true);
}

function readArray(text, state) {
  state.index += 1;
  const result = [];
  while (state.index < text.length) {
    skipWhitespace(text, state);
    if (text[state.index] === ']') {
      state.index += 1;
      return result;
    }
    result.push(readValue(text, state, true));
    skipWhitespace(text, state);
    if (text[state.index] === ',') state.index += 1;
  }
  throw new Error('未闭合的数组');
}

export function parseJval(text) {
  const state = { index: 0 };
  skipWhitespace(text, state);
  let value;
  if (text[state.index] === '{') {
    value = readObject(text, state);
  } else {
    value = readObjectBody(text, state, false);
  }
  skipWhitespace(text, state);
  if (state.index < text.length) throw new Error('多余字符');
  return value;
}
