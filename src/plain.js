// 纯文本字段：去掉 Mindustry 富文本颜色标记，便于客户端搜索
//
// 只移除明确的颜色标记（[red] / [#00ff00] / []），保留普通英文里的方括号：
// "[Mod] New content" 这种不会被误删。

const NAMED_COLORS = [
  'white',
  'lightgray',
  'gray',
  'darkgray',
  'black',
  'red',
  'green',
  'blue',
  'pink',
  'purple',
  'yellow',
  'orange',
  'brown',
  'cyan',
  'magenta',
  'lime',
  'teal',
  'navy',
  'maroon',
  'olive',
  'silver',
  'gold',
  'violet',
  'coral',
  'salmon',
  'tan',
  'beige',
  'crimson',
  'indigo',
  'khaki',
  'lavender',
  'plum',
  'orchid',
  'sienna',
  'turquoise',
  'azure',
  'ivory',
  'sky',
  'royal',
  'forest',
  'sea',
];

const COLOR_TAG_RE = new RegExp(
  `\\[(?:${NAMED_COLORS.join('|')}|#[0-9a-fA-F]{3,8})\\]`,
  'g',
);

export function stripMindustryColors(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text
    .replace(COLOR_TAG_RE, '')
    .replace(/\[\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 生成 index 条目里的三个纯文本字段
export function plainFields(source) {
  return {
    namePlain: stripMindustryColors(source?.name),
    authorPlain: stripMindustryColors(source?.author),
    descriptionPlain: stripMindustryColors(source?.description),
  };
}
