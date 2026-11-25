const relations = new Map([["=", "="], ["≈", "\\approx"], ["≠", "\\ne"], ["≤", "\\le"], ["≥", "\\ge"]]);
const operators = { "|": "\\mid", "×": "\\times", "¬": "\\neg", "−": "-", "÷": "\\div", "%": "\\%" };

function cellTex(cell) {
  if (cell.querySelector(":not(em, i, strong, b, span), [data-tex], [data-latex]")) return null;
  const text = cell.textContent.replace(/\s+/gu, " ").trim();
  if (!text || !/^[A-Za-z0-9\s|×¬−÷%(),.+\-:?!]+$/u.test(text)) return null;
  return text.replace(/[A-Za-z]{2,}|[|×¬−÷%]/gu, (token) =>
    operators[token] ? ` ${operators[token]} ` : "\\mathrm{" + token + "}");
}

export function equationTableTex(table) {
  const rows = [...table.rows];
  if (!rows.length || rows.length % 2 || table.querySelector("caption, th, table")) return null;
  const equations = [];
  for (let index = 0; index < rows.length; index += 2) {
    const top = [...rows[index].cells];
    const bottom = [...rows[index + 1].cells];
    const numeratorIndex = top.findIndex(cell => cell.classList.contains("numerator"));
    const numerator = top[numeratorIndex];
    const [denominator] = bottom;
    if (!numerator || bottom.length !== 1 || !denominator.classList.contains("denominator")
        || numerator.rowSpan !== 1 || denominator.rowSpan !== 1 || numerator.colSpan !== denominator.colSpan) return null;
    if (top.slice(numeratorIndex + 1).some(cell => cell.rowSpan !== 2 || cell.textContent.trim() || cell.children.length)) return null;

    const above = cellTex(numerator);
    const below = cellTex(denominator);
    if (!above || !below) return null;
    const fraction = "\\frac{" + above + "}{" + below + "}";
    if (numeratorIndex === 0) {
      equations.push({ fraction });
      continue;
    }
    const [left, relation] = top;
    if (numeratorIndex !== 2 || [left, relation].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 2)) return null;
    const lhs = cellTex(left);
    const op = relations.get(relation.textContent.trim());
    if (!lhs || !op || relation.children.length) return null;
    equations.push({ lhs, op, fraction });
  }
  if (equations.length === 1) {
    const [{ lhs, op, fraction }] = equations;
    return lhs ? [lhs, op, fraction].join(" ") : fraction;
  }
  const lines = equations.map(({ lhs, op, fraction }) => lhs ? lhs + " &" + op + " " + fraction : "&" + fraction);
  return "\\begin{aligned}\n" + lines.join(" \\\\\n") + "\n\\end{aligned}";
}

export function standAloneTableHtml(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll("script,style,iframe,object,embed,form,link,meta").forEach(item => item.remove());
  for (const item of [clone, ...clone.querySelectorAll("*")]) {
    for (const attr of [...item.attributes]) {
      if (!/^(?:class|id|colspan|rowspan|scope|headers|abbr|alt|title|align|valign|height|width|role|aria-[a-z-]+)$/iu.test(attr.name)
          && !(["href", "src"].includes(attr.name) && /^(?:https?:\/\/|#)/iu.test(attr.value))) {
        item.removeAttribute(attr.name);
      }
    }
  }
  if (clone.classList.contains("equation")) {
    clone.querySelectorAll("td.numerator").forEach(cell => {
      cell.style.borderBottom = "1px solid currentColor";
      cell.style.textAlign = "center";
    });
    clone.querySelectorAll("td.denominator").forEach(cell => { cell.style.textAlign = "center"; });
  }
  // Blank lines inside an HTML block split it in Obsidian's Markdown parser.
  return "\n\n" + clone.outerHTML.replace(/\r?\n[ \t]*\r?\n+/gu, "\n") + "\n\n";
}
