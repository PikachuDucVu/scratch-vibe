import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function ChatMarkdown({ content }: { content: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        // Keep react-markdown's default URL sanitizer; never parse raw HTML.
        a: ({ href, children }) => href
          ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          : <span>{children}</span>,
        // Model-generated images must not trigger unsolicited remote requests.
        img: ({ alt }) => <span className="markdown-image-label">[Ảnh{alt ? `: ${alt}` : ""}]</span>,
        table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
      }}
    >{content}</ReactMarkdown>
  </div>;
}
