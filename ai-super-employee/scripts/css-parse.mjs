import { readFileSync } from "node:fs";

/** 正确解析 CSS：返回 [{selector, body, media}]，media=null 表示顶层 */
export function parseCss(css) {
  const rules = [];
  let i = 0, media = null, buf = "";
  const stack = [];
  while (i < css.length) {
    const ch = css[i];
    if (ch === "{") {
      const head = buf.trim();
      buf = "";
      if (head.startsWith("@media") || head.startsWith("@supports") || head.startsWith("@layer")) {
        stack.push({ type: "at", media: head });
        media = head;
        i++;
        continue;
      }
      // 普通规则：找到匹配的 }
      let d = 1, j = i + 1;
      while (j < css.length && d > 0) {
        if (css[j] === "{") d++;
        else if (css[j] === "}") d--;
        j++;
      }
      rules.push({ selector: head.replace(/\s+/g, " "), body: css.slice(i + 1, j - 1), media });
      i = j;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      media = stack.length ? stack[stack.length - 1].media : null;
      buf = "";
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    buf += ch;
    i++;
  }
  return rules;
}

/** 某选择器在所有规则里的合并 body（按出现顺序，后者覆盖前者语义） */
export function cascade(rules, selector, { includeMedia = false } = {}) {
  return rules
    .filter((r) => r.selector === selector && (includeMedia || r.media === null))
    .map((r) => r.body)
    .join("\n");
}

export function prop(body, name) {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+)`, "g"))];
  return all.length ? all[all.length - 1][1].trim() : null;
}
