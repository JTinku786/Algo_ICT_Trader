"use client";

import { BookOpen } from "lucide-react";
import { createContext, useContext } from "react";
import { getBlogForCode } from "../data/strategy-blogs";

type BlogNav = { openBlog: (blogId: string) => void };

const BlogNavContext = createContext<BlogNav>({ openBlog: () => {} });

export function BlogNavProvider({ openBlog, children }: { openBlog: (blogId: string) => void; children: React.ReactNode }) {
  return <BlogNavContext.Provider value={{ openBlog }}>{children}</BlogNavContext.Provider>;
}

export function useBlogNav() {
  return useContext(BlogNavContext);
}

// Renders a strategy code. When a blog exists for that code it becomes a
// clickable link that opens the strategy's article; otherwise it renders as
// plain text so nothing looks broken for unmapped ids.
export function StrategyLink({
  code,
  label,
  className,
  showIcon = false,
}: {
  code: string | null | undefined;
  label?: string;
  className?: string;
  showIcon?: boolean;
}) {
  const { openBlog } = useBlogNav();
  const blog = getBlogForCode(code);
  const text = label ?? (code ?? "-");
  if (!blog) return <span className={className}>{text}</span>;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        openBlog(blog.id);
      }}
      title={`Open strategy blog — ${blog.title}`}
      className={`inline-flex items-center gap-1 rounded underline decoration-dotted decoration-white/30 underline-offset-2 transition hover:decoration-solid hover:text-[#f2c873] ${className ?? ""}`}
    >
      {showIcon ? <BookOpen className="size-3 opacity-70" /> : null}
      {text}
    </button>
  );
}
