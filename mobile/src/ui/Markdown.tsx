import MarkdownIt from "markdown-it";
import { showDialog } from "./dialog";
import { memo, useMemo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { SignedImage } from "./SignedImage";
import { usePalette, type Palette } from "./theme";

/**
 * A small markdown renderer for agent messages: markdown-it tokens → native views. No HTML, no
 * remote images: only images under the portal's /api/file are shown (fetched signed via the
 * gateway); anything else renders as a text placeholder. Links open only after a confirm.
 */

type Token = ReturnType<MarkdownIt["parse"]>[number];
type Node = { tok: Token; children: Node[] };

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

function tree(tokens: Token[]): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  for (const tok of tokens) {
    const level = stack[stack.length - 1];
    if (tok.nesting === 1) {
      const n: Node = { tok, children: [] };
      level.push(n);
      stack.push(n.children);
    } else if (tok.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else {
      level.push({ tok, children: [] });
    }
  }
  return root;
}

/** /api/file?path=<encoded> → the decoded VM path, or null for anything else. */
export function filePathFromSrc(src: string): string | null {
  const m = /^\/api\/file\?path=([^&#]+)/.exec(src);
  if (!m) return null;
  try {
    const p = decodeURIComponent(m[1]);
    return p.startsWith("/") && !p.includes("\0") ? p : null;
  } catch {
    return null;
  }
}

function openLink(href: string) {
  if (!/^https?:\/\//i.test(href)) return;
  showDialog("Open this link?", href.slice(0, 300), [
    { text: "Cancel", style: "cancel" },
    { text: "Open", onPress: () => { Linking.openURL(href).catch(() => {}); } },
  ]);
}

function Inline({ tokens, p, base }: { tokens: Token[]; p: Palette; base: TextStyle }): ReactNode {
  const out: ReactNode[] = [];
  let run: ReactNode[] = [];
  const styles: TextStyle[] = [];
  let href: string | null = null;
  let k = 0;
  const flush = () => {
    if (run.length) out.push(<Text key={`r${k++}`} selectable style={base}>{run}</Text>);
    run = [];
  };
  for (const t of tokens) {
    switch (t.type) {
      case "text":
      case "html_inline": {
        const link = href;
        run.push(
          <Text key={k++} style={[...styles]} onPress={link ? () => openLink(link) : undefined}>{t.content}</Text>,
        );
        break;
      }
      case "softbreak": run.push(" "); break;
      case "hardbreak": run.push("\n"); break;
      case "code_inline":
        run.push(<Text key={k++} style={[...styles, { fontFamily: "monospace", backgroundColor: p.code, fontSize: (base.fontSize ?? 15) - 1 }]}>{t.content}</Text>);
        break;
      case "strong_open": styles.push({ fontWeight: "700" }); break;
      case "em_open": styles.push({ fontStyle: "italic" }); break;
      case "s_open": styles.push({ textDecorationLine: "line-through" }); break;
      case "link_open": {
        const h = t.attrGet("href") ?? "";
        href = /^https?:\/\//i.test(h) ? h : null;
        styles.push(href ? { color: p.accent, textDecorationLine: "underline" } : {});
        break;
      }
      case "strong_close": case "em_close": case "s_close": styles.pop(); break;
      case "link_close": styles.pop(); href = null; break;
      case "image": {
        flush();
        const src = t.attrGet("src") ?? "";
        const alt = t.content || "";
        const path = filePathFromSrc(src);
        out.push(path
          ? <SignedImage key={`i${k++}`} path={path} alt={alt} />
          : <Text key={`i${k++}`} style={[base, { color: p.muted, fontStyle: "italic" }]}>[image: {alt || "external"}]</Text>);
        break;
      }
      default:
        if (t.content) run.push(t.content);
    }
  }
  flush();
  return <>{out}</>;
}

function Block({ node, p, depth }: { node: Node; p: Palette; depth: number }): ReactNode {
  const t = node.tok;
  const body: TextStyle = { color: p.text, fontSize: 15, lineHeight: 22 };
  const kids = (nodes: Node[]) => nodes.map((n, i) => <Block key={i} node={n} p={p} depth={depth + 1} />);
  switch (t.type) {
    case "paragraph_open":
      return <View style={st.para}>{kids(node.children)}</View>;
    case "inline":
      return <Inline tokens={t.children ?? []} p={p} base={body} />;
    case "heading_open": {
      const level = Number(t.tag.slice(1)) || 3;
      const size = level === 1 ? 20 : level === 2 ? 18 : 16;
      const inline = node.children.find((c) => c.tok.type === "inline");
      return (
        <View style={st.heading}>
          <Inline tokens={inline?.tok.children ?? []} p={p} base={{ ...body, fontSize: size, lineHeight: size * 1.35, fontWeight: "700" }} />
        </View>
      );
    }
    case "bullet_list_open":
    case "ordered_list_open": {
      const ordered = t.type === "ordered_list_open";
      const start = Number(t.attrGet("start") ?? 1) || 1;
      return (
        <View style={st.list}>
          {node.children.map((item, i) => (
            <View key={i} style={st.item}>
              <Text style={[body, st.marker]}>{ordered ? `${start + i}.` : "•"}</Text>
              <View style={{ flex: 1 }}>{kids(item.children)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "blockquote_open":
      return <View style={[st.quote, { borderLeftColor: p.border }]}>{kids(node.children)}</View>;
    case "fence":
    case "code_block":
      return (
        <ScrollView horizontal style={[st.code, { backgroundColor: p.code }]} contentContainerStyle={{ padding: 10 }}>
          <Text selectable style={{ color: p.text, fontFamily: "monospace", fontSize: 13, lineHeight: 18 }}>{t.content.replace(/\n$/, "")}</Text>
        </ScrollView>
      );
    case "hr":
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginVertical: 10 }} />;
    case "table_open": {
      const rows: Node[] = [];
      const collect = (ns: Node[]) => ns.forEach((n) => (n.tok.type === "tr_open" ? rows.push(n) : collect(n.children)));
      collect(node.children);
      return (
        <ScrollView horizontal style={[st.code, { borderColor: p.border, borderWidth: StyleSheet.hairlineWidth }]}>
          <View>
            {rows.map((r, i) => (
              <View key={i} style={{ flexDirection: "row", borderBottomWidth: i < rows.length - 1 ? StyleSheet.hairlineWidth : 0, borderColor: p.border }}>
                {r.children.map((cell, j) => (
                  <View key={j} style={{ padding: 6, minWidth: 90, maxWidth: 220 }}>
                    <Inline tokens={cell.children.find((c) => c.tok.type === "inline")?.tok.children ?? []} p={p}
                      base={{ ...body, fontSize: 13, lineHeight: 18, fontWeight: cell.tok.type === "th_open" ? "700" : "400" }} />
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    default:
      return node.children.length ? <View>{kids(node.children)}</View> : null;
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const p = usePalette();
  const nodes = useMemo(() => tree(md.parse(text.slice(0, 200_000), {})), [text]);
  return <View>{nodes.map((n, i) => <Block key={i} node={n} p={p} depth={0} />)}</View>;
});

const st = StyleSheet.create({
  para: { marginVertical: 3 },
  heading: { marginTop: 8, marginBottom: 4 },
  list: { marginVertical: 3 },
  item: { flexDirection: "row", gap: 6, marginVertical: 1 },
  marker: { minWidth: 18, textAlign: "right" },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 4 },
  code: { borderRadius: 6, marginVertical: 6 },
});
