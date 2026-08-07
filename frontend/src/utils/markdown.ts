function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function inlineFormatting(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, '<code class="px-1 py-0.5 bg-surface-100 rounded text-sm font-mono text-primary-700">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-primary-600 hover:underline">$1</a>');
}

function isOrderedListItem(line: string): { index: number; content: string } | null {
  const match = line.match(/^(\d+)\.\s+(.*)$/);
  if (!match) return null;
  return { index: parseInt(match[1], 10), content: match[2] };
}

export function simpleMarkdownToHtml(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inUnorderedList = false;
  let inOrderedList = false;

  const closeLists = () => {
    if (inUnorderedList) {
      html += "</ul>";
      inUnorderedList = false;
    }
    if (inOrderedList) {
      html += "</ol>";
      inOrderedList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.startsWith("### ")) {
      closeLists();
      html += `<h3 class="text-lg font-bold text-surface-900 mt-6 mb-2 flex items-center gap-2"><span class="inline-block h-1.5 w-1.5 rounded-full bg-primary-500"></span>${escapeHtml(line.slice(4))}</h3>`;
    } else if (line.startsWith("## ")) {
      closeLists();
      html += `<h2 class="text-xl font-bold text-surface-900 mt-8 mb-3 pb-2 border-b border-surface-200">${escapeHtml(line.slice(3))}</h2>`;
    } else if (line.startsWith("# ")) {
      closeLists();
      html += `<h1 class="text-2xl font-bold text-surface-900 mb-6">${escapeHtml(line.slice(2))}</h1>`;
    } else if (line.startsWith("> ")) {
      closeLists();
      html += `<blockquote class="my-3 rounded-r-lg border-l-4 border-primary-300 bg-primary-50/50 py-2 pl-4 pr-3 text-surface-600 italic">${inlineFormatting(line.slice(2))}</blockquote>`;
    } else if (line.startsWith("---")) {
      closeLists();
      html += '<hr class="my-6 border-surface-200" />';
    } else if (line.startsWith("```")) {
      closeLists();
      continue;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (inOrderedList) {
        html += "</ol>";
        inOrderedList = false;
      }
      if (!inUnorderedList) {
        html += '<ul class="list-disc pl-6 space-y-1.5 text-surface-700 my-3">';
        inUnorderedList = true;
      }
      html += `<li>${inlineFormatting(line.slice(2))}</li>`;
    } else {
      const ordered = isOrderedListItem(line);
      if (ordered) {
        if (inUnorderedList) {
          html += "</ul>";
          inUnorderedList = false;
        }
        if (!inOrderedList) {
          html += '<ol class="list-decimal pl-6 space-y-1.5 text-surface-700 my-3">';
          inOrderedList = true;
        }
        html += `<li>${inlineFormatting(ordered.content)}</li>`;
      } else if (line === "") {
        closeLists();
        html += '<div class="h-2"></div>';
      } else {
        closeLists();
        html += `<p class="text-surface-700 leading-relaxed my-2">${inlineFormatting(line)}</p>`;
      }
    }
  }

  closeLists();
  return html;
}
