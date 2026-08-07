import { createSignal, onMount } from "solid-js";
import helpMarkdown from "../../../HELP.md?raw";

function simpleMarkdownToHtml(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("### ")) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h3 class="text-lg font-bold text-surface-900 mt-6 mb-2">${escapeHtml(line.slice(4))}</h3>`;
    } else if (line.startsWith("## ")) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h2 class="text-xl font-bold text-surface-900 mt-8 mb-3 pb-1 border-b border-surface-200">${escapeHtml(line.slice(3))}</h2>`;
    } else if (line.startsWith("# ")) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<h1 class="text-2xl font-bold text-surface-900 mb-6">${escapeHtml(line.slice(2))}</h1>`;
    } else if (line.startsWith("> ")) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<blockquote class="pl-4 border-l-4 border-primary-300 text-surface-600 my-3">${escapeHtml(line.slice(2))}</blockquote>`;
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      if (!inList) {
        html += '<ul class="list-disc pl-6 space-y-1 text-surface-700 my-3">';
        inList = true;
      }
      html += `<li>${inlineFormatting(line.slice(2))}</li>`;
    } else if (line.startsWith("```")) {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      // Skip code block markers for simplicity.
      continue;
    } else if (line === "") {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += "<div class=\"h-3\"></div>";
    } else {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      html += `<p class="text-surface-700 leading-relaxed my-2">${inlineFormatting(line)}</p>`;
    }
  }

  if (inList) {
    html += "</ul>";
  }
  return html;
}

function inlineFormatting(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code class=\"px-1 py-0.5 bg-surface-100 rounded text-sm\">$1</code>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export default function Help() {
  const [html, setHtml] = createSignal("");

  onMount(() => {
    setHtml(simpleMarkdownToHtml(helpMarkdown));
  });

  return (
    <div class="p-6 max-w-3xl mx-auto">
      <div class="bg-white rounded-2xl shadow-sm border border-surface-200 p-8">
        <div innerHTML={html()} />
      </div>
    </div>
  );
}
