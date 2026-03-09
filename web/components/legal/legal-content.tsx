/**
 * Simple legal document renderer.
 * Takes raw markdown-ish content and renders it as styled HTML.
 * We don't need a full markdown parser — just convert the heading/paragraph
 * patterns used in the legal docs into proper semantic HTML.
 */

interface LegalContentProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}

export function LegalContent({ title, lastUpdated, children }: LegalContentProps) {
  return (
    <article className="prose prose-slate dark:prose-invert max-w-none prose-headings:scroll-mt-20">
      <div className="mb-10">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">{title}</h1>
        <p className="text-sm text-gray-400 dark:text-gray-500">Last Updated: {lastUpdated}</p>
      </div>
      <div className="[&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-gray-900 dark:[&_h2]:text-white [&_h2]:mt-10 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:border-gray-200 dark:[&_h2]:border-white/10 [&_h2]:pb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-gray-800 dark:[&_h3]:text-gray-200 [&_h3]:mt-6 [&_h3]:mb-3 [&_p]:text-gray-600 dark:[&_p]:text-gray-400 [&_p]:leading-relaxed [&_p]:mb-4 [&_strong]:text-gray-900 dark:[&_strong]:text-white [&_table]:text-sm [&_th]:text-left [&_th]:p-3 [&_th]:bg-gray-100 dark:[&_th]:bg-white/5 [&_td]:p-3 [&_td]:border-t [&_td]:border-gray-100 dark:[&_td]:border-white/5">
        {children}
      </div>
    </article>
  );
}
