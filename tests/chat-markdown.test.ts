import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/components/ChatMarkdown";

const render = (content: string) => renderToStaticMarkup(createElement(ChatMarkdown, { content }));

describe("chat Markdown formatting", () => {
  it("renders the Scratch instruction example as paragraphs, bold text and bullets", () => {
    const html = render("Đã thêm điều khiển cho mèo:\n- Bấm **cờ xanh**: mèo về giữa sân khấu tại **(0, 0)**.\n- Giữ **các phím mũi tên**: mèo di chuyển theo hướng tương ứng.\n\nBấm cờ xanh để bắt đầu chơi nhé!");
    expect(html).toContain("<strong>cờ xanh</strong>");
    expect(html).toContain("<strong>(0, 0)</strong>");
    expect(html).toContain("<strong>các phím mũi tên</strong>");
    expect(html).toContain("<ul>");
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).not.toContain("**");
  });
  it("supports headings, code blocks, numbered lists and GFM tables", () => {
    const html = render("### Hướng dẫn\n\n1. Bấm `space`\n2. Chạy\n\n```json\n{\"score\": 1}\n```\n\n| Phím | Hành động |\n| --- | --- |\n| space | Tăng điểm |");
    expect(html).toContain("<h3>Hướng dẫn</h3>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>space</code>");
    expect(html).toContain('<pre><code class="language-json">');
    expect(html).toContain('<div class="markdown-table"><table>');
  });
  it("does not execute HTML or allow javascript links", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert%281%29)');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("href=");
  });
  it("opens safe links without opener access and does not fetch Markdown images", () => {
    const html = render("[Scratch](https://scratch.mit.edu)\n\n![Mèo](https://example.com/tracker.png)");
    expect(html).toContain('href="https://scratch.mit.edu"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("[Ảnh: Mèo]");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.png");
  });
});
